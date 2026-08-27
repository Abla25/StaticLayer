import type { Env } from './env.ts';
import { json, readJsonBody } from './http.ts';
import { requireAdmin, requireCsrf } from './auth.ts';
import { readSettings, settingString } from './settings.ts';

/**
 * Admin moderation API (Phase 2 + Round 21.3).
 *
 *   GET    /api/admin/comments?status=&q=&article=&page=&perPage=  session
 *   GET    /api/admin/articles                                session required
 *   PATCH  /api/admin/comments/:id   { status: approved|pending }  + CSRF
 *   DELETE /api/admin/comments/:id                              + CSRF
 *   POST   /api/admin/comments/bulk  { ids, action }             + CSRF
 *
 * CSRF: mutating endpoints require `X-CSRF-Token` matching the session-bound
 * token (constant-time), otherwise 403. All writes use prepared statements.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CommentRow {
  id: string;
  article_path: string;
  nickname: string;
  body: string;
  status: string;
  created_at: number;
  parent_id?: string | null;
  parent_nickname?: string | null;
  is_owner?: number;
}

const LIST_SELECT =
  'SELECT c.id, c.article_path, c.nickname, c.body, c.status, c.created_at, c.parent_id, c.is_owner, p.nickname AS parent_nickname ' +
  'FROM comments c LEFT JOIN comments p ON p.id = c.parent_id';

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

  const params = new URL(request.url).searchParams;
  const statusParam = params.get('status') ?? 'pending';
  if (statusParam !== 'pending' && statusParam !== 'approved' && statusParam !== 'all') {
    return json({ error: 'status must be pending, approved or all' }, 400);
  }
  // Search across nickname + body (case-insensitive LIKE), article filter,
  // and server-side pagination (newest first).
  const q = (params.get('q') ?? '').trim().slice(0, 100);
  const article = (params.get('article') ?? '').trim().slice(0, 300);
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(params.get('perPage') ?? '20') || 20));

  const where: string[] = [];
  const bind: (string | number)[] = [];
  if (statusParam !== 'all') {
    where.push('c.status = ?');
    bind.push(statusParam);
  }
  if (q) {
    where.push('(c.nickname LIKE ? OR c.body LIKE ?)');
    bind.push(`%${q}%`, `%${q}%`);
  }
  if (article) {
    where.push('c.article_path = ?');
    bind.push(article);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await env.DB
    .prepare(`SELECT COUNT(*) AS c FROM comments c ${whereSql}`)
    .bind(...bind)
    .first<{ c: number }>();
  const total = Number(totalRow?.c ?? 0);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const currentPage = Math.min(page, pages);
  const offset = (currentPage - 1) * perPage;

  const { results } = await env.DB.prepare(
    `${LIST_SELECT} ${whereSql} ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...bind, perPage, offset)
    .all<CommentRow>();

  return json({ comments: results, page: currentPage, perPage, total, pages });
}

/** POST /api/admin/comments/bulk  { ids: string[], action }  + CSRF */
export async function handleAdminBulkComments(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  if (!(await requireCsrf(request, auth.payload))) return json({ error: 'invalid csrf token' }, 403);

  const read = await readJsonBody(request, 32 * 1024);
  if (!read.ok || typeof read.value !== 'object' || read.value === null) {
    return json({ error: 'invalid body' }, 400);
  }
  const ids = (read.value as Record<string, unknown>).ids;
  const action = (read.value as Record<string, unknown>).action;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
    return json({ error: 'ids must contain 1..100 comments' }, 400);
  }
  if (!ids.every((x) => typeof x === 'string' && UUID_RE.test(x))) {
    return json({ error: 'invalid comment id' }, 400);
  }
  if (action !== 'approve' && action !== 'unapprove' && action !== 'delete') {
    return json({ error: 'action must be approve, unapprove or delete' }, 400);
  }

  const placeholders = ids.map(() => '?').join(', ');
  const cleanIds = ids as string[];
  if (action === 'delete') {
    const result = await env.DB
      .prepare(`DELETE FROM comments WHERE id IN (${placeholders})`)
      .bind(...cleanIds)
      .run();
    return json({ ok: true, changes: result.meta.changes });
  }
  const status = action === 'approve' ? 'approved' : 'pending';
  const result = await env.DB
    .prepare(`UPDATE comments SET status = ? WHERE id IN (${placeholders})`)
    .bind(status, ...cleanIds)
    .run();
  return json({ ok: true, changes: result.meta.changes });
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

  const row = await env.DB.prepare(`${LIST_SELECT} WHERE c.id = ?`).bind(id).first();
  return json({ comment: row });
}

/**
 * POST /api/admin/comments/:id/reply  { body }  + CSRF
 *
 * The owner replies from the admin console. The reply is created as
 * `is_owner = 1`, already approved (no moderation needed for the owner), and
 * shown in the public thread with an "Author" badge.
 */
export async function handleAdminReplyComment(
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

  const read = await readJsonBody(request, 4096);
  if (!read.ok || typeof read.value !== 'object' || read.value === null) {
    return json({ error: read.ok ? 'invalid body' : 'invalid JSON body' }, read.ok ? 400 : read.status);
  }
  const body = (read.value as Record<string, unknown>).body;
  if (typeof body !== 'string' || !body.trim() || body.length > 3000) {
    return json({ error: 'body is required' }, 400);
  }

  const parent = await env.DB
    .prepare('SELECT id, article_path FROM comments WHERE id = ?')
    .bind(id)
    .first<{ id: string; article_path: string }>();
  if (!parent) return json({ error: 'comment not found' }, 404);

  const map = await readSettings(env.DB);
  const ownerNickname = settingString(map, 'owner_nickname', 'Site owner');

  const replyId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO comments (id, article_path, nickname, body, status, created_at, challenge_id, parent_id, is_owner)
     VALUES (?, ?, ?, ?, 'approved', ?, '', ?, 1)`,
  )
    .bind(replyId, parent.article_path, ownerNickname, body.trim(), now, parent.id)
    .run();

  const row = await env.DB.prepare(`${LIST_SELECT} WHERE c.id = ?`).bind(replyId).first();
  return json({ comment: row }, 201);
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
