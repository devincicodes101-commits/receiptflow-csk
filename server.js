require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { put: blobPut } = require('@vercel/blob');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

const EXTRACTION_PROMPT = `You are an invoice parser for CSK Electric, an electrical contractor based in Abbotsford, BC.

CRITICAL CONTEXT:
- CSK Electric is the CUSTOMER/BUYER — NOT the vendor. Do NOT use CSK Electric's address as the vendor address.
- The VENDOR is the supplier/seller (e.g. Gescan, Westburne, Home Depot, etc.)
- The vendor's address is the supplier's own address on their letterhead, NOT the "Sold To" or "Ship To" address.

════════════════════════════════════════
JOB NUMBER / PO FIELD — THREE STEPS
════════════════════════════════════════

STEP 1 — Find the label:
Search the entire document (header boxes, tables, grid layouts) for a field whose label is one of:
  "YOUR P.O. NO", "P.O. NO", "PO NO", "PO #", "PO NUMBER",
  "Purchase Order", "Customer PO", "Cust PO",
  "Job #", "Job No", "Job No.", "Job Number", "Job ID",
  "Work Order", "WO", "WO #", "W.O.", "W/O",
  "Your Ref", "Your Reference", "Customer Ref",
  "Reference No", "Ref No", "Ref #", "P/O", "P/O #"
If no such label exists on the document → poBox: null, poRawText: null. Stop here.

STEP 2 — Read the cell:
Look at the value cell directly next to or below that label.
Read exactly what is physically printed in that cell.
→ If the cell contains a number: proceed to step 3.
→ If the cell is blank, empty, or contains only spaces/dashes: poBox: null, poRawText: null. Stop here.
You MUST be able to quote the cell content verbatim. If you cannot, the cell is blank.

STEP 3 — Validate and return:
The value must be a plain number, 3–7 digits (e.g. 1178, 1249, 1095).
Set poBox = that number. Set poRawText = the exact text you read from the cell.

CRITICAL RULE: poRawText must always be filled when poBox is set.
If you set poBox but cannot quote what you read in poRawText, go back — the cell was blank.

NEVER use as a job number:
  ✗ CUSTOMER NO / Account No (e.g. 104625) — CSK Electric's supplier account number
  ✗ ORDER NO / Order ID (e.g. 17798703-00) — has dashes, 8+ digits
  ✗ INVOICE NO, DOCUMENT NO, TRANSACTION NO, WAYBILL NO
  ✗ Any number with 8 or more digits
  ✗ Any number with dashes
  ✗ Any number you are guessing or are not certain about

GESCAN DOCUMENTS — invoice number:
  Gescan packing slips and counter sales do not have a separate "Invoice No" field.
  Use the ORDER NO value (e.g. 17798703-00) as the invoiceNo.
  The ORDER NO is in the top-right header box under the label "ORDER NO".

GESCAN DOCUMENTS — header box layout:
  WITH job number:     | CUSTOMER NO | ORDER NO    | YOUR P.O. NO |
                       |   104625    | 17798703-00 |    1178      |  → poBox = "1178"

  WITHOUT job number:  | CUSTOMER NO | ORDER NO    | YOUR P.O. NO |
                       |   104625    | 17798703-00 |              |  → poBox = null

  The YOUR P.O. NO cell may be blank on many Gescan documents. A blank cell = null, always.
  CUSTOMER NO and ORDER NO are never job numbers regardless of what they contain.

POPULATE potentialJobFields:
List every header/reference field on the document with its label and value,
including YOUR P.O. NO (even if blank — show it as blank), ORDER NO, CUSTOMER NO.

INVOICE DATE:
- Prefer fields labelled "Invoice Date", "Date", "Invoice Date".
- If no Invoice Date label exists, fall back to "Order Date", "Transaction Date", or any other date present.
- For Gescan documents, the date column is labelled "ORDER DATE" — use that value.
- Return in YYYY-MM-DD format.

CREDIT / RETURN INVOICES:
- If marked "RETURN MERCHANDISE", "CREDIT", "CREDIT MEMO", or "DO NOT PAY" → isCredit: true
- All monetary amounts must be NEGATIVE for credits (e.g. -807.91)

LINE ITEMS:
- List distinct product/service lines only. No duplicates.
- Each line: product code + description, quantity, unit price, line total.
- Credit line totals are negative.
- Include fees and surcharges as separate lines.

TOTALS:
- subtotal = gross total before taxes
- tax = all taxes (GST, HST, PST, etc.)
- total = final amount due
- All negative for credit invoices.
- If the total section says "Continued" or is blank (multi-page receipt — totals on page 2):
  sum all visible line item totals to derive the subtotal. Set tax = null, total = that sum.
  Do NOT leave total as null if line items are present — always compute it from visible lines.

Return ONLY valid JSON, no markdown, no explanation:
{
  "vendor": "supplier company name",
  "address": "supplier's own address from their letterhead",
  "invoiceNo": "invoice or document number",
  "date": "YYYY-MM-DD",
  "poBox": "value from a matching PO field exactly as printed, or null",
  "poFieldLabel": "the exact label text printed on the document, or null if poBox is null",
  "poRawText": "the exact text you read from the PO value cell (verbatim), or null if poBox is null",
  "potentialJobFields": [{ "label": "field label as printed", "value": "value as printed" }],
  "isCredit": true or false,
  "items": [
    { "desc": "product code + description", "qty": number or null, "unit": unit price or null, "total": line total }
  ],
  "subtotal": number,
  "tax": number,
  "total": number,
  "confidence": "high" | "medium" | "low",
  "notes": "any observations"
}

If a field cannot be determined, use null. Never fabricate values.`;

