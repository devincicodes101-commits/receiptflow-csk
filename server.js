require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const https = require('https');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());

// Store uploads in memory (base64) — no disk writes needed
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only JPG, PNG, WEBP, GIF and PDF files are allowed'));
  }
});

const EXTRACTION_PROMPT = `You are an invoice parser for CSK Electric, an electrical contractor based in Abbotsford, BC.

CRITICAL CONTEXT:
- CSK Electric is the CUSTOMER/BUYER on these invoices — NOT the vendor. Do NOT use CSK Electric's address as the vendor address.
- The VENDOR is the supplier/seller (e.g. Gescan, Westburne, Home Depot, etc.)
- The vendor's address is the supplier's own address printed on their letterhead/header, NOT the "Sold To" or "Ship To" address.

JOB NUMBER DETECTION (very important):
- Look for a field explicitly labelled: "YOUR P.O. NO", "P.O. NO", "PO NO", "PO #", "Purchase Order", "Customer PO", "Our Order No", "Ref", "Reference", "Job #"
- Extract the VALUE from THAT field EXACTLY as printed (e.g. "1178", "1249", "1391-RETURN")
- If the PO field is blank or missing, set poBox to null. DO NOT substitute any other number.

CRITICAL — GESCAN/SONEPAR INVOICES SPECIFICALLY:
On every Gescan invoice there is a small two-column box near the top right that looks like this:
  | CUSTOMER NO  | YOUR P.O. NO |
  |    104625    |    1178      |
- "CUSTOMER NO" (left column, always 104625 for CSK Electric) = Gescan's internal account number for CSK Electric. NEVER use this as the job number.
- "YOUR P.O. NO" (right column, a small number like 1178, 1249, 1095) = the Jobber job number. ALWAYS use this.
- If you see 104625 anywhere, it is the CUSTOMER NO — ignore it for job number purposes.

INVOICE DATE:
- Use the main "Invoice Date" field. Ignore order dates or shipped dates.
- Return in YYYY-MM-DD format.

CREDIT / RETURN INVOICES:
- If the invoice is marked "RETURN MERCHANDISE", "CREDIT", "CREDIT MEMO", or "DO NOT PAY", it is a credit/return.
- For credits, all monetary amounts (subtotal, tax, total) must be NEGATIVE numbers (e.g. -807.91).
- Note this clearly in the "notes" field.

LINE ITEMS:
- Only list distinct product/service lines. Do not duplicate items.
- Each line item should have a product code or description, quantity, unit price, and line total.
- For credit invoices, line item totals should be negative.
- Fees, taxes, and surcharges can be separate line items.

TOTALS:
- subtotal = gross total before taxes (negative for credits)
- tax = sum of all taxes — GST, HST, PST, etc. (negative for credits)
- total = final amount due (negative for credits)

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):
{
  "vendor": "the supplier/seller company name",
  "address": "the supplier's own address from their letterhead (NOT CSK Electric's address)",
  "invoiceNo": "invoice number",
  "date": "YYYY-MM-DD",
  "poBox": "value from YOUR P.O. NO or PO# field exactly as printed, null if not present",
  "poFieldLabel": "the exact label text of the PO field found (e.g. 'YOUR P.O. NO', 'PO #')",
  "isCredit": true or false,
  "items": [
    {
      "desc": "product code + description",
      "qty": number or null,
      "unit": unit price as number or null,
      "total": line total as number
    }
  ],
  "subtotal": number,
  "tax": number,
  "total": number,
  "confidence": "high" | "medium" | "low",
  "notes": "any observations including if this is a credit/return"
}

If a field cannot be determined, use null. Never fabricate values.`;

