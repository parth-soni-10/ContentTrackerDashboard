const sheets = require('./lib/sheets');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, stale-while-revalidate=300' },
  body: JSON.stringify(body)
});

exports.handler = async event => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  if (!sheets.sheetsEnabled()) return json(500, { error: 'Data service is not configured' });

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
};
