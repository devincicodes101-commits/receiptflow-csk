require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent';
const JOBBER_API_URL = 'https://api.getjobber.com/api/graphql';

app.use(cors());
app.use(express.json());

// ── Basic Auth Middleware ──────────────────────────────────────────────────
function basicAuth(req, res, next) {
  // Skip auth for health check
  if (req.path === '/api/health') return next();

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="ReceiptFlow"');
    return res.status(401).json({ error: 'Authentication required' });
  }

  const base64 = authHeader.slice(6);
  const [user, pass] = Buffer.from(base64, 'base64').toString().split(':');

  const validUser = process.env.AUTH_USER || 'admin';
  const validPass = process.env.AUTH_PASS || 'csk2024';

  if (user === validUser && pass === validPass) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="ReceiptFlow"');
  return res.status(401).json({ error: 'Invalid credentials' });
}

app.use('/api/extract', basicAuth);
app.use('/api/post-to-jobber', basicAuth);
app.use('/api/jobber-job', basicAuth);
app.use('/api/models', basicAuth);

app.use(express.static('.'));

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

app.post('/api/extract', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;

    const base64Data = fileBuffer.toString('base64');
    const geminiRes = await fetch(`${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
      })
    });

    const geminiJson = await geminiRes.json();

    if (!geminiRes.ok) {
      throw new Error('Gemini API error: ' + JSON.stringify(geminiJson.error || geminiJson));
    }

    let rawContent = geminiJson.candidates[0].content.parts[0].text.trim();

    let jsonStr = rawContent;
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    let extracted;
    try {
      extracted = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr);
      return res.status(500).json({
        error: 'AI returned invalid JSON. Raw response: ' + rawContent.substring(0, 200)
      });
    }

    const rawPO = (extracted.poBox || '').toString().trim();
    let jobNo = null;
    let jobStatus = 'missing';

    if (rawPO && rawPO.toLowerCase() !== 'null') {
      jobNo = rawPO;
      jobStatus = 'found';
    }

    const imageDataUrl = mimeType !== 'application/pdf'
      ? `data:${mimeType};base64,${fileBuffer.toString('base64')}`
      : null;

    res.json({
      success: true,
      data: {
        ...extracted,
        jobNo,
        jobStatus,
        imageDataUrl,
        isPdf: mimeType === 'application/pdf'
      }
    });

  } catch (err) {
    console.error('Extraction error:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
    }
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ── Jobber: look up a job by job number ───────────────────────────────────
app.get('/api/jobber-job', async (req, res) => {
  const jobNumber = req.query.jobNumber;
  if (!jobNumber) return res.status(400).json({ error: 'jobNumber query param required' });

  const apiKey = process.env.JOBBER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'JOBBER_API_KEY not configured' });

  try {
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
        'Authorization': `Bearer ${apiKey}`,
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
  const { jobId, vendor, invoiceNo, date, total, tax, subtotal, category, items } = req.body;

  if (!jobId) return res.status(400).json({ error: 'jobId is required' });
  if (!total) return res.status(400).json({ error: 'total is required' });

  const apiKey = process.env.JOBBER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'JOBBER_API_KEY not configured' });

  // Build description from line items or fallback to vendor + invoice
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

  try {
    const jobberRes = await fetch(JOBBER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-JOBBER-GRAPHQL-VERSION': '2024-01-01'
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          input: {
            jobId,
            description,
            total: parseFloat(total),
            tax: parseFloat(tax) || 0,
            date: date || new Date().toISOString().split('T')[0],
            financialCategory: category || 'MATERIALS'
          }
        }
      })
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
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const geminiKey = process.env.GEMINI_API_KEY;
  const jobberKey = process.env.JOBBER_API_KEY;
  const authUser = process.env.AUTH_USER;
  res.json({
    status: 'ok',
    model: 'gemini-1.5-pro',
    geminiConfigured: !!geminiKey,
    jobberConfigured: !!jobberKey,
    authConfigured: !!authUser,
    geminiKeyPreview: geminiKey ? geminiKey.substring(0, 8) + '...' : 'NOT SET',
    jobberKeyPreview: jobberKey ? jobberKey.substring(0, 8) + '...' : 'NOT SET'
  });
});

// ── List available Gemini models ──────────────────────────────────────────
app.get('/api/models', async (req, res) => {
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    const models = (data.models || []).map(m => ({
      name: m.name,
      methods: m.supportedGenerationMethods
    }));
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ReceiptFlow server running at http://localhost:${PORT}`);
});
