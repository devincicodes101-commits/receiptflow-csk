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
function extractFieldsFromLlama(content) {
  let vendor = null, invoiceNo = null, date = null, jobNo = null, total = null;

  // Vendor: first **BOLD** heading in the markdown section
  const boldMatch = content.match(/\*\*([A-Za-z][A-Za-z\s&.-]+?)\*\*/);
  if (boldMatch) vendor = boldMatch[1].trim();

  // Parse all HTML tables → array of [table][row][col] = cellText
  const tables = [];
  for (const [tableHtml] of content.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const rows = [];
    for (const [rowHtml] of tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [];
      for (const [, inner] of rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)) {
        const text = inner
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ').trim();
        cells.push(text);
      }
      if (cells.some(c => c.length > 0)) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }

  // Build label→value map from the first 2 tables (header info box)
  // In Gescan documents, each pair of rows = labels row then values row
  const lmap = {};
  for (const table of tables.slice(0, 2)) {
    for (let r = 0; r + 1 < table.length; r++) {
      const lRow = table[r];
      const vRow = table[r + 1] || [];
      // A label row contains mostly uppercase letter strings — no dates, no long numbers
      const isLabelRow = lRow.some(c => /^[A-Z][A-Z\s./()-]{2,}$/.test(c)) &&
                         !lRow.some(c => /^\d{2}\/\d{2}\/\d{4}$/.test(c));
      if (isLabelRow) {
        for (let c = 0; c < lRow.length; c++) {
          const lbl = lRow[c].toUpperCase().replace(/\s+/g, ' ').trim();
          const val = (vRow[c] || '').trim();
          if (lbl.length > 1 && val.length > 0) lmap[lbl] = val;
        }
      }
    }
  }
  console.log('[fields] label map:', JSON.stringify(lmap));

  // Invoice number
  invoiceNo = lmap['ORDER NO'] || lmap['INVOICE NO'] || lmap['INVOICE NUMBER'] || null;

  // Job number — only accept 3–7 digit values
  const rawJob = lmap['YOUR P.O. NO'] || lmap['YOUR P.O.NO'] || lmap['P.O. NO'] ||
                 lmap['PO NO'] || lmap['PO #'] || null;
  if (rawJob && /^\d{3,7}$/.test(rawJob.trim())) jobNo = rawJob.trim();

  // Date — convert MM/DD/YYYY → YYYY-MM-DD
  const rawDate = lmap['ORDER DATE'] || lmap['INVOICE DATE'] || lmap['DATE'] || null;
  if (rawDate) {
    const dm = rawDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dm) date = `${dm[3]}-${dm[1].padStart(2, '0')}-${dm[2].padStart(2, '0')}`;
  }

  // Total — check if last table says "Continued" (multi-page); if so, sum line items
  const lastTable = tables[tables.length - 1] || [];
  const isContinued = lastTable.some(row => row.some(c => /continued/i.test(c)));

  if (isContinued && tables.length >= 3) {
    // Line items are in table index 2; find the TOTAL column from header row
    const itemsTable = tables[2];
    let totalColIdx = 6; // Gescan default
    for (const row of itemsTable.slice(0, 2)) {
      const idx = row.findIndex(c => c.toUpperCase() === 'TOTAL');
      if (idx >= 0) { totalColIdx = idx; break; }
    }
    let sum = 0;
    for (const row of itemsTable) {
      if (row.length <= totalColIdx) continue;
      const uom = (row[3] || '').toUpperCase();
      // Regular product row — U/M cell contains a unit abbreviation
      if (/^(EA|EACH|PC|PCS|PR|FT|M|BX|BOX|ROLL|RL|SET|BAG|LF|LB)$/.test(uom)) {
        const n = parseFloat(row[totalColIdx]);
        if (!isNaN(n) && n > 0) sum += n;
      }
      // Fee/surcharge row (ECO Fee etc.) — grab the last non-empty numeric cell
      else if (row.some(c => /fee|surcharge|eco|levy/i.test(c))) {
        for (let i = row.length - 1; i >= 0; i--) {
          const n = parseFloat(row[i]);
          if (!isNaN(n) && n > 0) { sum += n; break; }
        }
      }
    }
    if (sum > 0) total = Math.round(sum * 100) / 100;
  } else {
    // Single-page receipt — read actual total from last table's last numeric cell
    for (const row of [...lastTable].reverse()) {
      for (const cell of [...row].reverse()) {
        const n = parseFloat(cell);
        if (!isNaN(n) && n > 0) { total = n; break; }
      }
      if (total !== null) break;
    }
  }

  console.log('[fields] extracted:', { vendor, invoiceNo, date, jobNo, total });
  return { vendor, invoiceNo, date, jobNo, total };
}

