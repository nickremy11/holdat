// Cloudflare Pages Function — GET /api/auth/invite-info?token=...
//
// Read-only, public: lets claim.html preview "you're claiming {team}" before
// the visitor commits anything. Does not consume the invite.

import { json, first } from '../../_lib/db.js';
import { hashToken } from '../../_lib/auth.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return json({ error: 'DB is not configured on this Pages project.' }, 500);

  const token = new URL(request.url).searchParams.get('token');
  if (!token) return json({ error: 'token is required.' }, 400);

  const row = await first(
    env.DB,
    `SELECT fi.email, f.name AS franchise_name
     FROM franchise_invites fi
     JOIN franchises f ON f.id = fi.franchise_id
     WHERE fi.token_hash = ? AND fi.consumed_at IS NULL AND fi.expires_at > ?`,
    await hashToken(token),
    Date.now()
  );
  if (!row) return json({ error: 'This invite link is invalid or has expired.' }, 404);

  return json({ email: row.email, franchiseName: row.franchise_name });
}
