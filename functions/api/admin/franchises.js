// Cloudflare Pages Function — GET /api/admin/franchises?token=...
//
// Lists every franchise with its current owner-link status, so the
// commissioner can see at a glance which of the 14 still need an owner
// linked via POST /api/admin/link-owner. Same token gate as import.js.

import { json, all } from '../../_lib/db.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const token = new URL(request.url).searchParams.get('token');
  if (!env.ADMIN_IMPORT_TOKEN || token !== env.ADMIN_IMPORT_TOKEN) {
    return json({ error: 'Invalid or missing admin token.' }, 403);
  }
  if (!env.DB) return json({ error: 'DB is not configured on this Pages project.' }, 500);

  const franchises = await all(
    env.DB,
    `SELECT f.id, f.name, u.email, u.display_name, u.is_commissioner
     FROM franchises f
     LEFT JOIN users u ON u.id = f.owner_user_id
     ORDER BY f.name`
  );

  return json({ franchises });
}
