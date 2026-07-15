// Cloudflare Pages Function — POST /api/commissioner/settings-waivers
//
// { waiverDays, maxClaimsPerWeek, moveToBack } for the active season.

import { json, run, getActiveSeasonId } from '../../_lib/db.js';
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

  const waiverDays = parseInt(body?.waiverDays, 10);
  const maxClaims = parseInt(body?.maxClaimsPerWeek, 10);
  if (!Number.isFinite(waiverDays) || waiverDays < 0) return json({ error: 'waiverDays must be a non-negative number.' }, 400);
  if (!Number.isFinite(maxClaims) || maxClaims < 1 || maxClaims > 10) return json({ error: 'maxClaimsPerWeek must be between 1 and 10.' }, 400);

  const seasonId = await getActiveSeasonId(env.DB);
  if (!seasonId) return json({ error: 'No active season is configured.' }, 500);

  await run(
    env.DB,
    'UPDATE season_settings SET waiver_days = ?, waiver_max_claims_per_week = ?, waiver_move_to_back = ? WHERE season_id = ?',
    waiverDays,
    maxClaims,
    body?.moveToBack ? 1 : 0,
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
