/**
 * Admin "pages with comments" overview (GET /api/admin/articles).
 *
 * One Worker serves many pages: each comment carries an article_path, and the
 * admin can see every page that received comments with pending/approved
 * counts — session required.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { base64UrlToBytes, mineNonce, PROTOCOL_VERSION, serializeNonce } from '@staticlayer/protocol';
import { SECRETS, spawnWorker } from './worker.ts';

const BASE = 'http://localhost';

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

async function createComment(mf: Miniflare, article: string, body: string): Promise<void> {
  const challengeRes = await mf.dispatchFetch(
    `${BASE}/api/comments/challenge?hostContext=example.com&articlePath=${encodeURIComponent(article)}`,
  );
  expect(challengeRes.status).toBe(200);
  const challenge = (await challengeRes.json()) as {
    challengeId: string;
    hostContext: string;
    articlePath: string;
    difficulty: number;
    expiresAt: number;
    signature: string;
  };
  const nonce = await mineNonce(
    {
      version: PROTOCOL_VERSION,
      hostContext: challenge.hostContext,
      articlePath: challenge.articlePath,
      nickname: 'Alice',
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
      nickname: 'Alice',
      body,
      difficulty: challenge.difficulty,
      expiresAt: challenge.expiresAt,
      signature: challenge.signature,
      nonce: serializeNonce(nonce),
    }),
  });
  expect(res.status).toBe(200);
}

interface ArticleRow {
  article_path: string;
  total: number;
  pending: number;
  approved: number;
}

describe('admin articles overview', () => {
  let mf: Awaited<ReturnType<typeof spawnWorker>> | undefined;

  afterEach(async () => {
    if (mf) {
      await mf.dispose();
      mf = undefined;
    }
  });

  it('requires an admin session', async () => {
    mf = await spawnWorker();
    const res = await mf.dispatchFetch(`${BASE}/api/admin/articles`);
    expect(res.status).toBe(401); // fail closed without session
  });

  it('groups comments by page with pending/approved counts', async () => {
    mf = await spawnWorker();
    // /a: 2 comments; /b: 1 comment
    await createComment(mf, '/a', 'first on a');
    await createComment(mf, '/a', 'second on a');
    await createComment(mf, '/b', 'only on b');
    const { cookie, csrf } = await login(mf);

    // approve one comment on /a (pick it explicitly — the list is newest-first)
    const pendingRes = await mf.dispatchFetch(`${BASE}/api/admin/comments?status=pending`, {
      headers: { cookie },
    });
    const pending = (await pendingRes.json()) as { comments: { id: string; article_path: string }[] };
    const target = pending.comments.find((c) => c.article_path === '/a') as { id: string };
    const patch = await mf.dispatchFetch(`${BASE}/api/admin/comments/${target.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(patch.status).toBe(200);

    const res = await mf.dispatchFetch(`${BASE}/api/admin/articles`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { articles: ArticleRow[] };
    const byPath = Object.fromEntries(body.articles.map((a) => [a.article_path, a]));

    expect(byPath['/a']).toMatchObject({ total: 2, pending: 1, approved: 1 });
    expect(byPath['/b']).toMatchObject({ total: 1, pending: 1, approved: 0 });
  });
});
