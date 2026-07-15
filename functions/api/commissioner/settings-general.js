// Cloudflare Pages Function — POST /api/commissioner/settings-general
//
// { leagueName, scoringType, categories } -- league name + scoring system
// for the active season. categories is ignored (all existing rows cleared)
// when scoringType is 'h2h_points', per the spec (N/A until points scoring
// is defined).

import { json, first, run, batchUpsert, getActiveSeasonId } from '../../_lib/db.js';
import { getCommissionerSession } from '../../_lib/auth.js';
import { CATS, LOWER_BETTER } from '../fantrax.js';

const RATE_CATS = new Set(['FG%', 'FT%']);
const SCORING_TYPES = ['rotisserie', 'h2h_points', 'h2h_categories'];

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

  const leagueName = String(body?.leagueName || '').trim();
  const scoringType = body?.scoringType;
  const categories = Array.isArray(body?.categories) ? body.categories : [];

  if (!leagueName) return json({ error: 'leagueName is required.' }, 400);
  if (!SCORING_TYPES.includes(scoringType)) {
    return json({ error: `scoringType must be one of: ${SCORING_TYPES.join(', ')}.` }, 400);
  }
  const invalidCodes = categories.filter((c) => !CATS.includes(c));
  if (invalidCodes.length) return json({ error: `Unknown category codes: ${invalidCodes.join(', ')}` }, 400);

  const seasonId = await getActiveSeasonId(env.DB);
  if (!seasonId) return json({ error: 'No active season is configured.' }, 500);

  const league = await first(env.DB, 'SELECT id FROM leagues LIMIT 1');
  if (league) await run(env.DB, 'UPDATE leagues SET name = ? WHERE id = ?', leagueName, league.id);

  await run(env.DB, 'UPDATE season_settings SET scoring_type = ? WHERE season_id = ?', scoringType, seasonId);

  if (scoringType === 'h2h_points' || !categories.length) {
    await run(env.DB, 'DELETE FROM scoring_categories WHERE season_id = ?', seasonId);
  } else {
    await run(
      env.DB,
      `DELETE FROM scoring_categories WHERE season_id = ? AND code NOT IN (${categories.map(() => '?').join(',')})`,
      seasonId,
      ...categories
    );
    await batchUpsert(
      env.DB,
      'scoring_categories',
      ['season_id', 'code'],
      categories.map((code, i) => ({
        season_id: seasonId,
        code,
        display_order: i,
        category_type: RATE_CATS.has(code) ? 'rate' : 'counting',
        lower_is_better: LOWER_BETTER.has(code) ? 1 : 0,
      }))
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
