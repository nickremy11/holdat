// Cloudflare Pages Function — POST /api/commissioner/settings-roster
//
// { rosterSize, benchSlots, irSlots, taxiSlots, startingSlots: [{code,
// label, eligiblePositions, count}], allowIllegalResult,
// allowLineupChangesWhileIllegal, allowPlayerAddsWhileIllegal }
//
// Replaces the active season's lineup_slots wholesale (starters from
// startingSlots + one bench/ir/taxi row each) -- simpler and safer than
// diffing, and this endpoint is the only writer of lineup_slots at this
// stage (no roster/lineup-editing UI exists yet to depend on slot ids
// surviving a save).

import { json, run, batchInsert, getActiveSeasonId } from '../../_lib/db.js';
import { getCommissionerSession } from '../../_lib/auth.js';

function toInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return json({ error: 'DB is not configured on this Pages project.' }, 500);

  const session = await getCommissionerSession(context);
  if (!session) return json({ error: 'Commissioners only.' }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const startingSlots = Array.isArray(body?.startingSlots) ? body.startingSlots : [];
  for (const s of startingSlots) {
    if (!s?.code || !s?.label) return json({ error: 'Each startingSlot needs a code and label.' }, 400);
  }

  const seasonId = await getActiveSeasonId(env.DB);
  if (!seasonId) return json({ error: 'No active season is configured.' }, 500);

  const rosterSize = toInt(body?.rosterSize, null);
  const benchSlots = toInt(body?.benchSlots, 0);
  const irSlots = toInt(body?.irSlots, 0);
  const taxiSlots = toInt(body?.taxiSlots, 0);

  await run(
    env.DB,
    `UPDATE season_settings SET roster_size = ?, bench_slots = ?, ir_slots = ?, taxi_slots = ?,
       allow_illegal_result = ?, allow_lineup_changes_while_illegal = ?, allow_player_adds_while_illegal = ?
     WHERE season_id = ?`,
    rosterSize,
    benchSlots,
    irSlots,
    taxiSlots,
    body?.allowIllegalResult ? 1 : 0,
    body?.allowLineupChangesWhileIllegal ? 1 : 0,
    body?.allowPlayerAddsWhileIllegal ? 1 : 0,
    seasonId
  );

  await run(env.DB, 'DELETE FROM lineup_slots WHERE season_id = ?', seasonId);

  const rows = startingSlots.map((s, i) => ({
    season_id: seasonId,
    code: s.code,
    label: s.label,
    slot_type: 'starter',
    eligible_positions: s.eligiblePositions || null,
    count: toInt(s.count, 0),
    display_order: i,
  }));
  rows.push(
    { season_id: seasonId, code: 'BENCH', label: 'Bench', slot_type: 'bench', eligible_positions: null, count: benchSlots, display_order: rows.length },
    { season_id: seasonId, code: 'IR', label: 'IR', slot_type: 'ir', eligible_positions: null, count: irSlots, display_order: rows.length + 1 },
    { season_id: seasonId, code: 'TAXI', label: 'Taxi Squad', slot_type: 'taxi', eligible_positions: null, count: taxiSlots, display_order: rows.length + 2 }
  );
  await batchInsert(env.DB, 'lineup_slots', rows);

  return json({ ok: true });
}

export function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
