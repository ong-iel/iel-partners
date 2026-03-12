const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = 'ParteneriDB';
const CHUNK_SIZE = 40000; // safe chars per cell

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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  if (event.httpMethod === 'GET') {
    // Read all rows from col A, concatenate, parse JSON
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
    
    // Split into chunks
    const chunks = [];
    for (let i = 0; i < fullJson.length; i += CHUNK_SIZE) {
      chunks.push([fullJson.slice(i, i + CHUNK_SIZE)]);
    }

    // Clear sheet first
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A:A`,
    });

    // Write chunks
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
