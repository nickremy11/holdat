// Thin D1 helpers shared by the auth and importer routes. Plain module, no
// onRequest* export, so Pages routing doesn't register it as a route (same
// underscore-prefix convention as _middleware.js).

export async function all(db, sql, ...params) {
  const res = await db.prepare(sql).bind(...params).all();
  return res.results ?? [];
}

export async function first(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

export async function run(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}

// Natural-key upsert: INSERT ... ON CONFLICT(keyCols) DO UPDATE SET the rest,
// returning the row's id. Every importer write goes through this so re-running
// the importer for any season is always safe. keyCols must be covered by a
// UNIQUE constraint/index on `table` (see migrations/). `immutableCols`
// (e.g. `created_at`) are included in the INSERT but left out of the UPDATE
// SET clause, so they aren't clobbered by a later re-import.
export async function upsert(db, table, keyCols, data, immutableCols = [], returningCol = 'id') {
  const cols = Object.keys(data);
  const placeholders = cols.map(() => '?').join(', ');
  const updateCols = cols.filter((c) => !keyCols.includes(c) && !immutableCols.includes(c));
  const updateClause = updateCols.length
    ? updateCols.map((c) => `${c} = excluded.${c}`).join(', ')
    : keyCols.map((c) => `${c} = ${table}.${c}`).join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(${keyCols.join(', ')}) DO UPDATE SET ${updateClause}
    RETURNING ${returningCol}`;
  const row = await first(db, sql, ...cols.map((c) => data[c]));
  return row?.[returningCol] ?? null;
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
