require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// ── API URLs ──────────────────────────────────────────────────────────────
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const JOBBER_API_URL = 'https://api.getjobber.com/api/graphql';
const JOBBER_TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';

app.use(cors());
app.use(express.json());

// ── In-memory Jobber token cache ──────────────────────────────────────────
let jobberTokenCache = {
  access_token: process.env.JOBBER_API_KEY || null,  // fallback to static key if set
  token_type: 'Bearer',
  expires_at: process.env.JOBBER_API_KEY ? Date.now() + 999999999 : 0,
  refresh_token: process.env.JOBBER_REFRESH_TOKEN || null
};

async function getJobberToken() {
  // If we have a valid cached token, return it
  if (jobberTokenCache.access_token && Date.now() < jobberTokenCache.expires_at - 60000) {
    return jobberTokenCache.access_token;
  }

  const clientId = process.env.JOBBER_CLIENT_ID;
  const clientSecret = process.env.JOBBER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET are required');
  }

  // Try refresh token flow first
  if (jobberTokenCache.refresh_token) {
    try {
      const res = await fetch(JOBBER_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: jobberTokenCache.refresh_token
        })
      });
      const data = await res.json();
      if (res.ok && data.access_token) {
        jobberTokenCache = {
          access_token: data.access_token,
          token_type: data.token_type || 'Bearer',
          expires_at: Date.now() + (data.expires_in || 3600) * 1000,
          refresh_token: data.refresh_token || jobberTokenCache.refresh_token
        };
        console.log('[Jobber] Token refreshed via refresh_token');
        return jobberTokenCache.access_token;
      }
    } catch (e) {
      console.warn('[Jobber] Refresh token failed:', e.message);
    }
  }

  // Try client_credentials flow (works for server-to-server apps)
  try {
    const res = await fetch(JOBBER_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
      })
    });
    const data = await res.json();
    if (res.ok && data.access_token) {
      jobberTokenCache = {
        access_token: data.access_token,
        token_type: data.token_type || 'Bearer',
        expires_at: Date.now() + (data.expires_in || 3600) * 1000,
        refresh_token: data.refresh_token || null
      };
      console.log('[Jobber] Token obtained via client_credentials');
      return jobberTokenCache.access_token;
    }
    // Jobber might not support client_credentials — fall through to static key
    console.warn('[Jobber] client_credentials not supported:', JSON.stringify(data));
  } catch (e) {
    console.warn('[Jobber] client_credentials flow failed:', e.message);
  }

  // Last resort: use JOBBER_API_KEY directly (personal access token / static key)
  if (process.env.JOBBER_API_KEY) {
    return process.env.JOBBER_API_KEY;
  }

  throw new Error('Could not obtain Jobber access token. Set JOBBER_API_KEY or configure OAuth.');
}

// ── Gemini model selection ────────────────────────────────────────────────
let cachedGeminiModel = null;

async function getBestGeminiModel() {
  if (cachedGeminiModel) return cachedGeminiModel;

  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');

  try {
    const res = await fetch(`${GEMINI_BASE}/models?key=${key}`);
    const data = await res.json();
    if (!res.ok) throw new Error('Models list failed: ' + JSON.stringify(data.error));

    const PREFERRED = [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-pro-vision',
      'gemini-1.0-pro-vision'
    ];

    const available = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''));

    console.log('[Gemini] Available models:', available);

    for (const pref of PREFERRED) {
      if (available.includes(pref)) {
        cachedGeminiModel = pref;
        console.log('[Gemini] Selected model:', pref);
        return pref;
      }
    }

    // Fallback: pick first multimodal capable model
    const fallback = available.find(m => m.includes('flash') || m.includes('pro'));
    if (fallback) {
      cachedGeminiModel = fallback;
      console.log('[Gemini] Fallback model:', fallback);
      return fallback;
    }

    // Default
    cachedGeminiModel = 'gemini-1.5-pro';
    return cachedGeminiModel;
  } catch (err) {
    console.warn('[Gemini] Model detection failed, using default:', err.message);
    cachedGeminiModel = 'gemini-1.5-pro';
    return cachedGeminiModel;
  }
}

