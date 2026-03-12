const { google } = require('googleapis');

// ── CONFIG ──────────────────────────────────────────────────────────────────
// These values come from Netlify environment variables (never hardcode them!)
const SHEET_ID    = process.env.GOOGLE_SHEET_ID;      // the long ID from the Sheet URL
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL; // service account email
const PRIVATE_KEY  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const SHEET_TAB   = 'ParteneriDB';                    // name of the tab in your Sheet

// ── AUTH ─────────────────────────────────────────────────────────────────────
function getAuth() {
  return new google.auth.JWT(CLIENT_EMAIL, null, PRIVATE_KEY, [
    'https://www.googleapis.com/auth/spreadsheets'
  ]);
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
// We store the entire partners array as a single JSON blob in cell A1 of the tab.
// Simple, robust, and requires zero schema management.

async function readPartners(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1`,
  });
  const raw = res.data.values?.[0]?.[0];
  if (!raw) return [];
  return JSON.parse(raw);
}

async function writePartners(sheets, partners) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [[JSON.stringify(partners)]] },
  });
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const auth   = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // ── GET: load all partners ──
    if (event.httpMethod === 'GET') {
      const partners = await readPartners(sheets);
      return { statusCode: 200, headers, body: JSON.stringify({ partners }) };
    }

    // ── POST: save all partners ──
    if (event.httpMethod === 'POST') {
      const { partners } = JSON.parse(event.body);
      if (!Array.isArray(partners)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid data' }) };
      }
      await writePartners(sheets, partners);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
