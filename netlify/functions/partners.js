const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = 'ParteneriDB';
const CHUNK_SIZE = 40000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ALLOWED_DOMAIN = 'innoedulab.eu';

async function verifyToken(token) {
  const client = new OAuth2Client(GOOGLE_CLIENT_ID);
  const ticket = await client.verifyIdToken({
    idToken: token,
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload.email.endsWith('@' + ALLOWED_DOMAIN)) {
    throw new Error('Unauthorized domain');
  }
  return payload;
}

async function getAuth() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  await auth.authorize();
  return auth;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // Verify Google token
  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No token' }) };

  try {
    await verifyToken(token);
  } catch (e) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  if (event.httpMethod === 'GET') {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A:A`,
    });
    const rows = res.data.values || [];
    const fullJson = rows.map(r => r[0] || '').join('');
    if (!fullJson) return { statusCode: 200, headers, body: JSON.stringify({ partners: [] }) };
    const data = JSON.parse(fullJson);
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  if (event.httpMethod === 'POST') {
    const body = JSON.parse(event.body);
    const fullJson = JSON.stringify(body);
    const chunks = [];
    for (let i = 0; i < fullJson.length; i += CHUNK_SIZE) {
      chunks.push([fullJson.slice(i, i + CHUNK_SIZE)]);
    }
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A:A`,
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: chunks },
    });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, chunks: chunks.length }) };
  }

  return { statusCode: 405, headers, body: 'Method not allowed' };
};
