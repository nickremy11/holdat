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

// D1 statement batches (db.batch([...])) execute as ONE subrequest no matter
// how many statements they carry, vs. one subrequest per await'd call --
// which is what blew through Cloudflare's per-invocation subrequest limit
// when the importer did one upsert() per player/pick/trade-leg. Everything
// below builds arrays of bound statements and fires them in chunked batches
// instead. CHUNK caps statements per batch() call defensively (D1 batches
// have their own size limits); it's not about subrequest count, since a
// 300-statement batch and a 3-statement batch both cost one subrequest --
// it's here so one enormous batch (e.g. a 22-round startup draft) doesn't
// exceed D1's own per-batch limits.
const CHUNK = 75;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Same upsert semantics as upsert() above, but for many rows at once. All
// rows must share the same set of keys (same columns, values may be null).
// Returns the returningCol value for each row, in input order.
export async function batchUpsert(db, table, keyCols, rows, immutableCols = [], returningCol = 'id') {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  const placeholders = cols.map(() => '?').join(', ');
  const updateCols = cols.filter((c) => !keyCols.includes(c) && !immutableCols.includes(c));
  const updateClause = updateCols.length
    ? updateCols.map((c) => `${c} = excluded.${c}`).join(', ')
    : keyCols.map((c) => `${c} = ${table}.${c}`).join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(${keyCols.join(', ')}) DO UPDATE SET ${updateClause}
    RETURNING ${returningCol}`;
  const stmt = db.prepare(sql);

  const out = [];
  for (const part of chunk(rows, CHUNK)) {
    const bound = part.map((row) => stmt.bind(...cols.map((c) => row[c])));
    const results = await db.batch(bound);
    for (const r of results) out.push(r.results?.[0]?.[returningCol] ?? null);
  }
  return out;
}

// Plain INSERT (no natural key to conflict on -- e.g. a new franchise),
// batched. Returns the returningCol value for each row, in input order.
export async function batchInsert(db, table, rows, returningCol = 'id') {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING ${returningCol}`;
  const stmt = db.prepare(sql);

  const out = [];
  for (const part of chunk(rows, CHUNK)) {
    const bound = part.map((row) => stmt.bind(...cols.map((c) => row[c])));
    const results = await db.batch(bound);
    for (const r of results) out.push(r.results?.[0]?.[returningCol] ?? null);
  }
  return out;
}

// Runs the same parameterized SQL for many param tuples in batches (e.g. the
// trade_legs INSERT ... ON CONFLICT DO NOTHING, which has no useful RETURNING
// value to collect).
export async function batchRun(db, sql, rowsOfParams) {
  if (!rowsOfParams.length) return;
  const stmt = db.prepare(sql);
  for (const part of chunk(rowsOfParams, CHUNK)) {
    await db.batch(part.map((params) => stmt.bind(...params)));
  }
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