// ── LlamaParse helper — uploads file, polls until done, returns markdown ──
async function parseWithLlamaParse(fileBuffer, mimeType, filename) {
  const LLAMA_KEY = process.env.LLAMA_CLOUD_API_KEY;
  if (!LLAMA_KEY) throw new Error('LLAMA_CLOUD_API_KEY not set');

  // Upload the file
  const form = new FormData();
  const blob = new Blob([fileBuffer], { type: mimeType });
  form.append('file', blob, filename || 'receipt');

  const uploadRes = await fetch('https://api.cloud.llamaindex.ai/api/parsing/upload', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LLAMA_KEY}` },
    body: form
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`LlamaParse upload failed: ${uploadRes.status} ${err.substring(0, 200)}`);
  }

  const { id: jobId } = await uploadRes.json();
  console.log('[llamaparse] job started:', jobId);

  // Poll every 1 second for up to 60 seconds
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));

    const statusRes = await fetch(
      `https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}`,
      { headers: { 'Authorization': `Bearer ${LLAMA_KEY}` } }
    );
    const statusData = await statusRes.json();
    console.log('[llamaparse] poll', i + 1, '— status:', statusData.status);

    if (statusData.status === 'SUCCESS') {
      const resultRes = await fetch(
        `https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}/result/markdown`,
        { headers: { 'Authorization': `Bearer ${LLAMA_KEY}` } }
      );
      const resultData = await resultRes.json();
      return resultData.markdown || '';
    }

    if (statusData.status === 'ERROR') {
      throw new Error(`LlamaParse processing error: ${JSON.stringify(statusData)}`);
    }
  }

  throw new Error('LlamaParse timeout — job did not complete in 60 seconds');
}

app.post('/api/extract', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;

    console.log('[extract] mimetype:', mimeType, '| size:', fileBuffer.length, '| file:', req.file.originalname);

    // ── Step 1: LlamaParse — convert image or PDF to clean markdown text ──
    // LlamaParse handles tables, grids, and multi-column layouts far better than
    // raw vision. The Gescan header box (CUSTOMER NO | ORDER NO | YOUR P.O. NO)
    // comes through as a proper markdown table, making extraction much more reliable.
    const llamaMarkdown = await parseWithLlamaParse(
      fileBuffer, mimeType, req.file.originalname || 'receipt'
    );
    console.log('[extract] LlamaParse markdown preview:', llamaMarkdown.substring(0, 400));

    // ── Step 2: GPT-4o text — extract structured JSON from the markdown ──
    // Text mode is faster, cheaper, and more accurate than vision on clean parsed text.
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: EXTRACTION_PROMPT + '\n\n---\nDocument text (parsed from receipt):\n\n' + llamaMarkdown
        }
      ],
      max_tokens: 2000,
      temperature: 0
    });
    const rawContent = response.choices[0].message.content.trim();

    // Strip markdown code fences if present
    let jsonStr = rawContent;
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    let extracted;
    try {
      extracted = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr);
      console.error('Raw response:', rawContent);
      return res.status(500).json({
        error: 'AI returned invalid JSON. Raw response: ' + rawContent.substring(0, 200)
      });
    }

    // ── Capture raw GPT extraction BEFORE any server filtering (for debug) ──
    const _rawGpt = {
      poBox:              extracted.poBox        ?? null,
      poFieldLabel:       extracted.poFieldLabel ?? null,
      poRawText:          extracted.poRawText    ?? null,
      potentialJobFields: extracted.potentialJobFields ?? [],
      notes:              extracted.notes        ?? null,
      confidence:         extracted.confidence   ?? null,
    };
    console.log('[extract] RAW GPT extraction:', JSON.stringify(_rawGpt));

    // ── Server-side PO validation ──
    const VALID_PO_LABELS = [
      'YOUR P.O. NO', 'YOUR P.O.NO', 'P.O. NO', 'P.O.NO', 'PO NO', 'PONO',
      'PO #', 'PO#', 'P.O. #', 'P.O.#', 'PURCHASE ORDER', 'CUSTOMER PO',
      'JOB', 'JOB #', 'JOB NO', 'JOB NO.', 'JOB NUMBER', 'JOB ID',
      'WORK ORDER', 'WORK ORDER #', 'WO', 'WO #', 'W.O.', 'W.O. #', 'W/O', 'W/O #',
      'YOUR REFERENCE', 'YOUR REF', 'YOUR REF NO', 'YOUR REF #',
      'CUSTOMER REF', 'CUSTOMER REFERENCE', 'CUST REF',
      'REFERENCE', 'REFERENCE NO', 'REF', 'REF NO', 'REF #', 'REF. NO',
      'CONTRACT NO', 'CONTRACT #', 'PROJECT NO', 'PROJECT #',
      'ACCOUNT REF', 'ACCT REF', 'ORDER REF', 'P/O', 'P/O #', 'P/O NO'
    ];
    const FORBIDDEN_VALUES = ['104625']; // CSK Electric's Gescan account — never a job number
    // Labels that are NEVER a PO/job field — if GPT cites one of these as the label, discard it
    const FORBIDDEN_LABELS = ['ORDER NO', 'ORDER NUMBER', 'CUSTOMER NO', 'CUSTOMER NUMBER',
      'ACCOUNT NO', 'ACCOUNT NUMBER', 'INVOICE NO', 'INVOICE NUMBER', 'DOCUMENT NO',
      'TRANSACTION NO', 'WAYBILL NO', 'TRACKING NO'];

    let _discardReason = null;

    if (extracted.poBox) {
      const normalize = s => s.toUpperCase().replace(/[.\s]+/g, ' ').trim();
      const labelUpper = normalize(extracted.poFieldLabel || '');
      const labelOk = VALID_PO_LABELS.some(v => labelUpper.includes(normalize(v)));
      const labelForbidden = FORBIDDEN_LABELS.some(v => labelUpper.includes(normalize(v)));
      const valueStr = String(extracted.poBox).trim();
      const valueForbidden = FORBIDDEN_VALUES.includes(valueStr);
      const digitsOnly = valueStr.replace(/[^0-9]/g, '');
      const tooLong = digitsOnly.length > 7;

      // Cross-check: if this value appears in potentialJobFields under a forbidden label,
      // GPT likely read it from the wrong cell (e.g. ORDER NO or CUSTOMER NO column)
      const potFields = extracted.potentialJobFields || [];
      const valueInForbiddenField = potFields.some(f => {
        const fLabel = normalize(f.label || '');
        const fValue = String(f.value || '').trim();
        return FORBIDDEN_LABELS.some(v => fLabel.includes(normalize(v))) && fValue === valueStr;
      });

      // poRawText — if GPT set poBox but left poRawText empty (common with clean text input),
      // auto-fill it with the poBox value rather than discarding a valid extraction.
      if (extracted.poBox && !extracted.poRawText) {
        extracted.poRawText = String(extracted.poBox);
        console.log('[extract] auto-filled poRawText from poBox:', extracted.poRawText);
      }
      const rawText = (extracted.poRawText || '').trim();
      const rawMissing = false; // no longer a hard discard — auto-fill handles it above
      const rawMismatch = rawText
        ? !rawText.replace(/\s/g, '').includes(valueStr.replace(/\s/g, ''))
        : false;

      console.log(
        `[extract] PO validation — label:"${extracted.poFieldLabel}" value:"${extracted.poBox}" ` +
        `labelOk:${labelOk} labelForbidden:${labelForbidden} forbidden:${valueForbidden} ` +
        `tooLong:${tooLong} valueInForbiddenField:${valueInForbiddenField} ` +
        `rawMissing:${rawMissing} rawMismatch:${rawMismatch}`
      );

      if (labelForbidden)             _discardReason = `label "${extracted.poFieldLabel}" is a forbidden field type`;
      else if (!labelOk)              _discardReason = `label "${extracted.poFieldLabel}" not in approved whitelist`;
      else if (valueForbidden)        _discardReason = `value "${valueStr}" is a forbidden account number`;
      else if (tooLong)               _discardReason = `value "${valueStr}" has too many digits (${digitsOnly.length})`;
      else if (valueInForbiddenField) _discardReason = `value "${valueStr}" found in a forbidden field (ORDER NO / CUSTOMER NO)`;
      else if (rawMissing)            _discardReason = `poRawText is empty — GPT could not quote the cell, meaning it was blank`;
      else if (rawMismatch)           _discardReason = `poRawText "${rawText}" does not contain value "${valueStr}"`;

      if (_discardReason) {
        console.log(`[extract] DISCARDING poBox — reason: ${_discardReason}`);
        extracted.poBox = null;
        extracted.poFieldLabel = null;
        extracted.poRawText = null;
      }
    }

    // Derive jobNo from poBox.
    // Jobber job numbers are always integers — strip any non-numeric suffix
    // (e.g. "1095-RETURN" → "1095", "1391-CREDIT" → "1391").
    const rawPO = (extracted.poBox || '').toString().trim();
    let jobNo = null;
    let jobStatus = 'missing';

    if (rawPO && rawPO.toLowerCase() !== 'null') {
      const numericMatch = rawPO.match(/^(\d+)/);
      jobNo = numericMatch ? numericMatch[1] : rawPO;
      jobStatus = 'found';
    }

    // Image preview data URL (kept small — only for images, shown on review page)
    const imageDataUrl = mimeType !== 'application/pdf'
      ? `data:${mimeType};base64,${fileBuffer.toString('base64')}`
      : null;

    // Upload file to Vercel Blob now, while it's already on the server.
    // Store just the public URL — avoids sending the whole file back to the browser
    // and then back again to /api/create-expense (which causes Payload Too Large for PDFs).
    let receiptBlobUrl = null;
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        const ext = mimeType === 'application/pdf' ? 'pdf' : (mimeType.split('/')[1] || 'jpg');
        const safeName = (extracted.invoiceNo || 'receipt').replace(/[^a-zA-Z0-9]/g, '_');
        const blob = await blobPut(`receipts/${safeName}_${Date.now()}.${ext}`, fileBuffer, {
          access: 'public',
          contentType: mimeType,
          token: process.env.BLOB_READ_WRITE_TOKEN
        });
        receiptBlobUrl = blob.url;
        console.log('[extract] uploaded to Vercel Blob:', receiptBlobUrl);
      } catch (blobErr) {
        console.error('[extract] Blob upload failed:', blobErr.message);
        // Non-fatal — extraction still succeeds, receipt just won't attach to Jobber
      }
    }

    res.json({
      success: true,
      data: {
        ...extracted,
        jobNo,
        jobStatus,
        imageDataUrl,
        receiptBlobUrl,
        isPdf: mimeType === 'application/pdf',
        _rawGpt,          // full raw GPT extraction before server filtering
        _discardReason,   // why poBox was discarded (null if kept or never set)
      }
    });

  } catch (err) {
    console.error('Extraction error:', err);

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 4MB.' });
    }
    if (err.status === 401) {
      return res.status(500).json({ error: 'Invalid OpenAI API key.' });
    }
    if (err.status === 429) {
      return res.status(500).json({ error: 'OpenAI rate limit hit. Please wait a moment and try again.' });
    }

    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: 'gpt-4o' });
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
