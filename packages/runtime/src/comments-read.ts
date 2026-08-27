import { MAX_ARTICLE_PATH_BYTES, MAX_HOST_CONTEXT_BYTES } from '@staticlayer/protocol';
import type { Env } from './env.ts';
import { json, validField } from './http.ts';

/**
 * GET /api/comments?article_path=...&host_context=...
 *
 * Public, read-only. Returns only `status = 'approved'` comments for the
 * article, as plain text fields, with `parent_id` for nested replies. A reply
 * is included when its parent is approved OR no longer exists (deleted); a
 * reply whose parent is still pending is hidden (its thread is not public
 * yet). Response is cacheable for 60s (`Cache-Control: public, max-age=60`)
 * and NEVER sets a cookie — no tracking.
 */
export async function handleListComments(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const articlePath = url.searchParams.get('article_path') ?? '';
  const hostContext = url.searchParams.get('host_context') ?? '';

  if (articlePath.length === 0) {
    return json({ error: 'article_path is required' }, 400);
  }
  if (!validField(articlePath, MAX_ARTICLE_PATH_BYTES)) {
    return json({ error: `article_path must be valid UTF-8 within ${MAX_ARTICLE_PATH_BYTES} bytes` }, 400);
  }
  if (hostContext.length > 0 && !validField(hostContext, MAX_HOST_CONTEXT_BYTES)) {
    return json({ error: `host_context must be valid UTF-8 within ${MAX_HOST_CONTEXT_BYTES} bytes` }, 400);
  }

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.nickname, c.body, c.created_at, c.parent_id, c.is_owner
     FROM comments c
     WHERE c.article_path = ? AND c.status = ?
       AND (c.parent_id IS NULL
            OR EXISTS (SELECT 1 FROM comments p WHERE p.id = c.parent_id AND p.status = 'approved')
            OR NOT EXISTS (SELECT 1 FROM comments p WHERE p.id = c.parent_id))
     ORDER BY c.created_at ASC
     LIMIT 500`,
  )
    .bind(articlePath, 'approved')
    .all();

  return json({ comments: results }, 200, { 'cache-control': 'public, max-age=60' });
}
