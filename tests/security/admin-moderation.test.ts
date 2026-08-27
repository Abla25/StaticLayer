import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { base64UrlToBytes, mineNonce, PROTOCOL_VERSION, serializeNonce } from '@staticlayer/protocol';
import { SECRETS, spawnWorker } from './worker.ts';

const BASE = 'http://localhost';

/**
 * Admin moderation v2: pagination/search/filters, bulk actions, allow/block
 * lists, and live settings. Covers the Round 21.3 API surface.
 */

async function login(mf: Miniflare): Promise<{ cookie: string; csrf: string }> {
  const res = await mf.dispatchFetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: SECRETS.ADMIN_SECRET }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const data = (await res.json()) as { csrf?: string };
  return { cookie, csrf: data.csrf as string };
}

function authedHeaders(cookie: string, csrf: string, json = true): Record<string, string> {
  const h: Record<string, string> = { cookie, 'X-CSRF-Token': csrf };
  if (json) h['content-type'] = 'application/json';
  return h;
}

async function postComment(
  mf: Miniflare,
  nickname: string,
  body: string,
  articlePath = '/blog/hello',
  difficulty?: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const challengeRes = await mf.dispatchFetch(
    `${BASE}/api/comments/challenge?hostContext=example.com&articlePath=${encodeURIComponent(articlePath)}`,
  );
  if (challengeRes.status !== 200) return { status: challengeRes.status, body: {} };
  const challenge = (await challengeRes.json()) as {
    challengeId: string; hostContext: string; articlePath: string;
    difficulty: number; expiresAt: number; signature: string;
  };
  const nonce = await mineNonce(
    {
      version: PROTOCOL_VERSION,
      hostContext: challenge.hostContext,
      articlePath: challenge.articlePath,
      nickname,
      body,
      challengeId: base64UrlToBytes(challenge.challengeId),
    },
    challenge.difficulty,
  );
  const res = await mf.dispatchFetch(`${BASE}/api/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      hostContext: challenge.hostContext,
      articlePath: challenge.articlePath,
      nickname,
      body,
      difficulty: challenge.difficulty,
      expiresAt: challenge.expiresAt,
      signature: challenge.signature,
      nonce: serializeNonce(nonce),
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function seedComments(mf: Miniflare, n: number, prefix = 'c'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await postComment(mf, 'Seed' + i, prefix + '-' + i + ' ' + 'needle' + (i % 3), '/blog/' + (i % 2));
    expect(r.status).toBe(200);
    const id = (r.body.comment as { id?: string }).id as string;
    ids.push(id);
  }
  return ids;
}

describe('admin moderation v2 — settings', () => {
  let mf: Miniflare | undefined;
  afterEach(async () => { await mf?.dispose(); mf = undefined; });

  it('requires a session for GET/PUT settings', async () => {
    mf = await spawnWorker();
    expect((await mf.dispatchFetch(`${BASE}/api/admin/settings`)).status).toBe(401);
    expect((await mf.dispatchFetch(`${BASE}/api/admin/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });

  it('GET returns effective settings merged with env defaults', async () => {
    mf = await spawnWorker({ difficulty: 12 });
    const { cookie, csrf } = await login(mf);
    const res = await mf.dispatchFetch(`${BASE}/api/admin/settings`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const s = ((await res.json()) as { settings: Record<string, unknown> }).settings;
    expect(s.pow_difficulty).toBe(12);
    expect(s.reaction_options).toBe('👍,❤️,🎉');
    expect(s.moderation_mode).toBe('open');
  });

  it('validates and persists settings; PUT changes live difficulty', async () => {
    mf = await spawnWorker({ difficulty: 12 });
    const { cookie, csrf } = await login(mf);

    const bad = await mf.dispatchFetch(`${BASE}/api/admin/settings`, {
      method: 'PUT', headers: authedHeaders(cookie, csrf), body: JSON.stringify({ settings: { pow_difficulty: -1 } }),
    });
    expect(bad.status).toBe(400); // below MIN_DIFFICULTY

    const put = await mf.dispatchFetch(`${BASE}/api/admin/settings`, {
      method: 'PUT', headers: authedHeaders(cookie, csrf), body: JSON.stringify({ settings: { pow_difficulty: 24 } }),
    });
    expect(put.status).toBe(200);
    const s = ((await put.json()) as { settings: Record<string, unknown> }).settings;
    expect(s.pow_difficulty).toBe(24);

    // New challenges are issued at the new difficulty.
    const ch = await mf.dispatchFetch(`${BASE}/api/comments/challenge?hostContext=h&articlePath=/x`);
    expect(((await ch.json()) as { difficulty: number }).difficulty).toBe(24);
  });

  it('rejects unknown settings and bad moderation_mode', async () => {
    mf = await spawnWorker();
    const { cookie, csrf } = await login(mf);
    const res = await mf.dispatchFetch(`${BASE}/api/admin/settings`, {
      method: 'PUT', headers: authedHeaders(cookie, csrf), body: JSON.stringify({ settings: { moderation_mode: 'nope' } }),
    });
    expect(res.status).toBe(400);
  });
});

