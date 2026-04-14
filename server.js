require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { put: blobPut } = require('@vercel/blob');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(cookieParser(process.env.SESSION_SECRET || 'fallback-secret-change-me'));

// ── Auth middleware — protects all /api routes except login + check ──
app.use((req, res, next) => {
  const open = ['/api/login', '/api/auth/check', '/api/auth/callback', '/api/auth/jobber'];
  if (!req.path.startsWith('/api/') || open.includes(req.path)) return next();
  const session = req.signedCookies?.rf_session;
  if (session) return next();
  return res.status(401).json({ error: 'Not authenticated', code: 'NOT_AUTHENTICATED' });
});

// ── Login ──
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  // Support up to 3 users via env vars
  const users = [
    { u: process.env.AUTH_USER,   p: process.env.AUTH_PASS   },
    { u: process.env.AUTH_USER_2, p: process.env.AUTH_PASS_2 },
    { u: process.env.AUTH_USER_3, p: process.env.AUTH_PASS_3 },
  ].filter(x => x.u && x.p);

  const match = users.find(x => x.u === username && x.p === password);
  if (!match) return res.status(401).json({ error: 'Invalid username or password.' });

  res.cookie('rf_session', username, {
    signed: true,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  });
  res.json({ success: true, username });
});

// ── Logout ──
app.post('/api/logout', (req, res) => {
  res.clearCookie('rf_session');
  res.json({ success: true });
});

// ── Auth check ──
app.get('/api/auth/check', (req, res) => {
  const session = req.signedCookies?.rf_session;
  if (session) return res.json({ authenticated: true, username: session });
  return res.status(401).json({ authenticated: false });
});

// Store uploads in memory (base64) — no disk writes needed
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB — Vercel serverless hard limit is 4.5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only JPG, PNG, WEBP, GIF and PDF files are allowed'));
  }
});


