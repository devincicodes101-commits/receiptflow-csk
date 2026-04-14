require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent';

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

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

    const rawContent = geminiJson.candidates[0].content.parts[0].text.trim();

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

// Health check
app.get('/api/health', (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  res.json({
    status: 'ok',
    model: 'gemini-3.1-pro',
    keyConfigured: !!key,
    keyPreview: key ? key.substring(0, 8) + '...' : 'NOT SET — check Vercel env vars'
  });
});

// List available Gemini models for this API key
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
