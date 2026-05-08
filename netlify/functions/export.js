const { OAuth2Client } = require('google-auth-library');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ALLOWED_DOMAIN = 'innoedulab.eu';

async function verifyToken(token) {
  const client = new OAuth2Client(GOOGLE_CLIENT_ID);
  const ticket = await client.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload.email.endsWith('@' + ALLOWED_DOMAIN)) throw new Error('Unauthorized domain');
  return payload;
}

async function getAccessToken() {
  const { JWT } = require('google-auth-library');
  const client = new JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const token = await client.getAccessToken();
  return token.token;
}

async function sheetsGet(accessToken, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  return res.json();
}

async function sheetsBatchUpdate(accessToken, requests) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests })
  });
  return res.json();
}

async function sheetsValuesUpdate(accessToken, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values })
  });
  return res.json();
}

async function sheetsGetMeta(accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  return res.json();
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  const token = (event.headers['authorization'] || '').replace('Bearer ', '');
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No token' }) };
  try { await verifyToken(token); } catch(e) { return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) }; }

  try {
    const accessToken = await getAccessToken();

    // Read partner data
    const readRes = await sheetsGet(accessToken, 'ParteneriDB!A:A');
    const json = (readRes.values || []).map(r => r[0]).join('');
    const { partners } = JSON.parse(json);

    // Max contacts
    const maxC = Math.max(...partners.map(p => (p.contacts || []).length), 0);

    // Header
    const header = ['Categorie','Subcategorie','Nume','Website','Email','Telefon','Adresa','Facebook','Instagram','LinkedIn','Context colaborare','Contract semnat','Link contract','Rating','Note'];
    for (let i = 1; i <= maxC; i++) header.push(`Contact ${i} - Nume`, `Contact ${i} - Rol`, `Contact ${i} - Telefon`, `Contact ${i} - Email`, `Contact ${i} - Relatie iEL`);

    // Rows
    const rows = partners.map(p => {
      const row = [p.category||'',p.subcategory||'',p.name||'',p.website||'',p.email||'',p.phone||'',p.address||'',p.facebook||'',p.instagram||'',p.linkedin||'',p.context||'',p.contractSigned?'Da':'Nu',p.contractLink||'',p.rating||0,p.notes||''];
      for (let i = 0; i < maxC; i++) {
        const c = (p.contacts || [])[i];
        row.push(c?c.name||'':'', c?c.role||'':'', c?c.phone||'':'', c?c.email||'':'', c?c.ielRelation||'':'');
      }
      return row;
    });

    // Tab name
    const today = new Date().toISOString().split('T')[0];
    const tabName = `Export ${today}`;

    // Check if tab exists and delete it
    const meta = await sheetsGetMeta(accessToken);
    const existing = (meta.sheets || []).find(s => s.properties.title === tabName);
    const requests = [];
    if (existing) requests.push({ deleteSheet: { sheetId: existing.properties.sheetId } });
    requests.push({ addSheet: { properties: { title: tabName } } });

    const batchRes = await sheetsBatchUpdate(accessToken, requests);
    const newSheetGid = batchRes.replies.find(r => r.addSheet).addSheet.properties.sheetId;

    // Write data
    await sheetsValuesUpdate(accessToken, `${tabName}!A1`, [header, ...rows]);

    // Format header
    await sheetsBatchUpdate(accessToken, [{
      repeatCell: {
        range: { sheetId: newSheetGid, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: {
          textFormat: { bold: true, foregroundColor: { red:1, green:1, blue:1 } },
          backgroundColor: { red:0.059, green:0.722, blue:0.761 }
        }},
        fields: 'userEnteredFormat(textFormat,backgroundColor)'
      }
    }]);

    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${newSheetGid}`;
    return { statusCode: 200, headers, body: JSON.stringify({ url }) };

  } catch(e) {
    console.error('Export error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
