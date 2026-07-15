// Cloudflare Pages Function — POST /api/commissioner/settings-divisions
//
// { divisions: [{name, teamIds}] } for the active season. Wipes and
// rewrites divisions + teams.division_id wholesale each save (nothing else
// references divisions yet -- no schedule/matchups exist until the
// follow-up schedule-generation phase), rather than diffing by id.

import { json, all, run, batchInsert, getActiveSeasonId } from '../../_lib/db.js';
import { getCommissionerSession } from '../../_lib/auth.js';

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

  const divisions = Array.isArray(body?.divisions) ? body.divisions : [];
  for (const d of divisions) {
    if (!d?.name || !String(d.name).trim()) return json({ error: 'Every division needs a name.' }, 400);
  }

  const seasonId = await getActiveSeasonId(env.DB);
  if (!seasonId) return json({ error: 'No active season is configured.' }, 500);

  const seasonTeams = await all(env.DB, 'SELECT id FROM teams WHERE season_id = ?', seasonId);
  const validTeamIds = new Set(seasonTeams.map((t) => t.id));

  if (divisions.length > 0 && seasonTeams.length % divisions.length !== 0) {
    return json({ error: `${divisions.length} divisions does not evenly divide ${seasonTeams.length} teams.` }, 400);
  }

  const seenTeamIds = new Set();
  for (const d of divisions) {
    for (const tid of d.teamIds || []) {
      if (!validTeamIds.has(tid)) return json({ error: `Team ${tid} is not part of the active season.` }, 400);
      if (seenTeamIds.has(tid)) return json({ error: `Team ${tid} is assigned to more than one division.` }, 400);
      seenTeamIds.add(tid);
    }
  }

  await run(env.DB, 'UPDATE teams SET division_id = NULL WHERE season_id = ?', seasonId);
  await run(env.DB, 'DELETE FROM divisions WHERE season_id = ?', seasonId);

  const divisionIds = await batchInsert(
    env.DB,
    'divisions',
    divisions.map((d, i) => ({ season_id: seasonId, name: String(d.name).trim(), display_order: i }))
  );

  for (let i = 0; i < divisions.length; i++) {
    const teamIds = divisions[i].teamIds || [];
    if (!teamIds.length) continue;
    await run(
      env.DB,
      `UPDATE teams SET division_id = ? WHERE id IN (${teamIds.map(() => '?').join(',')})`,
      divisionIds[i],
      ...teamIds
    );
  }

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