describe('admin moderation v2 — lists + enforcement', () => {
  let mf: Miniflare | undefined;
  afterEach(async () => { await mf?.dispose(); mf = undefined; });

  it('adds, lists and removes allow/block entries (CSRF required)', async () => {
    mf = await spawnWorker();
    const { cookie, csrf } = await login(mf);

    // No CSRF => 403.
    const noCsrf = await mf.dispatchFetch(`${BASE}/api/admin/lists`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'block', value: 'Spammer' }),
    });
    expect(noCsrf.status).toBe(403);

    const add = await mf.dispatchFetch(`${BASE}/api/admin/lists`, {
      method: 'POST', headers: authedHeaders(cookie, csrf), body: JSON.stringify({ kind: 'block', value: 'Spammer' }),
    });
    expect(add.status).toBe(201);

    // Case-insensitive + trimmed: same value returns 409.
    const dup = await mf.dispatchFetch(`${BASE}/api/admin/lists`, {
      method: 'POST', headers: authedHeaders(cookie, csrf), body: JSON.stringify({ kind: 'block', value: '  spammer  ' }),
    });
    expect(dup.status).toBe(409);

    await mf.dispatchFetch(`${BASE}/api/admin/lists`, {
      method: 'POST', headers: authedHeaders(cookie, csrf), body: JSON.stringify({ kind: 'allow', value: 'Trusted' }),
    });

    const list = await mf.dispatchFetch(`${BASE}/api/admin/lists`, { headers: { cookie } });
    const data = (await list.json()) as { allow: { id: number; value: string }[]; block: { id: number; value: string }[] };
    expect(data.block.map((b) => b.value)).toEqual(['spammer']);
    expect(data.allow.map((a) => a.value)).toEqual(['trusted']);

    const del = await mf.dispatchFetch(`${BASE}/api/admin/lists/${data.block[0].id}`, {
      method: 'DELETE', headers: authedHeaders(cookie, csrf, false),
    });
    expect(del.status).toBe(200);
    const after = (await (await mf.dispatchFetch(`${BASE}/api/admin/lists`, { headers: { cookie } })).json()) as { block: unknown[] };
    expect(after.block).toEqual([]);
  });

  it('blocks banned nicknames at submit (403, comment not stored)', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const { cookie, csrf } = await login(mf);
    await mf.dispatchFetch(`${BASE}/api/admin/lists`, {
      method: 'POST', headers: authedHeaders(cookie, csrf), body: JSON.stringify({ kind: 'block', value: 'evil' }),
    });
    const r = await postComment(mf, 'Evil', 'hello');
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toMatch(/not allowed/i);
    const list = await mf.dispatchFetch(`${BASE}/api/admin/comments?status=all`, { headers: { cookie } });
    expect(((await list.json()) as { total: number }).total).toBe(0);
  });

  it('auto-approves allowlisted nicknames in open mode', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const { cookie, csrf } = await login(mf);
    await mf.dispatchFetch(`${BASE}/api/admin/lists`, {
      method: 'POST', headers: authedHeaders(cookie, csrf), body: JSON.stringify({ kind: 'allow', value: 'vip' }),
    });
    const r = await postComment(mf, 'VIP', 'hi from vip');
    expect(r.status).toBe(200);
    expect((r.body.comment as { status?: string }).status).toBe('approved');
  });

  it('allowlist-only mode rejects everyone except allowlisted nicknames', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const { cookie, csrf } = await login(mf);
    await mf.dispatchFetch(`${BASE}/api/admin/settings`, {
      method: 'PUT', headers: authedHeaders(cookie, csrf), body: JSON.stringify({ settings: { moderation_mode: 'allowlist' } }),
    });
    await mf.dispatchFetch(`${BASE}/api/admin/lists`, {
      method: 'POST', headers: authedHeaders(cookie, csrf), body: JSON.stringify({ kind: 'allow', value: 'member' }),
    });

    const outsider = await postComment(mf, 'Random', 'can i join?');
    expect(outsider.status).toBe(403);

    const member = await postComment(mf, 'MEMBER', 'approved member');
    expect(member.status).toBe(200);
    expect((member.body.comment as { status?: string }).status).toBe('approved');
  });
});

