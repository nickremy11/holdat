// Cloudflare Pages Function — POST /api/commissioner/settings-schedule
//
// { seasonStartDate, regularSeasonWeeks, playoffWeeks, playoffByes,
// byeCriteria, firstRoundStructure } for the active season. Parameters
// only -- no schedule/matchups are generated here (separate follow-up).

import { json, run, getActiveSeasonId } from '../../_lib/db.js';
import { getCommissionerSession } from '../../_lib/auth.js';

const BYE_CRITERIA = ['top2_overall', 'division_winners', 'manual'];
const FIRST_ROUND_STRUCTURES = ['division_2v3', 'non_division_winner_vs_6_and_4v5'];

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

  const seasonStartDate = parseInt(body?.seasonStartDate, 10);
  const regularSeasonWeeks = parseInt(body?.regularSeasonWeeks, 10);
  const playoffWeeks = parseInt(body?.playoffWeeks, 10);
  const playoffByes = parseInt(body?.playoffByes, 10);

  if (!Number.isFinite(seasonStartDate)) return json({ error: 'seasonStartDate is required.' }, 400);
  if (!Number.isFinite(regularSeasonWeeks) || regularSeasonWeeks < 1) return json({ error: 'regularSeasonWeeks must be a positive number.' }, 400);
  if (!Number.isFinite(playoffWeeks) || playoffWeeks < 1 || playoffWeeks > 4) return json({ error: 'playoffWeeks must be between 1 and 4.' }, 400);
  if (!Number.isFinite(playoffByes) || playoffByes < 0) return json({ error: 'playoffByes must be a non-negative number.' }, 400);
  if (!BYE_CRITERIA.includes(body?.byeCriteria)) return json({ error: `byeCriteria must be one of: ${BYE_CRITERIA.join(', ')}.` }, 400);
  if (!FIRST_ROUND_STRUCTURES.includes(body?.firstRoundStructure)) {
    return json({ error: `firstRoundStructure must be one of: ${FIRST_ROUND_STRUCTURES.join(', ')}.` }, 400);
  }

  const seasonId = await getActiveSeasonId(env.DB);
  if (!seasonId) return json({ error: 'No active season is configured.' }, 500);

  await run(
    env.DB,
    `UPDATE season_settings SET season_start_date = ?, regular_season_weeks = ?, playoff_weeks = ?,
       playoff_byes = ?, playoff_bye_criteria = ?, playoff_first_round_structure = ?
     WHERE season_id = ?`,
    seasonStartDate,
    regularSeasonWeeks,
    playoffWeeks,
    playoffByes,
    body.byeCriteria,
    body.firstRoundStructure,
    seasonId
  );

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