// ── Basic Auth Middleware ──────────────────────────────────────────────────
function basicAuth(req, res, next) {
  if (req.path === '/api/health') return next();
  if (req.path === '/api/jobber/callback') return next();

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="ReceiptFlow"');
    return res.status(401).json({ error: 'Authentication required' });
  }

  const base64 = authHeader.slice(6);
  const [user, pass] = Buffer.from(base64, 'base64').toString().split(':');

  const validUser = process.env.AUTH_USER || 'admin';
  const validPass = process.env.AUTH_PASS || 'csk2024';

  if (user === validUser && pass === validPass) return next();

  res.set('WWW-Authenticate', 'Basic realm="ReceiptFlow"');
  return res.status(401).json({ error: 'Invalid credentials' });
}

app.use('/api/extract', basicAuth);
app.use('/api/post-to-jobber', basicAuth);
app.use('/api/jobber-job', basicAuth);
app.use('/api/models', basicAuth);
app.use('/api/jobber-status', basicAuth);

app.use(express.static('.'));

// ── File upload (memory) ──────────────────────────────────────────────────
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only JPG, PNG, WEBP, GIF and PDF files are allowed'));
  }
});

// ── Vercel Blob upload helper ─────────────────────────────────────────────
async function uploadToBlob(buffer, filename, mimeType) {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    console.warn('[Blob] BLOB_READ_WRITE_TOKEN not set — skipping blob upload');
    return null;
  }

  try {
    const res = await fetch(`https://blob.vercel-storage.com/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${blobToken}`,
        'Content-Type': mimeType,
        'x-content-type': mimeType,
        'Cache-Control': 'public, max-age=31536000'
      },
      body: buffer
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn('[Blob] Upload failed:', err);
      return null;
    }

    const data = await res.json();
    console.log('[Blob] Uploaded:', data.url);
    return data.url;
  } catch (err) {
    console.warn('[Blob] Upload error:', err.message);
    return null;
  }
}

// ── Extraction Prompt ────────────────────────────────────────────────────
const EXTRACTION_PROMPT = `You are an invoice parser for CSK Electric, an electrical contractor based in Abbotsford, BC.

CRITICAL CONTEXT:
- CSK Electric is the CUSTOMER/BUYER on these invoices — NOT the vendor. Do NOT use CSK Electric's address as the vendor address.
- The VENDOR is the supplier/seller (e.g. Gescan, Westburne, Home Depot, etc.)
- The vendor's address is the supplier's own address printed on their letterhead/header, NOT the "Sold To" or "Ship To" address.

JOB NUMBER DETECTION (very important):
- Look for a field called: "YOUR P.O. NO", "P.O. NO", "PO NO", "PO #", "Purchase Order", "Customer PO", "Our Order No", "Ref", "Reference"
- The value in that field is the Jobber job number — extract it EXACTLY as printed (e.g. "1408", "J-104625")
- If you cannot find this field, set poBox to null. DO NOT guess or make up a job number.

INVOICE DATE:
- Use the main "Invoice Date" field. Ignore order dates or shipped dates.
- Return in YYYY-MM-DD format.

LINE ITEMS:
- Only list distinct product/service lines. Do not duplicate items.
- Each line item should have a product code or description, quantity, unit price, and line total.
- Fees, taxes, and surcharges can be separate line items.

TOTALS:
- subtotal = gross total before taxes
- tax = sum of all taxes (GST, HST, PST, etc.)
- total = final amount due (the largest total on the invoice)

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):
{
  "vendor": "the supplier/seller company name",
  "address": "the supplier's own address from their letterhead (NOT CSK Electric's address)",
  "invoiceNo": "invoice number",
  "date": "YYYY-MM-DD",
  "poBox": "value from YOUR P.O. NO or PO# field exactly as printed, null if not present",
  "poFieldLabel": "the exact label text of the PO field found (e.g. 'YOUR P.O. NO', 'PO #')",
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
  "notes": "any observations"
}

If a field cannot be determined, use null. Never fabricate values.`;

