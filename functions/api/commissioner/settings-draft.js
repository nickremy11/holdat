// Cloudflare Pages Function — POST /api/commissioner/settings-draft
//
// { nextDraftAt, rounds, pickTimeLimitHours, timeoutBehavior,
// undraftedBecomes } for the active season. nextDraftAt is optional (spec:
// "does not have to be set") and expected as epoch milliseconds or null.

import { json, run, getActiveSeasonId } from '../../_lib/db.js';
import { getCommissionerSession } from '../../_lib/auth.js';

const TIMEOUT_BEHAVIORS = ['auto_pick', 'pause'];
const UNDRAFTED_OPTIONS = ['free_agent', 'waivers'];

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

  const rounds = parseInt(body?.rounds, 10);
  const pickTimeLimitHours = parseInt(body?.pickTimeLimitHours, 10);
  const nextDraftAt = body?.nextDraftAt != null ? parseInt(body.nextDraftAt, 10) : null;

  if (!Number.isFinite(rounds) || rounds < 1 || rounds > 4) return json({ error: 'rounds must be between 1 and 4.' }, 400);
  if (!Number.isFinite(pickTimeLimitHours) || pickTimeLimitHours < 1) return json({ error: 'pickTimeLimitHours must be a positive number.' }, 400);
  if (!TIMEOUT_BEHAVIORS.includes(body?.timeoutBehavior)) {
    return json({ error: `timeoutBehavior must be one of: ${TIMEOUT_BEHAVIORS.join(', ')}.` }, 400);
  }
  if (!UNDRAFTED_OPTIONS.includes(body?.undraftedBecomes)) {
    return json({ error: `undraftedBecomes must be one of: ${UNDRAFTED_OPTIONS.join(', ')}.` }, 400);
  }

  const seasonId = await getActiveSeasonId(env.DB);
  if (!seasonId) return json({ error: 'No active season is configured.' }, 500);

  await run(
    env.DB,
    `UPDATE season_settings SET draft_next_at = ?, draft_rounds = ?, draft_pick_time_limit_hours = ?,
       draft_timeout_behavior = ?, draft_undrafted_becomes = ?
     WHERE season_id = ?`,
    nextDraftAt,
    rounds,
    pickTimeLimitHours,
    body.timeoutBehavior,
    body.undraftedBecomes,
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
