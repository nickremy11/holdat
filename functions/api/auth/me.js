// Cloudflare Pages Function — GET /api/auth/me
//
// Returns { user, franchise } for the current session, or 401. Every future
// write endpoint (lineups, trades, free agency) reuses this same
// getSession()/canActOnFranchise() pair to authorize "you can only act on
// your own team".

import { json } from '../../_lib/db.js';
import { getSession } from '../../_lib/auth.js';

export async function onRequestGet(context) {
  if (!context.env.DB) return json({ error: 'DB is not configured on this Pages project.' }, 500);

  const session = await getSession(context);
  if (!session) return json({ error: 'Not logged in.', code: 'NOT_AUTHENTICATED' }, 401);

  return json(session);
}
