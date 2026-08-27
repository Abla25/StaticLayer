import type { Env } from './env.ts';
import { json, readJsonBody } from './http.ts';
import { requireAdmin, requireCsrf } from './auth.ts';

/**
 * Admin moderation API (Phase 2).
 *
 *   GET    /api/admin/comments?status=pending|approved|all   session required
 *   GET    /api/admin/articles                                session required
 *   PATCH  /api/admin/comments/:id   { status: approved|pending }  + CSRF
 *   DELETE /api/admin/comments/:id                              + CSRF
 *
 * CSRF: PATCH/DELETE require `X-CSRF-Token` matching the session-bound token
 * (constant-time), otherwise 403. All writes use prepared statements.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST_SELECT =
  'SELECT id, article_path, nickname, body, status, created_at FROM comments';

/**
 * Grouped overview of which pages have comments and reactions: article_path
 * with total, pending, approved comment counts plus a reactions count. Lets
 * the owner see every page that received activity, one Worker serving many
 * pages. Pages with reactions but no comments are included.
 */
export async function handleAdminListArticles(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;

  const { results } = await env.DB.prepare(
    `SELECT article_path,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved
     FROM comments
     GROUP BY article_path
     ORDER BY total DESC, article_path ASC
     LIMIT 200`,
  ).all<{ article_path: string; total: number; pending: number; approved: number }>();

  const reactionRows = await env.DB.prepare(
    `SELECT article_path, COUNT(*) AS reactions
     FROM reactions
     GROUP BY article_path`,
  ).all<{ article_path: string; reactions: number }>();

  const byPath = new Map<string, { article_path: string; total: number; pending: number; approved: number; reactions: number }>();
  for (const row of results) {
    byPath.set(row.article_path, { ...row, reactions: 0 });
  }
  for (const row of reactionRows.results) {
    const existing = byPath.get(row.article_path);
    if (existing) {
      existing.reactions = Number(row.reactions);
    } else {
      byPath.set(row.article_path, {
        article_path: row.article_path,
        total: 0,
        pending: 0,
        approved: 0,
        reactions: Number(row.reactions),
      });
    }
  }

  const articles = [...byPath.values()].sort((a, b) => b.total + b.reactions - (a.total + a.reactions));
  return json({ articles });
}

export async function handleAdminListComments(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;

  const statusParam = new URL(request.url).searchParams.get('status') ?? 'pending';
  if (statusParam !== 'pending' && statusParam !== 'approved' && statusParam !== 'all') {
    return json({ error: 'status must be pending, approved or all' }, 400);
  }

  let results: { id: string; article_path: string; nickname: string; body: string; status: string; created_at: number }[];
  if (statusParam === 'all') {
    ({ results } = await env.DB.prepare(`${LIST_SELECT} ORDER BY created_at ASC LIMIT 200`).all());
  } else {
    ({ results } = await env.DB.prepare(
      `${LIST_SELECT} WHERE status = ? ORDER BY created_at ASC LIMIT 200`,
    )
      .bind(statusParam)
      .all());
  }
  return json({ comments: results });
}

export async function handleAdminPatchComment(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  if (!(await requireCsrf(request, auth.payload))) {
    return json({ error: 'invalid csrf token' }, 403);
  }
  if (!UUID_RE.test(id)) {
    return json({ error: 'invalid comment id' }, 400);
  }

  const read = await readJsonBody(request, 2048);
  if (!read.ok || typeof read.value !== 'object' || read.value === null) {
    return json({ error: 'invalid body' }, 400);
  }
  const status = (read.value as Record<string, unknown>).status;
  if (status !== 'approved' && status !== 'pending') {
    return json({ error: 'status must be approved or pending' }, 400);
  }

  const result = await env.DB.prepare('UPDATE comments SET status = ? WHERE id = ?')
    .bind(status, id)
    .run();
  if (result.meta.changes === 0) {
    return json({ error: 'comment not found' }, 404);
  }

  const row = await env.DB.prepare(`${LIST_SELECT} WHERE id = ?`).bind(id).first();
  return json({ comment: row });
}

export async function handleAdminDeleteComment(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  if (!(await requireCsrf(request, auth.payload))) {
    return json({ error: 'invalid csrf token' }, 403);
  }
  if (!UUID_RE.test(id)) {
    return json({ error: 'invalid comment id' }, 400);
  }

  const result = await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
  if (result.meta.changes === 0) {
    return json({ error: 'comment not found' }, 404);
  }
  return json({ ok: true });
}
