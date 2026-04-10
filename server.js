require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());
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

    // Build preview — PDFs don't have a visual preview
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

app.listen(PORT, () => {
  console.log(`ReceiptFlow server running at http://localhost:${PORT}`);
});
