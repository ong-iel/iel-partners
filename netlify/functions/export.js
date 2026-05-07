cat > ~/iel-partners/netlify/functions/export.js << 'ENDOFFILE'
const { google } = require('googleapis');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const auth = new google.auth.JWT(
      process.env.GOOGLE_CLIENT_EMAIL, null,
      process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    const sheets = google.sheets({ version: 'v4', auth });
    const sheetId = process.env.GOOGLE_SHEET_ID;

    // Read current data
    const read = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'ParteneriDB!A:A'
    });
    const json = (read.data.values||[]).map(r=>r[0]).join('');
    const { partners } = JSON.parse(json);

    // Max contacts
    const maxC = Math.max(...partners.map(p=>(p.contacts||[]).length), 0);

    // Header
    const header = [
      'Categorie','Subcategorie','Nume','Website','Email','Telefon',
      'Adresa','Facebook','Instagram','LinkedIn','Context colaborare',
      'Contract semnat','Link contract','Rating','Note'
    ];
    for (let i=1; i<=maxC; i++) {
      header.push(
        `Contact ${i} - Nume`, `Contact ${i} - Rol`,
        `Contact ${i} - Telefon`, `Contact ${i} - Email`,
        `Contact ${i} - Relatie iEL`
      );
    }

    // Rows
    const rows = partners.map(p => {
      const row = [
        p.category||'', p.subcategory||'', p.name||'', p.website||'',
        p.email||'', p.phone||'', p.address||'', p.facebook||'',
        p.instagram||'', p.linkedin||'', p.context||'',
        p.contractSigned ? 'Da' : 'Nu', p.contractLink||'',
        p.rating||0, p.notes||''
      ];
      for (let i=0; i<maxC; i++) {
        const c = (p.contacts||[])[i];
        row.push(
          c ? c.name||'' : '', c ? c.role||'' : '',
          c ? c.phone||'' : '', c ? c.email||'' : '',
          c ? c.ielRelation||'' : ''
        );
      }
      return row;
    });

    // Create new tab name with today's date
    const today = new Date().toISOString().split('T')[0];
    const tabName = `Export ${today}`;

    // Delete existing tab with same name if it exists
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const existing = meta.data.sheets.find(s => s.properties.title === tabName);

    const requests = [];
    if (existing) {
      requests.push({ deleteSheet: { sheetId: existing.properties.sheetId } });
    }
    requests.push({ addSheet: { properties: { title: tabName } } });

    const updateRes = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests }
    });

    // Get the new sheet's id for formatting
    const newSheetMeta = updateRes.data.replies.find(r => r.addSheet);
    const newSheetGid = newSheetMeta.addSheet.properties.sheetId;

    // Write data
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header, ...rows] }
    });

    // Bold + teal header
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{
        repeatCell: {
          range: { sheetId: newSheetGid, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: {
            textFormat: { bold: true, foregroundColor: { red:1, green:1, blue:1 } },
            backgroundColor: { red:0.059, green:0.722, blue:0.761 }
          }},
          fields: 'userEnteredFormat(textFormat,backgroundColor)'
        }
      }]}
    });

    // Return link directly to the new tab
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${newSheetGid}`;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    };
  } catch(e) {
    console.error('Export error:', e);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message })
    };
  }
};
ENDOFFILE
