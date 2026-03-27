const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const Anthropic = require('@anthropic-ai/sdk');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ALLOWED_DOMAIN = 'innoedulab.eu';

async function verifyToken(token) {
  const client = new OAuth2Client(GOOGLE_CLIENT_ID);
  const ticket = await client.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload.email.endsWith('@' + ALLOWED_DOMAIN)) throw new Error('Unauthorized domain');
  return payload;
}

async function getAuth() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  await auth.authorize();
  return auth;
}

function extractSheetId(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  // Verify auth
  const token = (event.headers['authorization'] || '').replace('Bearer ', '');
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No token' }) };
  try { await verifyToken(token); }
  catch (e) { return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) }; }

  const { sheetUrl } = JSON.parse(event.body || '{}');
  if (!sheetUrl) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No sheet URL provided' }) };

  const sheetId = extractSheetId(sheetUrl);
  if (!sheetId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid Google Sheet URL' }) };

  // Read the sheet
  let rows;
  try {
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'A1:Z200',
    });
    rows = res.data.values || [];
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('403') || msg.includes('permission')) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Sheet not accessible. Make sure it is shared with iel-parteneri-bot@iel-parteneri.iam.gserviceaccount.com' }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not read sheet: ' + msg }) };
  }

  if (rows.length < 2) return { statusCode: 200, headers, body: JSON.stringify({ partners: [] }) };

  // Use Claude to map columns and extract structured data
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const headers_row = rows[0];
  const data_rows = rows.slice(1).filter(r => r.some(c => c && c.trim()));

  // Send first 50 rows max to Claude for mapping
  const sample = data_rows.slice(0, 50);

  const prompt = `You are helping import partner/contact data into a CRM database.

The spreadsheet has these column headers (row 1):
${JSON.stringify(headers_row)}

Here are the data rows (up to 50):
${JSON.stringify(sample)}

Your job: map each row to this exact JSON structure and return ONLY a JSON array, no preamble, no markdown:
[
  {
    "name": "institution or person name (required, skip row if empty)",
    "category": "best guess from: Liceu, Școală, Centru, ONG, Partener, Media, Instituție Publică — or leave as original value if none fit",
    "subcategory": "domain tags if present, comma separated, else empty string",
    "website": "website url or empty string",
    "email": "primary email or empty string",
    "phone": "phone number or empty string",
    "address": "city or address or empty string",
    "facebook": "facebook url or empty string",
    "instagram": "instagram url or empty string",
    "linkedin": "linkedin url or empty string",
    "context": "collaboration context or notes about relationship, or empty string",
    "notes": "any other notes or observations, or empty string",
    "contractSigned": false,
    "contractLink": "",
    "rating": 0,
    "contacts": []
  }
]

Rules:
- Skip rows where name is empty or clearly a header repeat
- Merge any "notes", "observations", "context" type fields intelligently
- If a column clearly maps to a contact person (not the institution), put it in contacts array: {"name":"","role":"","phone":"","email":"","ielRelation":""}
- Romanian column names are common: Denumire=name, Telefon=phone, Email=email, Adresă=address, Site=website, Categorie=category, Observații=notes
- Return ONLY the JSON array, nothing else`;

  let mapped;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0].text.trim();
    const clean = text.replace(/^```json\n?/, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim();
    mapped = JSON.parse(clean);
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'AI mapping failed: ' + e.message }) };
  }

  // Assign temporary IDs for frontend use
  mapped = mapped.map((p, i) => ({ ...p, _importId: i + 1 }));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ partners: mapped, total: mapped.length }),
  };
};
