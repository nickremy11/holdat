// Cloudflare Pages Function — GET /api/auth/verify?token=...
//
// Exchanges a valid, unexpired, unconsumed magic-link token for a session:
// sets the session cookie and redirects to /.

import { json } from '../../_lib/db.js';
import { consumeMagicLinkToken, cookieHeader } from '../../_lib/auth.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return json({ error: 'DB is not configured on this Pages project.' }, 500);

  const token = new URL(request.url).searchParams.get('token');
  if (!token) return json({ error: 'token is required.' }, 400);

  const sessionToken = await consumeMagicLinkToken(env.DB, token);
  if (!sessionToken) {
    return new Response(null, { status: 302, headers: { Location: '/login?error=expired' } });
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': cookieHeader(sessionToken),
    },
  });
}