describe('admin moderation v2 — pagination, search, bulk', () => {
  let mf: Miniflare | undefined;
  afterEach(async () => { await mf?.dispose(); mf = undefined; });

  it('paginates newest-first and filters by search + article', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const { cookie } = await login(mf);
    // Seed directly with DISTINCT created_at so the newest-first order is
    // deterministic (comments posted within the same second share created_at).
    const db = await mf.getD1Database('DB');
    const base = 1_700_000_000;
    for (let i = 0; i < 6; i++) {
      const id = '00000000-0000-4000-8000-' + String(100000 + i).padStart(12, '0');
      await db
        .prepare('INSERT INTO comments (id, article_path, nickname, body, status, created_at, challenge_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, '/blog/' + (i % 2), 'Seed' + i, 'c' + i + ' needle' + (i % 3), 'pending', base + i, 'ch-' + i)
        .run();
    }

    const p1 = await (await mf.dispatchFetch(`${BASE}/api/admin/comments?status=pending&perPage=3&page=1`, { headers: { cookie } })).json() as {
      comments: { nickname: string }[]; page: number; pages: number; total: number;
    };
    expect(p1.page).toBe(1);
    expect(p1.pages).toBe(2);
    expect(p1.total).toBe(6);
    expect(p1.comments).toHaveLength(3);
    // Newest first: the last seeded nickname appears first.
    expect(p1.comments[0].nickname).toBe('Seed5');
    expect(p1.comments[2].nickname).toBe('Seed3');

    const p2 = await (await mf.dispatchFetch(`${BASE}/api/admin/comments?status=pending&perPage=3&page=2`, { headers: { cookie } })).json() as { comments: { nickname: string }[]; page: number };
    expect(p2.page).toBe(2);
    expect(p2.comments[0].nickname).toBe('Seed2');

    // Search hits only matching rows.
    const search = await (await mf.dispatchFetch(`${BASE}/api/admin/comments?status=pending&q=needle1`, { headers: { cookie } })).json() as { total: number };
    expect(search.total).toBe(2);

    // Article filter.
    const article = await (await mf.dispatchFetch(`${BASE}/api/admin/comments?status=pending&article=${encodeURIComponent('/blog/0')}`, { headers: { cookie } })).json() as { total: number };
    expect(article.total).toBe(3);
  });

  it('bulk approves and deletes selected comments (CSRF required)', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const { cookie, csrf } = await login(mf);
    const ids = await seedComments(mf, 3);

    const noCsrf = await mf.dispatchFetch(`${BASE}/api/admin/comments/bulk`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ids: ids.slice(0, 2), action: 'approve' }),
    });
    expect(noCsrf.status).toBe(403);

    const bulk = await mf.dispatchFetch(`${BASE}/api/admin/comments/bulk`, {
      method: 'POST', headers: authedHeaders(cookie, csrf), body: JSON.stringify({ ids: ids.slice(0, 2), action: 'approve' }),
    });
    expect(bulk.status).toBe(200);
    expect(((await bulk.json()) as { changes: number }).changes).toBe(2);

    const approved = await (await mf.dispatchFetch(`${BASE}/api/admin/comments?status=approved`, { headers: { cookie } })).json() as { total: number };
    expect(approved.total).toBe(2);

    const del = await mf.dispatchFetch(`${BASE}/api/admin/comments/bulk`, {
      method: 'POST', headers: authedHeaders(cookie, csrf), body: JSON.stringify({ ids: [ids[2]], action: 'delete' }),
    });
    expect(del.status).toBe(200);
    const remaining = await (await mf.dispatchFetch(`${BASE}/api/admin/comments?status=all`, { headers: { cookie } })).json() as { total: number };
    expect(remaining.total).toBe(2);

    const invalid = await mf.dispatchFetch(`${BASE}/api/admin/comments/bulk`, {
      method: 'POST', headers: authedHeaders(cookie, csrf), body: JSON.stringify({ ids: ['not-a-uuid'], action: 'approve' }),
    });
    expect(invalid.status).toBe(400);
  });
});

