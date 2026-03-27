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
                  model: 'claude-haiku-4-5-20251001',
                  max_tokens: 8000,
                  messages: [{ role: 'user', content: prompt }],
          }),
    });
    if (!res.ok) throw new Error('Claude API error ' + res.status);
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

    const token = (event.headers['authorization'] || '').replace('Bearer ', '');
    if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No token' }) };
    try { await verifyToken(token); }
    catch (e) { return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) }; }

    const { sheetUrl } = JSON.parse(event.body || '{}');
    if (!sheetUrl) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No sheet URL provided' }) };

    const sheetId = extractSheetId(sheetUrl);
    if (!sheetId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid Google Sheet URL' }) };

    let rows;
    try {
          const auth = await getAuth();
          const sheets = google.sheets({ version: 'v4', auth });
          const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'A1:Z200' });
          rows = res.data.values || [];
    } catch (e) {
          const msg = e.message || '';
          if (msg.includes('403') || msg.includes('PERMISSION') || msg.includes('permission')) {
                  return { statusCode: 403, headers, body: JSON.stringify({ error: 'Sheet not accessible. Share it with iel-parteneri-bot@iel-parteneri.iam.gserviceaccount.com first.' }) };
          }
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not read sheet: ' + msg }) };
    }

    if (rows.length < 2) return { statusCode: 200, headers, body: JSON.stringify({ partners: [] }) };

    const headersRow = rows[0];
    const dataRows = rows.slice(1).filter(r => r.some(c => c && String(c).trim())).slice(0, 50);

    const prompt = `Import partner data into a CRM. Headers: ${JSON.stringify(headersRow)}. Rows: ${JSON.stringify(dataRows)}.
    Return ONLY a JSON array, no markdown, no explanation:
    [{"name":"institution name (skip if empty)","category":"one of: Liceu, Scoala, Centru, ONG, Partener, Media, Institutie Publica","subcategory":"","website":"","email":"","phone":"","address":"","facebook":"","instagram":"","linkedin":"","context":"","notes":"","contractSigned":false,"contractLink":"","rating":0,"contacts":[]}]
    Romanian headers: Denumire=name, Telefon=phone, Adresa=address, Site=website, Categorie=category, Observatii=notes. Return ONLY the JSON array.`;

    let mapped;
    try {
          const text = await callClaude(prompt);
          const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
          mapped = JSON.parse(clean);
    } catch (e) {
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'AI mapping failed: ' + e.message }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ partners: mapped, total: mapped.length }) };
};
