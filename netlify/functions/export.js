const { google } = require('googleapis');
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  const token = (event.headers['authorization'] || '').replace('Bearer ', '');
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No token' }) };
  try { await verifyToken(token); } catch(e) { return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) }; }

  try {
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const read = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'ParteneriDB!A:A' });
    const json = (read.data.values||[]).map(r=>r[0]).join('');
    const { partners } = JSON.parse(json);

    const maxC = Math.max(...partners.map(p=>(p.contacts||[]).length), 0);

    const header = ['Categorie','Subcategorie','Nume','Website','Email','Telefon','Adresa','Facebook','Instagram','LinkedIn','Context colaborare','Contract semnat','Link contract','Rating','Note'];
    for (let i=1; i<=maxC; i++) header.push(`Contact ${i} - Nume`,`Contact ${i} - Rol`,`Contact ${i} - Telefon`,`Contact ${i} - Email`,`Contact ${i} - Relatie iEL`);

    const rows = partners.map(p => {
      const row = [p.category||'',p.subcategory||'',p.name||'',p.website||'',p.email||'',p.phone||'',p.address||'',p.facebook||'',p.instagram||'',p.linkedin||'',p.context||'',p.contractSigned?'Da':'Nu',p.contractLink||'',p.rating||0,p.notes||''];
      for (let i=0; i<maxC; i++) { const c=(p.contacts||[])[i]; row.push(c?c.name||'':'',c?c.role||'':'',c?c.phone||'':'',c?c.email||'':'',c?c.ielRelation||'':''); }
      return row;
    });

    const today = new Date().toISOString().split('T')[0];
    const tabName = `Export ${today}`;

    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const existing = meta.data.sheets.find(s => s.properties.title === tabName);
    const requests = [];
    if (existing) requests.push({ deleteSheet: { sheetId: existing.properties.sheetId } });
    requests.push({ addSheet: { properties: { title: tabName } } });

    const updateRes = await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
    const newSheetGid = updateRes.data.replies.find(r=>r.addSheet).addSheet.properties.sheetId;

    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${tabName}!A1`, valueInputOption: 'RAW', requestBody: { values: [header, ...rows] } });

    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ repeatCell: { range: { sheetId: newSheetGid, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true, foregroundColor: { red:1,green:1,blue:1 } }, backgroundColor: { red:0.059,green:0.722,blue:0.761 } } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } }] } });

    return { statusCode: 200, headers, body: JSON.stringify({ url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${newSheetGid}` }) };
  } catch(e) {
    console.error('Export error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
