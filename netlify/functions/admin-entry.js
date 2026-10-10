const db = require('./lib/db');
const { validSession } = require('./lib/session');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

const clean = (value, max) => String(value || '').trim().slice(0, max);

async function handleDirect(body, action, id) {
  try {
    if (action === 'delete') {
      if (!Number.isInteger(id)) return json(400, { error: 'A valid entry id is required' });
      const deleted = await db.deleteEntry(id);
      // An id that matches nothing means the entry moved or was already removed
      // — in the sheet that could not happen, because the write addressed a
      // physical row; here it is worth saying so instead of reporting success.
      if (!deleted) return json(404, { error: 'That entry no longer exists', code: 'ENTRY_MISSING' });
      return json(200, { rowNumber: deleted });
    }
    const entry = {
      name: clean(body.name, 160),
      season: clean(body.season, 20),
      type: clean(body.type, 30),
      genre: clean(body.genre, 80),
      platform: clean(body.platform, 80),
      episodes: Number.isFinite(Number(body.episodes)) ? Math.max(0, Math.min(9999, Number(body.episodes))) : 0,
      screentime: Number.isFinite(Number(body.screentime)) ? Math.max(0, Math.min(100000, Number(body.screentime))) : 0,
      watchDate: clean(body.watchDate, 40)
    };
    if (!entry.name || !['Movie', 'Series/Show'].includes(entry.type)) {
      return json(400, { error: 'Name and a valid type are required' });
    }
    const isUpdate = action === 'update';
    if (isUpdate && !Number.isInteger(id)) return json(400, { error: 'A valid entry id is required' });

    if (isUpdate) {
      const updated = await db.updateEntry(id, entry);
      if (!updated) return json(404, { error: 'That entry no longer exists', code: 'ENTRY_MISSING' });
      return json(200, { duplicate: false, rowNumber: updated });
    }
    // The duplicate check runs inside the insert, under a lock on the title, so
    // the same watch cannot be logged twice by two submissions arriving together.
    const created = await db.createEntry(entry);
    if (created.duplicate) return json(200, { duplicate: true, rowNumber: created.duplicate });
    return json(200, { duplicate: false, rowNumber: created.id });
  } catch (error) {
    console.error('Entry write failed:', error);
    return json(502, { error: error.message || 'Unable to save entry', code: 'DB_ERROR' });
  }
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!validSession(event)) return json(401, { error: 'Admin session required', code: 'SESSION_INVALID' });
  if (!db.dbEnabled()) return json(500, { error: 'Admin service is not configured', code: 'CONFIG_MISSING' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request body' }); }

  // The cleanup card asks for the rows it lists before deleting any of them:
  // every entry the page shows has a watch date, so the undated, zero-time
  // leftovers are only reachable through this one read. Same session gate.
  if (body.action === 'invalid') {
    try {
      return json(200, { rows: await db.listInvalidEntries() });
    } catch (error) {
      console.error('Invalid-row scan failed:', error);
      return json(502, { error: error.message || 'Unable to scan for invalid rows', code: 'DB_ERROR' });
    }
  }

  // The same endpoint serves creating, updating and deleting entries; update and
  // delete also carry the id of the entry they act on (the page's `row` field).
  const action = body.action === 'delete' ? 'delete' : (body.action === 'update' ? 'update' : 'create');
  return handleDirect(body, action, Number(body.row));
};
