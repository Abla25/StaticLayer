import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { base64UrlToBytes, mineNonce, PROTOCOL_VERSION, serializeNonce } from '@staticlayer/protocol';
import { SECRETS, spawnWorker } from './worker.ts';

const BASE = 'http://localhost';
const ARTICLE = '/blog/hello';

/**
 * CSRF protection (SECURITY_REVIEW.md I9) + public read API (Phase 2).
 * Session cookie is passed manually (Miniflare does not manage cookies).
 */

async function login(mf: Miniflare): Promise<{ cookie: string; csrf: string }> {
  const res = await mf.dispatchFetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: SECRETS.ADMIN_SECRET }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  const cookie = setCookie!.split(';')[0]!;
  const data = (await res.json()) as { csrf?: string };
  expect(typeof data.csrf).toBe('string');
  return { cookie, csrf: data.csrf as string };
}

async function createComment(mf: Miniflare, body: string): Promise<string> {
  const challengeRes = await mf.dispatchFetch(
    `${BASE}/api/comments/challenge?hostContext=example.com&articlePath=${encodeURIComponent(ARTICLE)}`,
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
  const data = (await res.json()) as { comment?: { id?: string; status?: string } };
  expect(data.comment?.id).toBeTruthy();
  expect(data.comment?.status).toBe('pending'); // Phase 2: moderation pipeline
  return data.comment!.id as string;
}

describe('CSRF protection (I9)', () => {
  let mf: Miniflare | undefined;
  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it('login returns a 32-byte base64url CSRF token (43 chars)', async () => {
    mf = await spawnWorker();
    const { csrf } = await login(mf);
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/); // ceil(32 * 4 / 3)
  });

  it('PATCH without a session cookie → 401', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const id = await createComment(mf, 'comment');
    const res = await mf.dispatchFetch(`${BASE}/api/admin/comments/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(res.status).toBe(401);
  });

  it('PATCH with a valid cookie but NO X-CSRF-Token → 403', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const id = await createComment(mf, 'comment');
    const { cookie } = await login(mf);
    const res = await mf.dispatchFetch(`${BASE}/api/admin/comments/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(res.status).toBe(403);
  });

  it('PATCH with a WRONG X-CSRF-Token → 403', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const id = await createComment(mf, 'comment');
    const { cookie } = await login(mf);
    const res = await mf.dispatchFetch(`${BASE}/api/admin/comments/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': 'AAAABBBBCCCCDDDD' },
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(res.status).toBe(403);
  });

  it('PATCH with cookie + correct X-CSRF-Token → 200 and comment becomes approved', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const id = await createComment(mf, 'approved via csrf');
    const { cookie, csrf } = await login(mf);
    const res = await mf.dispatchFetch(`${BASE}/api/admin/comments/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { comment?: { status?: string } };
    expect(data.comment?.status).toBe('approved');

    // The approved comment is now publicly visible.
    const publicRes = await mf.dispatchFetch(
      `${BASE}/api/comments?article_path=${encodeURIComponent(ARTICLE)}&host_context=example.com`,
    );
    const publicData = (await publicRes.json()) as { comments: Array<{ id: string }> };
    expect(publicData.comments.map((c) => c.id)).toContain(id);
  });

  it('DELETE with cookie + correct X-CSRF-Token → 200 and comment is gone', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const id = await createComment(mf, 'to be deleted');
    const { cookie, csrf } = await login(mf);
    const res = await mf.dispatchFetch(`${BASE}/api/admin/comments/${id}`, {
      method: 'DELETE',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(res.status).toBe(200);

    const adminRes = await mf.dispatchFetch(
      `${BASE}/api/admin/comments?status=all`,
      { headers: { cookie } },
    );
    const adminData = (await adminRes.json()) as { comments: Array<{ id: string }> };
    expect(adminData.comments.map((c) => c.id)).not.toContain(id);
  });

  it('GET /api/admin/comments without a session → 401', async () => {
    mf = await spawnWorker();
    const res = await mf.dispatchFetch(`${BASE}/api/admin/comments?status=pending`);
    expect(res.status).toBe(401);
  });
});

describe('public GET /api/comments (Phase 2)', () => {
  let mf: Miniflare | undefined;
  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it('serves only approved comments with public cache header and NO Set-Cookie', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    await createComment(mf, 'still pending — must not be listed');

    const res = await mf.dispatchFetch(
      `${BASE}/api/comments?article_path=${encodeURIComponent(ARTICLE)}&host_context=example.com`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.get('set-cookie')).toBeNull();
    const empty = (await res.json()) as { comments: unknown[] };
    expect(empty.comments).toHaveLength(0); // pending is not exposed

    // approve it via admin, then it becomes visible
    const { cookie, csrf } = await login(mf);
    const list = await mf.dispatchFetch(`${BASE}/api/admin/comments?status=pending`, {
      headers: { cookie },
    });
    const pending = (await list.json()) as { comments: Array<{ id: string }> };
    expect(pending.comments).toHaveLength(1);
    await mf.dispatchFetch(`${BASE}/api/admin/comments/${pending.comments[0].id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({ status: 'approved' }),
    });

    const after = await mf.dispatchFetch(
      `${BASE}/api/comments?article_path=${encodeURIComponent(ARTICLE)}&host_context=example.com`,
    );
    const data = (await after.json()) as { comments: Array<{ body: string }> };
    expect(data.comments).toHaveLength(1);
    expect(data.comments[0].body).toBe('still pending — must not be listed');
  });

  it('rejects a missing article_path with 400', async () => {
    mf = await spawnWorker();
    const res = await mf.dispatchFetch(`${BASE}/api/comments`);
    expect(res.status).toBe(400);
  });
});

describe('static assets (Phase 2)', () => {
  let mf: Miniflare | undefined;
  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it('serves /widget.js and /pow-worker.js as public cacheable JS', async () => {
    mf = await spawnWorker();
    const widget = await mf.dispatchFetch(`${BASE}/widget.js`);
    expect(widget.status).toBe(200);
    expect(widget.headers.get('content-type')).toContain('application/javascript');
    expect(widget.headers.get('cache-control')).toBe('public, max-age=3600');

    const worker = await mf.dispatchFetch(`${BASE}/pow-worker.js`);
    expect(worker.status).toBe(200);
    expect(worker.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('serves /admin.html with the CSP header', async () => {
    mf = await spawnWorker();
    const res = await mf.dispatchFetch(`${BASE}/admin.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