// ── Gemini extraction (with SDK-style retry) ──────────────────────────────
async function extractWithGemini(buffer, mimeType) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');

  const model = await getBestGeminiModel();
  const base64Data = buffer.toString('base64');

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        { text: EXTRACTION_PROMPT }
      ]
    }],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.1
    }
  };

  // Attempt 1: direct REST
  let lastError = null;
  const apiUrl = `${GEMINI_BASE}/models/${model}:generateContent?key=${key}`;

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (!res.ok) {
      lastError = new Error('Gemini API error: ' + JSON.stringify(data.error || data));
    } else {
      return parseGeminiResponse(data);
    }
  } catch (err) {
    lastError = err;
    console.warn('[Gemini] REST attempt failed:', err.message);
  }

  // Attempt 2: try alternate model if first fails
  const altModels = ['gemini-1.5-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro'];
  for (const alt of altModels) {
    if (alt === model) continue;
    try {
      console.log('[Gemini] Retrying with model:', alt);
      const res = await fetch(`${GEMINI_BASE}/models/${alt}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok) {
        cachedGeminiModel = alt; // Update cache to working model
        return parseGeminiResponse(data);
      }
    } catch (err) {
      console.warn(`[Gemini] Alt model ${alt} failed:`, err.message);
    }
  }

  throw lastError || new Error('All Gemini model attempts failed');
}

function parseGeminiResponse(data) {
  const rawContent = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!rawContent) throw new Error('Gemini returned empty response');

  let jsonStr = rawContent;
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const extracted = JSON.parse(jsonStr);
  return extracted;
}

// ── POST /api/extract ────────────────────────────────────────────────────
app.post('/api/extract', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { buffer, mimetype, originalname } = req.file;

    // Upload to Vercel Blob (non-blocking — don't fail if blob fails)
    const ts = Date.now();
    const ext = originalname.split('.').pop() || 'bin';
    const blobFilename = `receipts/${ts}-${Math.random().toString(36).slice(2)}.${ext}`;
    const blobUrl = await uploadToBlob(buffer, blobFilename, mimetype);

    // Extract with Gemini
    const extracted = await extractWithGemini(buffer, mimetype);

    const rawPO = (extracted.poBox || '').toString().trim();
    let jobNo = null;
    let jobStatus = 'missing';

    if (rawPO && rawPO.toLowerCase() !== 'null') {
      jobNo = rawPO;
      jobStatus = 'found';
    }

    const imageDataUrl = mimetype !== 'application/pdf'
      ? `data:${mimetype};base64,${buffer.toString('base64')}`
      : null;

    res.json({
      success: true,
      data: {
        ...extracted,
        jobNo,
        jobStatus,
        imageDataUrl,
        isPdf: mimetype === 'application/pdf',
        blobUrl: blobUrl || null
      }
    });

  } catch (err) {
    console.error('[Extract] Error:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
    }
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ── Jobber: OAuth callback (for code exchange) ───────────────────────────
app.get('/api/jobber/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  const clientId = process.env.JOBBER_CLIENT_ID;
  const clientSecret = process.env.JOBBER_CLIENT_SECRET;
  const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;

  try {
    const tokenRes = await fetch(JOBBER_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${appUrl}/api/jobber/callback`
      })
    });

    const data = await tokenRes.json();
    if (!tokenRes.ok) return res.status(400).send('Token exchange failed: ' + JSON.stringify(data));

    jobberTokenCache = {
      access_token: data.access_token,
      token_type: data.token_type || 'Bearer',
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      refresh_token: data.refresh_token || null
    };

    console.log('[Jobber] OAuth code exchanged for token successfully');
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;"><h2 style="color:#059669;">✓ Jobber Connected</h2><p>You can close this window.</p></body></html>');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ── Jobber: status & auth URL ─────────────────────────────────────────────
app.get('/api/jobber-status', async (req, res) => {
  const clientId = process.env.JOBBER_CLIENT_ID;
  const clientSecret = process.env.JOBBER_CLIENT_SECRET;
  const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;

  let connected = false;
  let authUrl = null;

  try {
    const token = await getJobberToken();
    // Quick connectivity test
    const testRes = await fetch(JOBBER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-JOBBER-GRAPHQL-VERSION': '2024-01-01'
      },
      body: JSON.stringify({ query: '{ __typename }' })
    });
    connected = testRes.ok;
  } catch (e) {
    connected = false;
  }

  if (!connected && clientId) {
    const redirectUri = encodeURIComponent(`${appUrl}/api/jobber/callback`);
    authUrl = `https://api.getjobber.com/api/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}`;
  }

  res.json({ connected, authUrl, hasClientId: !!clientId, hasClientSecret: !!clientSecret });
});

