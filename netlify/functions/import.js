const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

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

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Claude API error: ' + err);
  }
  const data = await res.json();
  return data.content[0].text.trim();
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  // Verify Google auth token
  const token = (event.headers['authorization'] || '').replace('Bearer ', '');
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No token' }) };
  try { await verifyToken(token); }
  catch (e) { return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) }; }

  const { sheetUrl } = JSON.parse(event.body || '{}');
  if (!sheetUrl) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No sheet URL provided' }) };

  const sheetId = extractSheetId(sheetUrl);
  if (!sheetId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid Google Sheet URL' }) };

  // Read the sheet via Google Sheets API
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
    if (msg.includes('403') || msg.includes('permission') || msg.includes('PERMISSION')) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Sheet not accessible. Make sure it is shared with iel-parteneri-bot@iel-parteneri.iam.gserviceaccount.com' }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not read sheet: ' + msg }) };
  }

  if (rows.length < 2) return { statusCode: 200, headers, body: JSON.stringify({ partners: [] }) };

  const headersRow = rows[0];
  const dataRows = rows.slice(1).filter(r => r.some(c => c && String(c).trim()));
  const sample = dataRows.slice(0, 50);

  const prompt = `You are helping import partner/contact data into a CRM database.

The spreadsheet has these column headers (row 1):
${JSON.stringify(headersRow)}

Here are the data rows (up to 50):
${JSON.stringify(sample)}

Your job: map each row to this exact JSON structure and return ONLY a JSON array, no preamble, no markdown backticks:
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
- Merge any notes/observations/context fields intelligently into the right fields
- If a column clearly maps to a contact person (not the institution), put it in contacts array: {"name":"","role":"","phone":"","email":"","ielRelation":""}
- Romanian column names are common: Denumire=name, Telefon=phone, Email=email, Adresă=address, Site=website, Categorie=category, Observații=notes
- Return ONLY the JSON array, nothing else, no markdown`;

  let mapped;
  try {
    const text = await callClaude(prompt);
    const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    mapped = JSON.parse(clean);
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'AI mapping failed: ' + e.message }) };
  }

  mapped = mapped.map((p, i) => ({ ...p, _importId: i + 1 }));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ partners: mapped, total: mapped.length }),
  };
};