app.post('/api/extract', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;

    // DEBUG: log what the server actually received
    console.log('[DEBUG extract] mimetype:', mimeType);
    console.log('[DEBUG extract] originalname:', req.file.originalname);
    console.log('[DEBUG extract] buffer size:', fileBuffer.length, '| isBuffer:', Buffer.isBuffer(fileBuffer));

    let rawContent;

    if (mimeType === 'application/pdf') {
      // Send PDF directly to OpenAI Responses API — reads the actual visual content, not garbled text
      const base64Pdf = fileBuffer.toString('base64');
      const response = await openai.responses.create({
        model: 'gpt-4o',
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_file',
                filename: req.file.originalname || 'invoice.pdf',
                file_data: `data:application/pdf;base64,${base64Pdf}`
              },
              {
                type: 'input_text',
                text: EXTRACTION_PROMPT
              }
            ]
          }
        ]
      });
      rawContent = response.output_text.trim();
    } else {
      // Image — use Chat Completions with vision
      const base64Image = fileBuffer.toString('base64');
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`,
                  detail: 'high'
                }
              },
              {
                type: 'text',
                text: EXTRACTION_PROMPT
              }
            ]
          }
        ],
        max_tokens: 2000,
        temperature: 0
      });
      rawContent = response.choices[0].message.content.trim();
    }

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

    // Derive jobNo from poBox — keep exactly as extracted, don't add prefixes
    const rawPO = (extracted.poBox || '').toString().trim();
    let jobNo = null;
    let jobStatus = 'missing';

    if (rawPO && rawPO.toLowerCase() !== 'null') {
      jobNo = rawPO;
      jobStatus = 'found';
    }

    // Build preview and store file data for later Jobber attachment
    const imageDataUrl = mimeType !== 'application/pdf'
      ? `data:${mimeType};base64,${fileBuffer.toString('base64')}`
      : null;

    // Store PDF base64 for Jobber attachment (only if small enough to POST back later)
    const pdfDataUrl = mimeType === 'application/pdf' && fileBuffer.length < 3 * 1024 * 1024
      ? `data:application/pdf;base64,${fileBuffer.toString('base64')}`
      : null;

    res.json({
      success: true,
      data: {
        ...extracted,
        jobNo,
        jobStatus,
        imageDataUrl,
        pdfDataUrl,
        isPdf: mimeType === 'application/pdf'
      }
    });

  } catch (err) {
    console.error('Extraction error:', err);

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
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
    const { vendor, invoiceNo, date, total, jobNo, receiptBase64, receiptMime } = req.body;

    if (!jobNo) {
      return res.status(400).json({ error: 'No job number found. Please enter one before posting to Jobber.' });
    }

    const num = parseInt(jobNo);

    // Find job by searching (first:100 to avoid missing it), then exact-match on jobNumber
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

    // Exact match — search can return partial matches
    const job = jobResult.data?.jobs?.nodes?.find(j => j.jobNumber === num);
    if (!job) {
      return res.status(404).json({
        error: `Job #${jobNo} not found in Jobber. Check the job number and try again.`,
        debug: { searched: num, returned: jobResult.data?.jobs?.nodes }
      });
    }

    // Attach receipt via Jobber ActiveStorage REST API
    let receiptSignedBlobId = null;
    let receiptNote = receiptBase64 ? 'no image data' : null;

    // DEBUG: log receipt input format at entry to create-expense
    console.log('[DEBUG create-expense] receiptMime:', receiptMime);
    console.log('[DEBUG create-expense] receiptBase64 type:', typeof receiptBase64);
    console.log('[DEBUG create-expense] receiptBase64 length:', receiptBase64?.length);
    console.log('[DEBUG create-expense] receiptBase64 sample:', receiptBase64?.substring(0, 80));

    if (receiptBase64 && receiptMime) {
      try {
        const buffer = Buffer.from(receiptBase64, 'base64');
        console.log('[DEBUG create-expense] decoded buffer length:', buffer.length, '| isBuffer:', Buffer.isBuffer(buffer));
        const checksum = require('crypto').createHash('md5').update(buffer).digest('base64');
        const ext = receiptMime.split('/')[1] || 'jpg';
        const filename = `${(invoiceNo || 'receipt').replace(/[^a-zA-Z0-9]/g, '_')}.${ext}`;
        const token = await getJobberToken();
        const blobPayload = JSON.stringify({ blob: { filename, content_type: receiptMime, byte_size: buffer.length, checksum } });

        // Try api.getjobber.com first, then app.getjobber.com (Rails app)
        let initRes, initText;
        for (const host of ['https://api.getjobber.com', 'https://app.getjobber.com']) {
          initRes = await fetch(`${host}/rails/active_storage/direct_uploads`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: blobPayload
          });
          initText = await initRes.text();
          console.log(`[DEBUG] ActiveStorage init (${host}):`, initRes.status, initText.substring(0, 200));
          if (initRes.ok) break;
        }

        if (initRes.ok) {
          const blobData = JSON.parse(initText);
          const { signed_id, direct_upload } = blobData;
          if (direct_upload?.url && signed_id) {
            // Use Node.js https.request instead of fetch to avoid duplex/chunked-encoding issues.
            // S3 presigned URLs require a known Content-Length and reject chunked transfer encoding.
            const putHeaders = { ...direct_upload.headers, 'Content-Length': String(buffer.length) };
            console.log('[DEBUG] ActiveStorage PUT url:', direct_upload.url.substring(0, 80));
            console.log('[DEBUG] ActiveStorage PUT headers:', JSON.stringify(putHeaders));

            const putResult = await new Promise((resolve, reject) => {
              const putUrl = new URL(direct_upload.url);
              const req = https.request({
                hostname: putUrl.hostname,
                path: putUrl.pathname + putUrl.search,
                method: 'PUT',
                headers: putHeaders
              }, (resp) => {
                let body = '';
                resp.on('data', chunk => { body += chunk; });
                resp.on('end', () => resolve({ status: resp.statusCode, body }));
              });
              req.on('error', reject);
              req.write(buffer);
              req.end();
            });

            console.log('[DEBUG] ActiveStorage PUT result:', putResult.status, putResult.body.substring(0, 300));
            if (putResult.status >= 200 && putResult.status < 300) {
              receiptSignedBlobId = signed_id;
              receiptNote = 'attached';
            } else {
              receiptNote = `PUT ${putResult.status}: ${putResult.body.replace(/<[^>]+>/g, '').trim().substring(0, 100)}`;
            }
          } else {
            receiptNote = `missing signed_id or url in response`;
          }
        } else {
          receiptNote = `init failed: ${initRes.status} — ${initText.substring(0, 120)}`;
        }
      } catch (asErr) {
        receiptNote = `error: ${asErr.message}`;
        console.error('[DEBUG] Receipt upload error:', asErr.stack || asErr.message);
      }
    }

    // Create expense on that job
    const expInput = {
      linkedJobId: job.id,
      title: `${vendor || 'Unknown Vendor'} — Invoice #${invoiceNo || 'N/A'}`,
      description: invoiceNo ? `Invoice #${invoiceNo}` : undefined,
      total: parseFloat(total) || 0,
      date: (date || new Date().toISOString().split('T')[0]) + 'T00:00:00Z'
    };
    if (receiptSignedBlobId) expInput.receiptSignedBlobId = receiptSignedBlobId;

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