// ── Jobber: look up a job by job number ───────────────────────────────────
app.get('/api/jobber-job', async (req, res) => {
  const jobNumber = req.query.jobNumber;
  if (!jobNumber) return res.status(400).json({ error: 'jobNumber query param required' });

  try {
    const token = await getJobberToken();

    const query = `
      query FindJob($filter: JobFilterAttributes) {
        jobs(filter: $filter) {
          nodes {
            id
            jobNumber
            title
            client {
              id
              name
            }
          }
        }
      }
    `;

    const jobberRes = await fetch(JOBBER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-JOBBER-GRAPHQL-VERSION': '2024-01-01'
      },
      body: JSON.stringify({
        query,
        variables: { filter: { jobNumber: parseInt(jobNumber) || jobNumber } }
      })
    });

    const data = await jobberRes.json();
    if (!jobberRes.ok) return res.status(jobberRes.status).json(data);

    const jobs = data?.data?.jobs?.nodes || [];
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Jobber: post expense to a job ─────────────────────────────────────────
app.post('/api/post-to-jobber', async (req, res) => {
  const { jobId, vendor, invoiceNo, date, total, tax, subtotal, category, items, blobUrl } = req.body;

  if (!jobId) return res.status(400).json({ error: 'jobId is required' });
  if (!total) return res.status(400).json({ error: 'total is required' });

  try {
    const token = await getJobberToken();

    const itemsSummary = (items || []).slice(0, 5).map(i => i.desc).filter(Boolean).join('; ');
    const description = itemsSummary || `${vendor || 'Vendor'} — Invoice ${invoiceNo || 'N/A'}`;

    const mutation = `
      mutation CreateExpense($input: ExpenseCreateInput!) {
        expenseCreate(input: $input) {
          expense {
            id
            description
            total
            date
          }
          userErrors {
            message
            path
          }
        }
      }
    `;

    const inputPayload = {
      jobId,
      description,
      total: parseFloat(total),
      tax: parseFloat(tax) || 0,
      date: date || new Date().toISOString().split('T')[0],
      financialCategory: (category || 'MATERIALS').toUpperCase()
    };

    // Attach blob URL as a note/attachment if available
    if (blobUrl) {
      inputPayload.description = description + `\n[Receipt: ${blobUrl}]`;
    }

    const jobberRes = await fetch(JOBBER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-JOBBER-GRAPHQL-VERSION': '2024-01-01'
      },
      body: JSON.stringify({ query: mutation, variables: { input: inputPayload } })
    });

    const data = await jobberRes.json();
    if (!jobberRes.ok) return res.status(jobberRes.status).json(data);

    const userErrors = data?.data?.expenseCreate?.userErrors || [];
    if (userErrors.length > 0) {
      return res.status(400).json({ error: userErrors.map(e => e.message).join(', ') });
    }

    const expense = data?.data?.expenseCreate?.expense;
    res.json({ success: true, expense });

  } catch (err) {
    console.error('[Jobber Post] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const geminiKey = process.env.GEMINI_API_KEY;
  const jobberKey = process.env.JOBBER_API_KEY;
  const clientId = process.env.JOBBER_CLIENT_ID;
  const clientSecret = process.env.JOBBER_CLIENT_SECRET;
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

  let geminiModel = cachedGeminiModel || 'gemini-1.5-pro';
  // Kick off model detection in background (non-blocking)
  if (!cachedGeminiModel && geminiKey) {
    getBestGeminiModel().then(m => { geminiModel = m; }).catch(() => {});
  }

  res.json({
    status: 'ok',
    model: geminiModel,
    geminiConfigured: !!geminiKey,
    jobberConfigured: !!(jobberKey || (clientId && clientSecret)),
    jobberOAuthConfigured: !!(clientId && clientSecret),
    blobConfigured: !!blobToken,
    authConfigured: !!process.env.AUTH_USER,
    geminiKeyPreview: geminiKey ? geminiKey.substring(0, 8) + '...' : 'NOT SET',
    jobberKeyPreview: jobberKey ? jobberKey.substring(0, 8) + '...' : (clientId ? 'OAuth' : 'NOT SET')
  });
});

// ── List available Gemini models ──────────────────────────────────────────
app.get('/api/models', async (req, res) => {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

    const r = await fetch(`${GEMINI_BASE}/models?key=${key}`);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);

    const models = (data.models || []).map(m => ({
      name: m.name,
      displayName: m.displayName,
      methods: m.supportedGenerationMethods,
      supportsVision: (m.supportedGenerationMethods || []).includes('generateContent')
    })).filter(m => m.supportsVision);

    const best = await getBestGeminiModel();
    res.json({ models, selected: best });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ReceiptFlow server running at http://localhost:${PORT}`);
  // Pre-load best Gemini model on startup
  if (process.env.GEMINI_API_KEY) {
    getBestGeminiModel().then(m => console.log('[Startup] Gemini model:', m)).catch(e => console.warn('[Startup] Model detection:', e.message));
  }
});