describe('admin moderation v2 — blocked terms + updates', () => {
  let mf: Miniflare | undefined;
  afterEach(async () => { await mf?.dispose(); mf = undefined; });

  it('adds/lists/removes blocked terms and auto-rejects comments containing them', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const { cookie, csrf } = await login(mf);

    // No CSRF => 403.
    const noCsrf = await mf.dispatchFetch(`${BASE}/api/admin/terms`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ term: 'spammy' }),
    });
    expect(noCsrf.status).toBe(403);

    const add = await mf.dispatchFetch(`${BASE}/api/admin/terms`, {
      method: 'POST', headers: authedHeaders(cookie, csrf), body: JSON.stringify({ term: 'SPAMMY' }),
    });
    expect(add.status).toBe(201);

    const list = await (await mf.dispatchFetch(`${BASE}/api/admin/terms`, { headers: { cookie } })).json() as { terms: { id: number; term: string }[] };
    expect(list.terms.map((t) => t.term)).toEqual(['spammy']); // normalized lowercase

    // Comment containing the term (case-insensitive) is auto-rejected, never stored.
    const bad = await postComment(mf, 'Alice', 'this is SPAMMY content');
    expect(bad.status).toBe(403);
    expect(JSON.stringify(bad.body)).toMatch(/blocked term/i);
    const all = await (await mf.dispatchFetch(`${BASE}/api/admin/comments?status=all`, { headers: { cookie } })).json() as { total: number };
    expect(all.total).toBe(0);

    // Clean comment still works.
    const ok = await postComment(mf, 'Alice', 'a nice comment');
    expect(ok.status).toBe(200);

    // Remove the term => previously-blocked content now passes.
    await mf.dispatchFetch(`${BASE}/api/admin/terms/${list.terms[0].id}`, {
      method: 'DELETE', headers: authedHeaders(cookie, csrf, false),
    });
    const again = await postComment(mf, 'Alice', 'spammy is fine now');
    expect(again.status).toBe(200);
  });

  it('check-updates endpoint requires a session and reports the current version', async () => {
    mf = await spawnWorker();
    expect((await mf.dispatchFetch(`${BASE}/api/admin/updates`)).status).toBe(401);
    const { cookie } = await login(mf);
    const res = await mf.dispatchFetch(`${BASE}/api/admin/updates`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { current: string; updateAvailable: boolean };
    expect(data.current).toBe('1.4.0');
    expect(typeof data.updateAvailable).toBe('boolean');
  });
});
