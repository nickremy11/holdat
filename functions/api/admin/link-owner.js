// Cloudflare Pages Function — POST /api/admin/link-owner?token=...
//
// One-time commissioner tool: seeds a users row for a real owner (natural-key
// upsert on email, safe to re-run) and links it to their franchise. Same
// token gate + upsert() helper as import.js. Run once per owner (14 times).
//
// Body: { franchiseId, email, displayName, isCommissioner? }

import { json, first, upsert, run } from '../../_lib/db.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!env.ADMIN_IMPORT_TOKEN || token !== env.ADMIN_IMPORT_TOKEN) {
    return json({ error: 'Invalid or missing admin token.' }, 403);
  }
  if (!env.DB) return json({ error: 'DB is not configured on this Pages project.' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const franchiseId = parseInt(body?.franchiseId, 10);
  const email = String(body?.email || '').trim().toLowerCase();
  const displayName = String(body?.displayName || '').trim();
  const isCommissioner = body?.isCommissioner ? 1 : 0;

  if (!franchiseId) return json({ error: 'franchiseId is required.' }, 400);
  if (!email) return json({ error: 'email is required.' }, 400);
  if (!displayName) return json({ error: 'displayName is required.' }, 400);

  const franchise = await first(env.DB, 'SELECT id FROM franchises WHERE id = ?', franchiseId);
  if (!franchise) return json({ error: `No franchise with id ${franchiseId}.` }, 404);

  const userId = await upsert(
    env.DB,
    'users',
    ['email'],
    { email, display_name: displayName, is_commissioner: isCommissioner, created_at: Date.now() },
    ['created_at']
  );

  await run(env.DB, 'UPDATE franchises SET owner_user_id = ? WHERE id = ?', userId, franchiseId);

  return json({ ok: true, userId, franchiseId });
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
