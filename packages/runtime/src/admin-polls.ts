import type { D1Database } from '@cloudflare/workers-types';
import { requireAdmin, requireCsrf } from './auth.ts';
import type { Env } from './env.ts';
import { json, readJsonBody } from './http.ts';

/**
 * Admin polls API (session + CSRF protected):
 *
 *   GET    /api/admin/polls            list polls (with counts)
 *   POST   /api/admin/polls            { articlePath, question, options, multi, singleVote }
 *   PATCH  /api/admin/polls/:id        { status: 'open' | 'closed' }
 *   DELETE /api/admin/polls/:id        delete poll + votes
 */

interface PollRow {
  id: string;
  article_path: string;
  question: string;
  options: string;
  multi: number;
  single_vote: number;
  status: string;
  created_at: number;
}

const MAX_OPTIONS = 10;
const MIN_OPTIONS = 2;
const MAX_OPTION_LEN = 100;
const MAX_QUESTION_LEN = 500;

async function countsFor(db: D1Database, pollId: string): Promise<Record<string, number>> {
  const { results } = await db
    .prepare('SELECT option, COUNT(*) AS c FROM poll_votes WHERE poll_id = ? GROUP BY option')
    .bind(pollId)
    .all<{ option: string; c: number }>();
  const out: Record<string, number> = {};
  for (const r of results) out[r.option] = Number(r.c);
  return out;
}

export async function handleAdminListPolls(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;

  const rows = (await env.DB.prepare(
    'SELECT * FROM polls ORDER BY created_at DESC LIMIT 200',
  ).all<PollRow>()).results;
  const polls = [];
  for (const row of rows) {
    let options: string[] = [];
    try {
      const arr = JSON.parse(row.options);
      if (Array.isArray(arr)) options = arr.map(String);
    } catch {
      /* keep [] */
    }
    const counts = await countsFor(env.DB, row.id);
    const total = Object.values(counts).reduce((n, c) => n + c, 0);
    polls.push({
      id: row.id,
      article_path: row.article_path,
      question: row.question,
      options,
      multi: row.multi === 1,
      singleVote: row.single_vote === 1,
      status: row.status,
      created_at: row.created_at,
      counts,
      total,
    });
  }
  return json({ polls });
}

export async function handleAdminCreatePoll(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  if (!(await requireCsrf(request, auth.payload))) return json({ error: 'invalid csrf token' }, 403);

  const read = await readJsonBody(request, 8192);
  if (!read.ok || typeof read.value !== 'object' || read.value === null) {
    return json({ error: 'invalid body' }, read.ok ? 400 : read.status);
  }
  const body = read.value as Record<string, unknown>;
  const articlePath = body.articlePath;
  const question = body.question;
  const rawOptions = body.options;
  if (typeof articlePath !== 'string' || !articlePath.trim() || articlePath.length > 255) {
    return json({ error: 'articlePath is required' }, 400);
  }
  if (typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION_LEN) {
    return json({ error: 'question is required' }, 400);
  }
  if (!Array.isArray(rawOptions)) return json({ error: 'options must be an array' }, 400);
  const options = rawOptions.map((o) => (typeof o === 'string' ? o.trim() : '')).filter(Boolean);
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    return json({ error: `options must be ${MIN_OPTIONS}..${MAX_OPTIONS}` }, 400);
  }
  if (options.some((o) => o.length > MAX_OPTION_LEN)) {
    return json({ error: `each option must be <= ${MAX_OPTION_LEN} chars` }, 400);
  }
  if (new Set(options).size !== options.length) return json({ error: 'options must be unique' }, 400);

  const id = crypto.randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO polls (id, article_path, question, options, multi, single_vote, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
  )
    .bind(
      id,
      articlePath.trim(),
      question.trim(),
      JSON.stringify(options),
      body.multi === true ? 1 : 0,
      body.singleVote === true ? 1 : 0,
      createdAt,
    )
    .run();

  return json(
    {
      poll: {
        id,
        article_path: articlePath.trim(),
        question: question.trim(),
        options,
        multi: body.multi === true,
        singleVote: body.singleVote === true,
        status: 'open',
        created_at: createdAt,
        counts: {},
        total: 0,
      },
    },
    201,
  );
}

export async function handleAdminPatchPoll(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  if (!(await requireCsrf(request, auth.payload))) return json({ error: 'invalid csrf token' }, 403);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'invalid poll id' }, 400);

  const read = await readJsonBody(request, 2048);
  if (!read.ok || typeof read.value !== 'object' || read.value === null) {
    return json({ error: 'invalid body' }, read.ok ? 400 : read.status);
  }
  const status = (read.value as Record<string, unknown>).status;
  if (status !== 'open' && status !== 'closed') return json({ error: 'status must be open or closed' }, 400);

  const result = await env.DB
    .prepare('UPDATE polls SET status = ? WHERE id = ?')
    .bind(status, id)
    .run();
  if (result.meta.changes === 0) return json({ error: 'poll not found' }, 404);
  return json({ ok: true, id, status });
}

export async function handleAdminDeletePoll(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  if (!(await requireCsrf(request, auth.payload))) return json({ error: 'invalid csrf token' }, 403);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'invalid poll id' }, 400);

  const exists = await env.DB.prepare('SELECT id FROM polls WHERE id = ?').bind(id).first();
  if (!exists) return json({ error: 'poll not found' }, 404);

  // Delete the poll and its votes atomically.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM poll_votes WHERE poll_id = ?').bind(id),
    env.DB.prepare('DELETE FROM polls WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}