// ── Parse structured fields from LlamaParse HTML+markdown output ──
// Works with any receipt layout — Gescan, Home Depot, AI-generated, etc.
function extractFieldsFromLlama(content) {
  let vendor = null, invoiceNo = null, date = null, jobNo = null, total = null;
  const items = [];

  // ── Helper: parse all tables (HTML + markdown pipe) into [table][row][col] ──
  function parseTables(content) {
    const tbls = [];

    // 1. HTML <table> blocks
    for (const [tableHtml] of content.matchAll(/<table[\s\S]*?<\/table>/gi)) {
      const rows = [];
      for (const [rowHtml] of tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
        const cells = [];
        for (const [, inner] of rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
          const text = inner
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ').trim();
          cells.push(text);
        }
        if (cells.some(c => c.length > 0)) rows.push(cells);
      }
      if (rows.length) tbls.push(rows);
    }

    // 2. Markdown pipe tables  e.g.  | A | B | C |
    //    LlamaParse renders some footer/totals tables this way instead of as HTML.
    //    Group consecutive pipe-table lines into blocks, skip alignment rows (| :--- |).
    const htmlZapped = content.replace(/<table[\s\S]*?<\/table>/gi, ''); // avoid double-counting
    const pipeLines = htmlZapped.split('\n');
    let mdBlock = [];
    const flushMdBlock = () => {
      if (mdBlock.length >= 2) tbls.push(mdBlock);
      mdBlock = [];
    };
    for (const line of pipeLines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('|')) { flushMdBlock(); continue; }
      // Skip alignment rows like | :--- | :--: | ---: |
      if (/^\|[\s|:-]+\|$/.test(trimmed)) continue;
      const cells = trimmed.replace(/^\||\|$/g, '').split('|')
        .map(c => c.trim())
        .filter((_, i, arr) => i < arr.length); // keep all including empty
      if (cells.some(c => c.length > 0)) mdBlock.push(cells);
    }
    flushMdBlock();

    return tbls;
  }

  // ── Helper: normalise a date string → YYYY-MM-DD ──
  function parseDate(str) {
    if (!str) return null;
    // Already ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    // MM/DD/YYYY or DD/MM/YYYY
    let m = str.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
    // YYYY/MM/DD
    m = str.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    return null;
  }

  const tables = parseTables(content);

  // ── 1. Build a flat label→value map from EVERY table ──
  // Handles both Gescan-style (label row / value row) and
  // side-by-side style (label cell | value cell in same row)
  const lmap = {};

  for (const table of tables) {
    for (let r = 0; r < table.length; r++) {
      const row = table[r];

      // Style A: label row + value row (alternate rows pattern)
      if (r + 1 < table.length) {
        const vRow = table[r + 1];
        const isLabelRow =
          row.some(c => /^[A-Z][A-Z\s./()#-]{2,}$/.test(c)) &&          // has label-like text
          !row.some(c => /^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(c)) &&   // no dates
          !row.some(c => /^\d+\.\d{2}$/.test(c));                         // no prices
        const isValueRow =
          vRow.some(c => c.length > 0) &&
          !vRow.every(c => /^[A-Z][A-Z\s./()#-]{2,}$/.test(c) || c === ''); // not all labels

        if (isLabelRow && isValueRow) {
          for (let c = 0; c < row.length; c++) {
            const lbl = row[c].toUpperCase().replace(/\s+/g,' ').trim();
            const val = (vRow[c] || '').trim();
            if (lbl.length > 1 && val && !/^[A-Z][A-Z\s./()#-]{4,}$/.test(val))
              lmap[lbl] = val;
          }
        }
      }

      // Style B: side-by-side — "Label" | "Value" in same row
      // Skip pure header rows (all cells are label-like) — those belong to Style A only,
      // and running Style B on them causes header cells to overwrite real values
      // e.g. [ORDER DATE, ORDER NO, PAGE] would set lmap['ORDER NO'] = 'PAGE'
      const rowIsAllLabels = row.every(c => c === '' || /^[A-Z][A-Z\s./()#-]{2,}$/.test(c));
      if (!rowIsAllLabels) {
        for (let c = 0; c + 1 < row.length; c++) {
          const lbl = row[c].replace(/:$/, '').toUpperCase().replace(/\s+/g,' ').trim();
          const val = row[c + 1].trim();
          if (/^[A-Z][A-Z\s./()#-]{2,}$/.test(lbl) && val &&
              !/^[A-Z][A-Z\s./()#-]{4,}$/.test(val) && val !== lbl) {
            lmap[lbl] = val;
            c++; // consumed the value cell
          }
        }
      }
    }
  }

  // Also scan plain text outside tables for "Label: Value" on same line
  const plainText = content.replace(/<table[\s\S]*?<\/table>/gi, '');
  for (const [, lbl, val] of plainText.matchAll(/^([A-Z][A-Za-z\s./()#-]{2,}?)\s*:\s*(.+)$/gm)) {
    const k = lbl.toUpperCase().replace(/\s+/g,' ').trim();
    if (k && val.trim()) lmap[k] = val.trim();
  }

  console.log('[fields] label map:', JSON.stringify(lmap));

  // ── 2. Extract key fields from label map ──

  // Vendor: H1/H2 heading first (e.g. "# GESCAN"), then bold text, then label map
  // Avoid capturing section headers like "INVOICE" or "RETURN MERCHANDISE" as vendor —
  // skip any heading that is a known doc-type keyword
  const DOC_KEYWORDS = /^(invoice|receipt|packing\s*slip|counter\s*sale|return|original|copy|statement|order|quote|estimate|bill)/i;
  const headingMatch = [...content.matchAll(/^#{1,2}\s+([A-Za-z][A-Za-z0-9\s&.,'()-]+?)$/gm)]
    .map(m => m[1].trim())
    .find(h => !DOC_KEYWORDS.test(h));
  const boldMatch = content.match(/\*\*([A-Za-z][A-Za-z\s&.-]+?)\*\*/);
  vendor = headingMatch ||
    (boldMatch?.[1]?.trim() && !DOC_KEYWORDS.test(boldMatch[1]) ? boldMatch[1].trim() : null) ||
    lmap['VENDOR'] || lmap['SUPPLIER'] || lmap['COMPANY'] ||
    lmap['SOLD BY'] || lmap['BILLED BY'] || null;

  // Invoice / order number
  invoiceNo =
    lmap['ORDER NO'] || lmap['INVOICE NO'] || lmap['INVOICE NUMBER'] ||
    lmap['INVOICE #'] || lmap['ORDER NUMBER'] || lmap['DOCUMENT NO'] ||
    lmap['RECEIPT NO'] || lmap['RECEIPT NUMBER'] || lmap['TRANSACTION NO'] || null;

  // Date — prefer INVOICE DATE over ORDER DATE (order date may differ by a day)
  const rawDate =
    lmap['INVOICE DATE'] || lmap['DATE'] || lmap['TRANSACTION DATE'] ||
    lmap['BILL DATE'] || lmap['SALE DATE'] || lmap['RECEIPT DATE'] ||
    lmap['ISSUED'] || lmap['ORDER DATE'] || null;
  date = parseDate(rawDate);
  if (!date) {
    const anyDate = content.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})\b/);
    if (anyDate) date = parseDate(anyDate[1]);
  }

  // Job / PO number — only accept 3–7 plain digits
  const JOB_LABELS = [
    'YOUR P.O. NO', 'YOUR P.O.NO', 'P.O. NO', 'P.O.NO', 'PO NO', 'PO #',
    'PURCHASE ORDER', 'PURCHASE ORDER NO', 'CUSTOMER PO', 'CUST PO',
    'JOB NO', 'JOB #', 'JOB NUMBER', 'JOB ID',
    'WORK ORDER', 'WORK ORDER NO', 'WO #', 'W.O. NO',
    'YOUR REF', 'YOUR REFERENCE', 'CUSTOMER REF', 'REF NO',
  ];
  for (const lbl of JOB_LABELS) {
    const val = (lmap[lbl] || '').trim();
    if (!val) continue;
    // Exact digits: "1178", "12345"
    let m = val.match(/^(\d{3,7})$/);
    if (m) { jobNo = m[1]; break; }
    // Digits with suffix: "1391-RETURN", "1178-A", "1178 REV"
    m = val.match(/^(\d{3,7})[-\s]/);
    if (m) { jobNo = m[1]; break; }
  }

  // ── 3. Find line items table — scan ALL tables for one with a TOTAL column ──
  let itemsTable = null, totalCol = -1;
  // Scan ALL rows (not just first 3) — Gescan PDFs embed the items header
  // rows deep inside a merged table that starts with REFERENCE/GST rows.
  let itemsHeaderRow = 0;
  for (const table of tables) {
    for (let r = 0; r < table.length; r++) {
      const upper = table[r].map(c => c.toUpperCase().trim());
      const tc = upper.findIndex(c => c === 'TOTAL' || c === 'AMOUNT' || c === 'EXT. PRICE' || c === 'EXT PRICE');
      const hasDesc = upper.some(c => c.includes('DESCRIPTION') || c.includes('PRODUCT') || c.includes('ITEM') || c.includes('SERVICE'));
      const hasPrice = upper.some(c => c.includes('PRICE') || c === 'RATE' || c === 'AMOUNT');
      if (tc >= 0 && (hasDesc || hasPrice)) {
        itemsTable = table; totalCol = tc; itemsHeaderRow = r;
        break;
      }
    }
    if (itemsTable) break;
  }

  // ── 4. Parse line items + compute total ──
  let itemsSum = 0;
  let lastDesc = ''; // carry forward description for multi-row item formats

  if (itemsTable && totalCol >= 0) {
    for (let ri = itemsHeaderRow + 1; ri < itemsTable.length; ri++) {
      const row = itemsTable[ri];
      // Numeric parser: strip $, commas, and trailing sign (e.g. "721.35 -" for returns)
      const parseNum = (cell) => {
        const s = (cell || '').replace(/[$,]/g, '').replace(/\s*[-+]\s*$/, '').trim();
        const n = parseFloat(s);
        return (!isNaN(n) && n > 0) ? n : null;
      };

      // Collect all positive numeric values from the row
      const nums = row.map(parseNum).filter(n => n !== null);

      // Even if this row has no numbers (pure description row), capture the description
      // so the NEXT row (which has prices but no desc) can inherit it.
      // Gescan invoices split: row N = "line# | desc", row N+1 = "| qty | price | total"
      if (nums.length === 0) {
        for (const cell of row) {
          const cleaned = cell.replace(/\*\*\d+\*\*\s*/g, '') // strip **1** line markers
                              .replace(/\s+\d+$/, '').trim();
          const isHeader = /^(LINE|QTY|PRODUCT|DESCRIPTION|PRICE|TOTAL|AMOUNT|UNIT|U\/M|DISCOUNT|SHIPPED|ORDERED|BACKORDERED|UPC|LIST|REFERENCE|REFERENCE|REP|C\.O\.D|TAKEN BY|ORIGINAL INVOICE|SEE NOTES)/i.test(cleaned);
          if (!isHeader && cleaned.length > 4 && cleaned.length > lastDesc.length) lastDesc = cleaned;
        }
        continue;
      }

      const isFee = row.some(c => /\bfee\b|surcharge|eco|levy/i.test(c));

      if (isFee) {
        const feeTotal = nums[nums.length - 1];
        const feeLabel = row.find(c => /\bfee\b|surcharge|eco|levy/i.test(c)) || 'Fee';
        items.push({ lineNo: '', desc: feeLabel, qty: null, unit: null, total: feeTotal });
        itemsSum += feeTotal;
        continue;
      }

      // Regular item row — last price is the line total, second-to-last is net price
      const lineTotal = nums[nums.length - 1];
      const netPrice  = nums.length >= 2 ? nums[nums.length - 2] : null;
      const lineNo    = row[0] || '';

      // Description: longest text cell that isn't a number or unit-of-measure
      // Also treat "VALUE -" style cells (trailing sign) as numeric, not text
      let desc = '';
      for (const cell of row) {
        const cleaned = cell.replace(/\s+\d+$/, '').replace(/\s*[-+]\s*$/, '').trim();
        const isNumeric = /^\$?[\d,.]+$/.test(cleaned) || cleaned.length === 0 ||
                          /^(EA|EACH|PC|PCS|PR|FT|M|LB|KG|BOX|PKG|SET|LOT|RL|CTN)$/i.test(cleaned);
        if (!isNumeric && cleaned.length > desc.length) desc = cleaned;
      }

      // If this row has no description but looks like the price row of a multi-row item,
      // reuse the last description we saw (e.g. Gescan invoice splits desc/prices across rows)
      if (!desc && lastDesc) desc = lastDesc;
      if (desc) lastDesc = desc;

      // Qty: last standalone integer in the row (≤4 digits)
      let qty = null;
      for (let c = row.length - 1; c >= 1; c--) {
        const m = (row[c] || '').match(/(\d{1,4})$/);
        if (m) {
          const n = parseInt(m[1]);
          if (n > 0 && n < 10000 && n !== Math.round(lineTotal)) { qty = n; break; }
        }
      }

      if (lineTotal > 0 && desc.length > 1) {
        items.push({ lineNo, desc, qty, unit: netPrice, total: lineTotal });
        itemsSum += lineTotal;
      }
    }
  }

  // ── 5. Total fallback — label map → text scan → items sum ──
  if (total === null) {
    const rawTotal =
      lmap['TOTAL'] || lmap['GRAND TOTAL'] || lmap['INVOICE TOTAL'] ||
      lmap['AMOUNT DUE'] || lmap['BALANCE DUE'] || lmap['TOTAL DUE'] ||
      lmap['SUBTOTAL'] || null;
    if (rawTotal) {
      // Strip trailing sign (e.g. "721.35 -" on return invoices)
      const n = parseFloat(rawTotal.replace(/[$,]/g, '').replace(/\s*[-+]\s*$/, ''));
      if (!isNaN(n) && n > 0) total = n;
    }
  }
  if (total === null) {
    const tm = content.match(/\bTOTAL\b[\s:$]*(\d[\d,]*\.\d{2})/i);
    if (tm) total = parseFloat(tm[1].replace(/,/g,''));
  }
  // Last resort: sum what we parsed from line items
  if (total === null && itemsSum > 0) {
    total = Math.round(itemsSum * 100) / 100;
  }

  console.log('[fields] extracted:', { vendor, invoiceNo, date, jobNo, total, itemCount: items.length });
  return { vendor, invoiceNo, date, jobNo, total, items };
}

// ── Gemini helper — sends image or PDF to Gemini 2.0 Flash, returns HTML+markdown ──
async function parseWithGemini(fileBuffer, mimeType, filename) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');

  const base64Data = fileBuffer.toString('base64');

  const prompt = `You are a receipt and invoice parser. Extract ALL content from this document.

Formatting rules (follow exactly):
- Output the vendor/company name as a # H1 heading (e.g. "# GESCAN")
- Output every table as an HTML <table> with <tr><th> for header rows and <tr><td> for data cells
- Preserve every value exactly as printed — do not round numbers, reformat dates, or paraphrase
- Include ALL rows: header rows, sub-header rows, data rows, totals rows
- Output plain text (addresses, notes) as-is between tables
- Do not add commentary, explanations, or markdown code fences`;

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        { text: prompt }
      ]
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 8192 }
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${err.substring(0, 300)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Gemini returned empty response');

  console.log('[gemini] output preview:', text.substring(0, 300));
  return text;
}

app.post('/api/extract', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;

    console.log('[extract] mimetype:', mimeType, '| size:', fileBuffer.length, '| file:', req.file.originalname);

    // ── Gemini — convert image or PDF to structured markdown+HTML text ──
    const geminiOutput = await parseWithGemini(
      fileBuffer, mimeType, req.file.originalname || 'receipt'
    );
    console.log('[extract] Gemini output preview:', geminiOutput.substring(0, 500));

    // Image preview data URL (only for images — shown beside the output on review page)
    const imageDataUrl = mimeType !== 'application/pdf'
      ? `data:${mimeType};base64,${fileBuffer.toString('base64')}`
      : null;

    // Upload to Vercel Blob so the receipt URL can be attached to a Jobber expense later
    let receiptBlobUrl = null;
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        const ext = mimeType === 'application/pdf' ? 'pdf' : (mimeType.split('/')[1] || 'jpg');
        const safeName = `receipt_${Date.now()}`;
        const blobResult = await blobPut(`receipts/${safeName}.${ext}`, fileBuffer, {
          access: 'public',
          contentType: mimeType,
          token: process.env.BLOB_READ_WRITE_TOKEN
        });
        receiptBlobUrl = blobResult.url;
        console.log('[extract] uploaded to Vercel Blob:', receiptBlobUrl);
      } catch (blobErr) {
        console.error('[extract] Blob upload failed:', blobErr.message);
      }
    }

    // Parse structured fields from Gemini HTML+markdown output
    const fields = extractFieldsFromLlama(geminiOutput);

    res.json({
      success: true,
      data: {
        markdown: geminiOutput,
        imageDataUrl,
        receiptBlobUrl,
        isPdf: mimeType === 'application/pdf',
        vendor:    fields.vendor    || null,
        invoiceNo: fields.invoiceNo || null,
        date:      fields.date      || null,
        total:     fields.total     || null,
        jobNo:     fields.jobNo     || null,
        jobStatus: fields.jobNo ? 'found' : 'missing',
        items:     fields.items    || [],
      }
    });

  } catch (err) {
    console.error('Extraction error:', err);

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 4MB.' });
    }
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: 'gemini-2.0-flash' });
});

// ── Upstash Redis helpers (no extra package — pure fetch) ──
async function redisGet(key) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return null;
  const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const data = await r.json();
  return data.result || null;
}

async function redisSet(key, value, exSeconds) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  let url = `${process.env.UPSTASH_REDIS_REST_URL}/set/${key}/${encodeURIComponent(value)}`;
  if (exSeconds) url += `/ex/${exSeconds}`;
  await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
}

// ── Jobber token management ──
async function getJobberToken() {
  let token = await redisGet('jobber_access_token');
  if (token) return token;

  const refreshToken = await redisGet('jobber_refresh_token');
  if (!refreshToken) throw new Error('NOT_CONNECTED');

  const res = await fetch('https://api.getjobber.com/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.JOBBER_CLIENT_ID,
      client_secret: process.env.JOBBER_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const tokens = await res.json();
  if (!tokens.access_token) throw new Error('TOKEN_REFRESH_FAILED');

  await redisSet('jobber_access_token', tokens.access_token, 82800); // 23h TTL
  if (tokens.refresh_token) await redisSet('jobber_refresh_token', tokens.refresh_token);
  return tokens.access_token;
}

// ── Jobber GraphQL helper ──
async function jobberGQL(query, variables = {}) {
  const token = await getJobberToken();
  const res = await fetch('https://api.getjobber.com/api/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': '2026-03-10'
    },
    body: JSON.stringify({ query, variables })
  });
  return res.json();
}

