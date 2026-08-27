import { bytesToBase64Url, MAX_ARTICLE_PATH_BYTES, MAX_HOST_CONTEXT_BYTES, sha256 } from '@staticlayer/protocol';
import type { Env } from './env.ts';
import { json, validField } from './http.ts';
import { verifyVoterToken } from './polls.ts';

/**
 * GET /api/comments?article_path=...&host_context=...&voterToken=...
 *
 * Public, read-only. Returns only `status = 'approved'` comments for the
 * article, as plain text fields, with `parent_id` for nested replies, a
 * `pinned` flag, and an anonymous `votes` count (comment likes). When a valid
 * `voterToken` is supplied (the browser's anonymous like token), each comment
 * also reports `voted: true` for the ones this browser already liked. A reply
 * is included when its parent is approved OR no longer exists (deleted); a
 * reply whose parent is still pending is hidden. Cacheable for 60s and NEVER
 * sets a cookie.
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

  const voterToken = url.searchParams.get('voterToken') ?? '';
  const voterId = voterToken ? await verifyVoterToken(voterToken, env) : null;
  const voterHash = voterId ? bytesToBase64Url(await sha256(voterId)) : null;

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.nickname, c.body, c.created_at, c.parent_id, c.is_owner, c.pinned,
            (SELECT COUNT(*) FROM comment_votes v WHERE v.comment_id = c.id) AS votes
     FROM comments c
     WHERE c.article_path = ? AND c.status = ?
       AND (c.parent_id IS NULL
            OR EXISTS (SELECT 1 FROM comments p WHERE p.id = c.parent_id AND p.status = 'approved')
            OR NOT EXISTS (SELECT 1 FROM comments p WHERE p.id = c.parent_id))
     ORDER BY c.pinned DESC, c.created_at ASC
     LIMIT 500`,
  )
    .bind(articlePath, 'approved')
    .all<{ id: string; nickname: string; body: string; created_at: number; parent_id: string | null; is_owner: number; pinned: number; votes: number }>();

  // Anonymous "already liked" set for this browser (only when a token is sent).
  let votedIds = new Set<string>();
  if (voterHash) {
    const votedRows = await env.DB.prepare(
      'SELECT comment_id FROM comment_votes WHERE voter_hash = ?',
    ).bind(voterHash).all<{ comment_id: string }>();
    votedIds = new Set(votedRows.results.map((r) => r.comment_id));
  }

  const comments = results.map((c) => ({
    id: c.id,
    nickname: c.nickname,
    body: c.body,
    created_at: c.created_at,
    parent_id: c.parent_id,
    is_owner: c.is_owner === 1,
    pinned: c.pinned === 1,
    votes: Number(c.votes) || 0,
    voted: votedIds.has(c.id),
  }));

  return json({ comments }, 200, { 'cache-control': 'public, max-age=60' });
}
