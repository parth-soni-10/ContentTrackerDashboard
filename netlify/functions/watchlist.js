const sheets = require('./lib/sheets');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, stale-while-revalidate=300' },
  body: JSON.stringify(body)
});

exports.handler = async event => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  // Direct Sheets API mode (see lib/sheets.js). Falls back to Apps Script
  // below until GOOGLE_SERVICE_ACCOUNT_JSON + SPREADSHEET_ID are configured.
  if (sheets.sheetsEnabled()) {
    const isGoalRead = event.queryStringParameters?.goal === '1';
    try {
      if (isGoalRead) {
        const goal = await sheets.readGoal();
        return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(goal) };
      }
      const sheetName = event.queryStringParameters?.sheet === 'Suggestions' ? 'Suggestions' : 'Data';
      const { rows } = await sheets.readSheet(sheetName, sheetName !== 'Data');
      return json(200, rows);
    } catch (error) {
      console.error('Sheets API read failed:', error);
      return json(502, { error: error.message || 'Unable to load data' });
    }
  }

  const scriptUrl = process.env.SCRIPT_URL;
  if (!scriptUrl) return json(500, { error: 'Data service is not configured' });

  // Small settings reads (the yearly goal) are served from Apps Script Script
  // Properties, not the sheet — cheap, and answered without the CDN cache so
  // a goal set on one device shows up promptly on the others.
  const isGoalRead = event.queryStringParameters?.goal === '1';
  let target;
  try {
    target = new URL(scriptUrl);
    if (event.queryStringParameters?.sheet === 'Suggestions') {
      target.searchParams.set('sheet', 'Suggestions');
    }
    if (isGoalRead) {
      target.searchParams.set('goal', '1');
    }
  } catch {
    return json(500, { error: 'Data service URL is invalid' });
  }

  // Google's content CDN occasionally answers with a fast 404 (or drops the
  // JSON body) right after an Apps Script redeploy or on a cold start. The
  // read is idempotent, so one retry after a short pause clears that.
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const upstream = await fetch(target, { redirect: 'follow' });
      const body = await upstream.text();
      const healthy = upstream.status === 200 && /^(\s*[\[{\"])/.test(body.trim());
      if (!healthy && attempt === 1) {
        console.warn('Data service returned a transient response, retrying:', { status: upstream.status, attempt });
        await sleep(800);
        continue;
      }
      return {
        statusCode: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': isGoalRead ? 'no-store' : 'public, max-age=300, stale-while-revalidate=300' },
        body
      };
    } catch {
      if (attempt === 1) { await sleep(800); continue; }
      return json(502, { error: 'Unable to load data' });
    }
  }
};
