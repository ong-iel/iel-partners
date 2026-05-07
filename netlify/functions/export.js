const { google } = require('googleapis');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const auth = new google.auth.JWT(
      process.env.GOOGLE_CLIENT_EMAIL, null,
      process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets','https://www.googleapis.com/auth/drive']
    );
    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });

    // Read current data
    const read = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'ParteneriDB!A:A'
    });
    const json = (read.data.values||[]).map(r=>r[0]).join('');
    const { partners } = JSON.parse(json);

    // Max contacts across all partners
    const maxC = Math.max(...partners.map(p=>(p.contacts||[]).length), 0);

    // Header
    const header = [
      'Categorie','Subcategorie','Nume','Website','Email','Telefon',
      'Adresa','Facebook','Instagram','LinkedIn','Context colaborare',
      'Contract semnat','Link contract','Rating','Note'
    ];
    for (let i=1; i<=maxC; i++) {
      header.push(`Contact ${i} - Nume`,`Contact ${i} - Rol`,`Contact ${i} - Telefon`,`Contact ${i} - Email`,`Contact ${i} - Relatie iEL`);
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
        row.push(c ? c.name||'' : '', c ? c.role||'' : '', c ? c.phone||'' : '', c ? c.email||'' : '', c ? c.ielRelation||'' : '');
      }
      return row;
    });

    // Create new sheet
    const today = new Date().toISOString().split('T')[0];
    const created = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: `iEL Parteneri Export ${today}` },
        sheets: [{ properties: { title: 'Parteneri' } }]
      }
    });
    const newId = created.data.spreadsheetId;

    // Write data
    await sheets.spreadsheets.values.update({
      spreadsheetId: newId, range: 'Parteneri!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [header, ...rows] }
    });

    // Bold + color header row
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: newId,
      requestBody: { requests: [{
        repeatCell: {
          range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: {
            textFormat: { bold: true, foregroundColor: { red:1, green:1, blue:1 } },
            backgroundColor: { red:0.059, green:0.722, blue:0.761 }
          }},
          fields: 'userEnteredFormat(textFormat,backgroundColor)'
        }
      }]}
    });

    // Share with innoedulab.eu domain
    await drive.permissions.create({
      fileId: newId,
      requestBody: { type:'domain', role:'reader', domain:'innoedulab.eu' }
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: created.data.spreadsheetUrl })
    };
  } catch(e) {
    console.error('Export error:', e);
    return { statusCode: 500, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ error: e.message }) };
  }
};