// ── LlamaParse helper — uploads file, polls until done, returns text ──
async function parseWithLlamaParse(fileBuffer, mimeType, filename) {
  const LLAMA_KEY = process.env.LLAMA_CLOUD_API_KEY;
  if (!LLAMA_KEY) throw new Error('LLAMA_CLOUD_API_KEY not set');

  // Upload with premium_mode + HTML tables for best cell-level accuracy.
  // Gescan receipts have a two-row header box; premium_mode handles this better.
  const form = new FormData();
  const blob = new Blob([fileBuffer], { type: mimeType });
  form.append('file', blob, filename || 'receipt');
  form.append('premium_mode', 'true');
  form.append('output_tables_as_HTML', 'true');
  form.append('language', 'en');

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

  // Poll every 2 seconds for up to 60 seconds (premium mode takes a bit longer)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));

    const statusRes = await fetch(
      `https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}`,
      { headers: { 'Authorization': `Bearer ${LLAMA_KEY}` } }
    );
    const statusData = await statusRes.json();
    console.log('[llamaparse] poll', i + 1, '— status:', statusData.status);

    if (statusData.status === 'SUCCESS') {
      // Fetch both markdown and raw text, then combine so we don't miss any data.
      // Markdown has table structure; raw text has plain cell values as a fallback.
      const [mdRes, txtRes] = await Promise.all([
        fetch(`https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}/result/markdown`,
          { headers: { 'Authorization': `Bearer ${LLAMA_KEY}` } }),
        fetch(`https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}/result/raw/text`,
          { headers: { 'Authorization': `Bearer ${LLAMA_KEY}` } }),
      ]);
      const mdData  = await mdRes.json();
      const txtData = await txtRes.json().catch(() => ({}));

      const markdown = mdData.markdown || '';
      const rawText  = txtData.content  || txtData.text || txtData.raw_text || '';

      console.log('[llamaparse] markdown preview:', markdown.substring(0, 300));
      console.log('[llamaparse] raw text preview:', rawText.substring(0, 300));

      // Return both so the UI can show everything LlamaParse found
      return markdown + (rawText ? '\n\n---RAW TEXT---\n' + rawText : '');
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

    // ── LlamaParse — convert image or PDF to markdown text ──
    const llamaMarkdown = await parseWithLlamaParse(
      fileBuffer, mimeType, req.file.originalname || 'receipt'
    );
    console.log('[extract] LlamaParse markdown preview:', llamaMarkdown.substring(0, 500));

    // Image preview data URL (only for images — shown beside the markdown on review page)
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

    // Parse structured fields directly from LlamaParse HTML output
    const fields = extractFieldsFromLlama(llamaMarkdown);

    res.json({
      success: true,
      data: {
        markdown: llamaMarkdown,
        imageDataUrl,
        receiptBlobUrl,
        isPdf: mimeType === 'application/pdf',
        vendor:    fields.vendor    || null,
        invoiceNo: fields.invoiceNo || null,
        date:      fields.date      || null,
        total:     fields.total     || null,
        jobNo:     fields.jobNo     || null,
        jobStatus: fields.jobNo ? 'found' : 'missing',
        items: [],
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
