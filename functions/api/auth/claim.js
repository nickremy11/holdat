// Cloudflare Pages Function — POST /api/auth/claim
//
// Exchanges a valid franchise invite for an account: creates/updates the
// users row (natural-key upsert on email, is_commissioner always 0 -- only
// the admin/link-owner bootstrap tool grants that), links the franchise,
// marks the invite consumed, and logs the visitor in immediately.

import { json, first, run, upsert } from '../../_lib/db.js';
import { hashToken, createSession, cookieHeader } from '../../_lib/auth.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return json({ error: 'DB is not configured on this Pages project.' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const token = String(body?.token || '');
  const displayName = String(body?.displayName || '').trim();
  if (!token) return json({ error: 'token is required.' }, 400);
  if (!displayName) return json({ error: 'displayName is required.' }, 400);

  const now = Date.now();
  const invite = await first(
    env.DB,
    'SELECT id, franchise_id, email FROM franchise_invites WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?',
    await hashToken(token),
    now
  );
  if (!invite) return json({ error: 'This invite link is invalid or has expired.' }, 400);

  const userId = await upsert(
    env.DB,
    'users',
    ['email'],
    { email: invite.email, display_name: displayName, is_commissioner: 0, created_at: now },
    ['created_at']
  );

  await run(env.DB, 'UPDATE franchises SET owner_user_id = ? WHERE id = ?', userId, invite.franchise_id);
  await run(env.DB, 'UPDATE franchise_invites SET consumed_at = ? WHERE id = ?', now, invite.id);

  const sessionToken = await createSession(env.DB, userId);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookieHeader(sessionToken),
    },
  });
}