// ── Get Jobber ActiveStorage presigned URL (browser uploads file directly to S3) ──
app.post('/api/active-storage-token', async (req, res) => {
  try {
    const { filename, contentType, byteSize, checksum } = req.body;
    const token = await getJobberToken();

    const initRes = await fetch('https://api.getjobber.com/rails/active_storage/direct_uploads', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob: { filename, content_type: contentType, byte_size: byteSize, checksum } })
    });

    if (!initRes.ok) {
      const text = await initRes.text();
      return res.status(initRes.status).json({ error: `Jobber ActiveStorage: ${text.substring(0, 200)}` });
    }

    const data = await initRes.json();
    res.json({
      signedBlobId: data.signed_id,
      uploadUrl: data.direct_upload?.url,
      uploadHeaders: data.direct_upload?.headers || {}
    });
  } catch (err) {
    if (err.message === 'NOT_CONNECTED') return res.status(401).json({ error: 'Not connected to Jobber.' });
    res.status(500).json({ error: err.message });
  }
});

// ── Jobber auth routes ──
app.get('/api/auth/jobber', (req, res) => {
  const appUrl = (process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (!appUrl) return res.status(500).send('APP_URL environment variable not set');
  const url = new URL('https://api.getjobber.com/api/oauth/authorize');
  url.searchParams.set('client_id', process.env.JOBBER_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${appUrl}/api/auth/callback`);
  url.searchParams.set('response_type', 'code');
  res.redirect(url.toString());
});

app.get('/api/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');
  try {
    const tokenRes = await fetch('https://api.getjobber.com/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.JOBBER_CLIENT_ID,
        client_secret: process.env.JOBBER_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${(process.env.APP_URL || '').trim().replace(/\/$/, '')}/api/auth/callback`
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      return res.status(400).send('Failed to get token: ' + JSON.stringify(tokens));
    }
    await redisSet('jobber_access_token', tokens.access_token, 82800);
    await redisSet('jobber_refresh_token', tokens.refresh_token);
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Connected!</title></head>
      <body style="font-family:system-ui;text-align:center;padding:60px;background:#F7F8FA;">
        <div style="background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:40px;max-width:400px;margin:0 auto;">
          <div style="color:#059669;font-size:48px;margin-bottom:16px;">&#10003;</div>
          <h2 style="margin:0 0 8px;color:#111827;">Connected to Jobber!</h2>
          <p style="color:#6B7280;margin:0 0 24px;">ReceiptFlow can now create expenses in your Jobber account.</p>
          <a href="/" style="background:#B8620A;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Return to ReceiptFlow</a>
        </div>
      </body></html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/api/auth/status', async (req, res) => {
  try {
    const token = await redisGet('jobber_access_token');
    const refresh = await redisGet('jobber_refresh_token');
    res.json({ connected: !!(token || refresh) });
  } catch {
    res.json({ connected: false });
  }
});

// ── Debug: find upload-related mutations in Jobber schema ──
app.get('/api/debug/upload-mutations', async (req, res) => {
  try {
    const result = await jobberGQL(`{
      __type(name: "Mutation") {
        fields { name }
      }
    }`);
    const all = result.data?.__type?.fields?.map(f => f.name) || [];
    const upload = all.filter(n => /upload|file|blob|attach|receipt/i.test(n));
    res.json({ uploadRelated: upload, all });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Debug: introspect upload input types by finding real type names from mutation args ──
app.get('/api/debug/upload-inputs', async (req, res) => {
  try {
    // Step 1: get the Mutation type fields to find the actual arg type names
    const mutResult = await jobberGQL(`{
      __type(name: "Mutation") {
        fields {
          name
          args { name type { name kind ofType { name kind ofType { name kind } } } }
        }
      }
    }`);

    const allFields = mutResult.data?.__type?.fields || [];
    const targets = ['supplierInvoiceUpload', 'jobNoteAddAttachment', 'clientNoteAddAttachment'];
    const relevant = allFields.filter(f => targets.includes(f.name));

    // Step 2: extract input type names from args (unwrap NON_NULL wrappers)
    const inputTypeNames = new Set();
    for (const field of relevant) {
      for (const arg of field.args || []) {
        let t = arg.type;
        while (t?.ofType) t = t.ofType;
        if (t?.name) inputTypeNames.add(t.name);
      }
    }

    // Step 3: introspect each discovered input type
    const schemas = {};
    await Promise.all([...inputTypeNames].map(async (name) => {
      const r = await jobberGQL(`{ __type(name: "${name}") { inputFields { name description type { name kind ofType { name kind } } } } }`);
      schemas[name] = r.data?.__type?.inputFields || null;
    }));

    res.json({ mutationSignatures: relevant, inputTypeNames: [...inputTypeNames], schemas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Debug: introspect ExpenseCreateInput fields ──
app.get('/api/debug/expense-schema', async (req, res) => {
  try {
    const result = await jobberGQL(`{
      __type(name: "ExpenseCreateInput") {
        inputFields {
          name
          description
          type { name kind ofType { name kind ofType { name kind } } }
        }
      }
    }`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Debug: full receipt upload pipeline test ──
// Tests ActiveStorage init on all known hosts, shows raw responses,
// and introspects what receipt fields ExpenseCreateInput accepts.
app.get('/api/debug/receipt-pipeline', async (req, res) => {
  const results = {};
  try {
    const token = await getJobberToken();

    // Step 1: What does ExpenseCreateInput accept for receipts?
    const schemaResult = await jobberGQL(`{
      __type(name: "ExpenseCreateInput") {
        inputFields {
          name
          description
          type { name kind ofType { name kind ofType { name kind } } }
        }
      }
    }`);
    const allFields = schemaResult.data?.__type?.inputFields || [];
    results.expenseInputFields = allFields.map(f => ({
      name: f.name,
      description: f.description,
      type: f.type
    }));
    results.receiptRelatedFields = allFields
      .filter(f => /receipt|blob|file|attach|image|photo|url/i.test(f.name + ' ' + (f.description || '')))
      .map(f => ({ name: f.name, description: f.description }));

    // Step 2: Test ActiveStorage init on each known host with a tiny 1x1 white JPEG
    const tiny1x1JpegBase64 =
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARC' +
      'AABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';
    const tinyBuf = Buffer.from(tiny1x1JpegBase64, 'base64');
    const checksum = require('crypto').createHash('md5').update(tinyBuf).digest('base64');
    const blobPayload = JSON.stringify({
      blob: { filename: 'test.jpg', content_type: 'image/jpeg', byte_size: tinyBuf.length, checksum }
    });

    results.activeStorageTests = {};
    for (const host of ['https://api.getjobber.com', 'https://app.getjobber.com']) {
      try {
        const r = await fetch(`${host}/rails/active_storage/direct_uploads`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: blobPayload
        });
        const body = await r.text();
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        results.activeStorageTests[host] = {
          status: r.status,
          ok: r.ok,
          bodyRaw: body.substring(0, 400),
          parsed,
          responseHeaders: Object.fromEntries(r.headers.entries())
        };
      } catch (fetchErr) {
        results.activeStorageTests[host] = { error: fetchErr.message, stack: fetchErr.stack?.split('\n').slice(0,4) };
      }
    }

    // Step 3: If ActiveStorage succeeded, show the shape of the response
    const successHost = Object.entries(results.activeStorageTests).find(([, v]) => v.ok);
    if (successHost) {
      results.activeStorageSucceeded = true;
      results.note = 'ActiveStorage init worked — signed_id and direct_upload.url are available. S3 PUT can proceed.';
    } else {
      results.activeStorageSucceeded = false;
      results.note = 'ActiveStorage init failed on all hosts. Need to find another way to attach receipt.';
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message, partial: results });
  }
});


// ── Debug: see raw Jobber job lookup response ──
app.get('/api/debug/jobber/:jobNo', async (req, res) => {
  try {
    const num = parseInt(req.params.jobNo);

    // Introspect available filter fields
    const introspection = await jobberGQL(`{
      __type(name: "JobFilterAttributes") {
        inputFields { name type { name kind ofType { name kind } } }
      }
    }`);

    // Search with larger result set
    const bySearch = await jobberGQL(`
      query { jobs(first: 100, searchTerm: "${num}") { nodes { id jobNumber title } } }
    `);

    res.json({
      availableFilters: introspection.data?.__type?.inputFields?.map(f => f.name),
      bySearch: bySearch.data?.jobs?.nodes,
      exactMatch: bySearch.data?.jobs?.nodes?.find(j => j.jobNumber === num) || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Create Jobber expense ──
app.post('/api/create-expense', async (req, res) => {
  try {
    const { vendor, invoiceNo, date, total, jobNo, receiptBlobUrl } = req.body;

    if (!jobNo) {
      return res.status(400).json({ error: 'No job number found. Please enter one before posting to Jobber.' });
    }

    const num = parseInt(jobNo);
    if (isNaN(num)) {
      return res.status(400).json({ error: `"${jobNo}" is not a valid job number.` });
    }

    // Find job — search by number, then exact-match (handle both int and string jobNumber)
    const jobResult = await jobberGQL(`
      query {
        jobs(first: 100, searchTerm: "${num}") {
          nodes { id jobNumber title }
        }
      }
    `);

    console.log('Jobber job lookup response:', JSON.stringify(jobResult));

    // Detect auth/token errors from GraphQL error payload
    if (jobResult.errors?.length) {
      const gqlMsg = jobResult.errors[0].message || '';
      if (/unauthori|token|auth/i.test(gqlMsg)) {
        return res.status(401).json({ error: 'Jobber session expired. Go to Settings → Authorize Jobber to reconnect.' });
      }
      return res.status(400).json({ error: 'Jobber API error: ' + gqlMsg });
    }

    // Exact match — compare as numbers regardless of whether Jobber returns int or string
    const nodes = jobResult.data?.jobs?.nodes || [];
    const job = nodes.find(j => Number(j.jobNumber) === num);
    if (!job) {
      return res.status(404).json({
        error: `Job #${num} not found in Jobber. Check the job number and try again.`,
        debug: { searched: num, returned: nodes }
      });
    }

    // Receipt was already uploaded to Vercel Blob during /api/extract.
    // Just use the URL that was passed in — no re-upload needed.
    const receiptNote = receiptBlobUrl ? 'attached' : null;

    // Build expense title from whatever fields are present — no hardcoded placeholders.
    const titleParts = [vendor, invoiceNo ? `Invoice #${invoiceNo}` : null].filter(Boolean);
    const expenseTitle = titleParts.length ? titleParts.join(' — ') : 'Expense';

    // Parse total: use actual value; only fall back to 0 if Jobber's required field would be absent.
    const parsedTotal = parseFloat(total);
    const expenseTotal = isNaN(parsedTotal) ? 0 : parsedTotal;

    // Create expense on that job
    const expInput = {
      linkedJobId: job.id,
      title: expenseTitle,
      total: expenseTotal,
      date: (date || new Date().toISOString().split('T')[0]) + 'T00:00:00Z'
    };
    // Only include description if we actually have an invoice number
    if (invoiceNo) expInput.description = `Invoice #${invoiceNo}`;
    if (receiptBlobUrl) expInput.receiptUrl = receiptBlobUrl;

    const expResult = await jobberGQL(`
      mutation CreateExpense($input: ExpenseCreateInput!) {
        expenseCreate(input: $input) {
          expense { id title total }
          userErrors { message path }
        }
      }
    `, { input: expInput });

    console.log('Jobber expense create response:', JSON.stringify(expResult));

    const errors = expResult.data?.expenseCreate?.userErrors;
    if (errors?.length) return res.status(400).json({ error: errors[0].message, raw: expResult });

    const expense = expResult.data?.expenseCreate?.expense;

    // If expense is null with no userErrors, the mutation silently failed (likely a scope or input issue)
    if (!expense?.id) {
      return res.status(500).json({
        error: 'Jobber accepted the request but returned no expense. This usually means the "Expenses" write scope is not enabled on your Jobber app, or the mutation input is missing a required field.',
        raw: expResult
      });
    }

    res.json({ success: true, expenseId: expense.id, jobTitle: job.title, receiptNote });
  } catch (err) {
    if (err.message === 'NOT_CONNECTED') {
      return res.status(401).json({ error: 'Not connected to Jobber. Go to Settings to connect.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Export for Vercel serverless; also listen when run directly
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ReceiptFlow server running at http://localhost:${PORT}`);
  });
}
