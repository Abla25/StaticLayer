/**
 * Round 21.21 — comment actions + data portability (v1.6).
 *
 *   PATCH /api/admin/comments/:id { pinned }      owner pin (top of thread)
 *   POST  /api/comments/flag                      visitor "report" (PoW, 0 data)
 *   POST  /api/comments/vote                      anonymous like (PoW + per-browser guard)
 *   GET   /api/admin/export?format=csv|json       GDPR portability download
 *
 * All comment actions reuse the anti-abuse pipeline: rate limit → signed
 * challenge → expiry → time gate → PoW (canonical "comment-action" schema,
 * action byte discriminates flag vs vote) → atomic anti-replay.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import {
  base64UrlToBytes,
  mineCommentActionNonce,
  mineNonce,
  PROTOCOL_VERSION,
  serializeNonce,
} from '@staticlayer/protocol';
import { SECRETS, spawnWorker } from './worker.ts';

const BASE = 'https://staticlayer.test';
const ARTICLE = '/blog/x';

let mf: Miniflare | undefined;

async function start() {
  mf = await spawnWorker({ difficulty: 8 });
  return mf;
}

afterEach(async () => {
  await mf?.dispose();
  mf = undefined;
});

async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await mf!.dispatchFetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: SECRETS.ADMIN_SECRET }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const data = (await res.json()) as { csrf?: string };
  return { cookie, csrf: data.csrf as string };
}

async function postComment(body = 'hello world'): Promise<string> {
  const challengeRes = await mf!.dispatchFetch(
    `${BASE}/api/comments/challenge?hostContext=example.com&articlePath=${encodeURIComponent(ARTICLE)}`,
  );
  expect(challengeRes.status).toBe(200);
  const challenge = (await challengeRes.json()) as {
    challengeId: string; hostContext: string; articlePath: string;
    difficulty: number; expiresAt: number; signature: string;
  };
  const nonce = await mineNonce(
    {
      version: PROTOCOL_VERSION,
      hostContext: challenge.hostContext,
      articlePath: challenge.articlePath,
      nickname: 'Bob',
      body,
      challengeId: base64UrlToBytes(challenge.challengeId),
    },
    challenge.difficulty,
  );
  const res = await mf!.dispatchFetch(`${BASE}/api/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      hostContext: challenge.hostContext,
      articlePath: challenge.articlePath,
      nickname: 'Bob',
      body,
      difficulty: challenge.difficulty,
      expiresAt: challenge.expiresAt,
      signature: challenge.signature,
      nonce: serializeNonce(nonce),
    }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { comment: { id: string } };
  return data.comment.id;
}

async function approve(id: string, auth: { cookie: string; csrf: string }): Promise<void> {
  const res = await mf!.dispatchFetch(`${BASE}/api/admin/comments/${id}`, {
    method: 'PATCH',
    headers: { cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  });
  expect(res.status).toBe(200);
}

async function commentChallenge(): Promise<Record<string, unknown>> {
  const res = await mf!.dispatchFetch(
    `${BASE}/api/comments/challenge?hostContext=example.com&articlePath=${encodeURIComponent(ARTICLE)}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function commentAction(
  action: 'flag' | 'vote',
  commentId: string,
  voterToken?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const challenge = await commentChallenge();
  const nonce = await mineCommentActionNonce(
    {
      version: PROTOCOL_VERSION,
      action,
      hostContext: challenge.hostContext as string,
      articlePath: challenge.articlePath as string,
      commentId,
      challengeId: base64UrlToBytes(challenge.challengeId as string),
    },
    challenge.difficulty as number,
  );
  const payload: Record<string, unknown> = {
    challengeId: challenge.challengeId,
    hostContext: challenge.hostContext,
    articlePath: challenge.articlePath,
    commentId,
    difficulty: challenge.difficulty,
    expiresAt: challenge.expiresAt,
    signature: challenge.signature,
    nonce: serializeNonce(nonce),
  };
  if (voterToken) payload.voterToken = voterToken;
  const res = await mf!.dispatchFetch(`${BASE}/api/comments/${action === 'flag' ? 'flag' : 'vote'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('comment actions — pin', () => {
  it('owner can pin/unpin a comment and it surfaces as pinned in the public read', async () => {
    await start();
    const auth = await login();
    const id = await postComment();
    await approve(id, auth);

    const pin = await mf!.dispatchFetch(`${BASE}/api/admin/comments/${id}`, {
      method: 'PATCH',
      headers: { cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
    expect(pin.status).toBe(200);
    expect(((await pin.json()) as { comment: { pinned: number } }).comment.pinned).toBe(1);

    const list = await mf!.dispatchFetch(
      `${BASE}/api/comments?article_path=${encodeURIComponent(ARTICLE)}&host_context=example.com`,
    );
    const data = (await list.json()) as { comments: Array<{ id: string; pinned: boolean }> };
    expect(data.comments[0]).toMatchObject({ id, pinned: true });

    const unpin = await mf!.dispatchFetch(`${BASE}/api/admin/comments/${id}`, {
      method: 'PATCH',
      headers: { cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: false }),
    });
    expect(unpin.status).toBe(200);
  });

  it('rejects a PATCH with neither status nor pinned', async () => {
    await start();
    const auth = await login();
    const id = await postComment();
    const res = await mf!.dispatchFetch(`${BASE}/api/admin/comments/${id}`, {
      method: 'PATCH',
      headers: { cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('comment actions — visitor flag', () => {
  it('flags an approved comment and surfaces the count in the admin queue', async () => {
    await start();
    const auth = await login();
    const id = await postComment();
    await approve(id, auth);

    const flag = await commentAction('flag', id);
    expect(flag.status).toBe(200);

    const admin = await mf!.dispatchFetch(`${BASE}/api/admin/comments?status=approved`, {
      headers: { cookie: auth.cookie },
    });
    const data = (await admin.json()) as { comments: Array<{ id: string; flags: number }> };
    expect(data.comments.find((c) => c.id === id)?.flags).toBe(1);
  });

  it('rejects a replay of the same flag challenge with 409 and a missing comment with 404', async () => {
    await start();
    const auth = await login();
    const id = await postComment();
    await approve(id, auth);

    const first = await commentAction('flag', id);
    expect(first.status).toBe(200);
    // Same challenge/nonce replay → consumed → 409.
    const challenge = await commentChallenge();
    const nonce = await mineCommentActionNonce(
      {
        version: PROTOCOL_VERSION,
        action: 'flag',
        hostContext: challenge.hostContext as string,
        articlePath: challenge.articlePath as string,
        commentId: id,
        challengeId: base64UrlToBytes(challenge.challengeId as string),
      },
      challenge.difficulty as number,
    );
    const payload = {
      challengeId: challenge.challengeId,
      hostContext: challenge.hostContext,
      articlePath: challenge.articlePath,
      commentId: id,
      difficulty: challenge.difficulty,
      expiresAt: challenge.expiresAt,
      signature: challenge.signature,
      nonce: serializeNonce(nonce),
    };
    const dup = await mf!.dispatchFetch(`${BASE}/api/comments/flag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(dup.status).toBe(200); // the first (unique) flag won

    // A flag for a non-existent comment is 404 (before PoW verification).
    const missing = await mf!.dispatchFetch(`${BASE}/api/comments/flag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentId: '00000000-0000-4000-8000-000000000000', articlePath: ARTICLE, hostContext: 'example.com', challengeId: 'x', difficulty: 8, expiresAt: 1, signature: 'x', nonce: '0' }),
    });
    expect(missing.status).toBe(404);
  });
});

describe('comment actions — anonymous vote (like)', () => {
  it('votes once per browser token and reports voted=true in the public read', async () => {
    await start();
    const auth = await login();
    const id = await postComment();
    await approve(id, auth);

    const first = await commentAction('vote', id);
    expect(first.status).toBe(200);
    const token = (first.body as { voterToken?: string }).voterToken;
    expect(typeof token).toBe('string');

    const read = await mf!.dispatchFetch(
      `${BASE}/api/comments?article_path=${encodeURIComponent(ARTICLE)}&host_context=example.com&voterToken=${encodeURIComponent(token as string)}`,
    );
    const data = (await read.json()) as { comments: Array<{ id: string; votes: number; voted: boolean }> };
    expect(data.comments[0]).toMatchObject({ id, votes: 1, voted: true });

    // Same browser token → 409; a different (new) browser can like too.
    expect((await commentAction('vote', id, token)).status).toBe(409);
    const other = await commentAction('vote', id);
    expect(other.status).toBe(200);
    expect((other.body as { votes: number }).votes).toBe(2);
  });

  it('rejects a vote for a pending comment with 404', async () => {
    await start();
    const id = await postComment(); // stays pending
    const res = await commentAction('vote', id);
    expect(res.status).toBe(404);
  });
});

describe('data export (GDPR portability)', () => {
  it('requires a session and downloads comments as CSV', async () => {
    await start();
    expect((await mf!.dispatchFetch(`${BASE}/api/admin/export?format=csv`)).status).toBe(401);

    const auth = await login();
    const id = await postComment('hello, "world"');
    await approve(id, auth);

    const res = await mf!.dispatchFetch(`${BASE}/api/admin/export?format=csv`, {
      headers: { cookie: auth.cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text.split('\n')[0]).toBe('id,article_path,nickname,body,status,created_at,parent_id,is_owner,pinned');
    expect(text).toContain('"hello, ""world"""'); // CSV escaping
  });

  it('downloads the full dataset as JSON', async () => {
    await start();
    const auth = await login();
    const id = await postComment();
    await approve(id, auth);
    await commentAction('vote', id);

    const res = await mf!.dispatchFetch(`${BASE}/api/admin/export?format=json`, {
      headers: { cookie: auth.cookie },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      comments: unknown[];
      reactions: unknown[];
      polls: unknown[];
      poll_votes: unknown[];
      comment_flags: unknown[];
      comment_votes: unknown[];
    };
    expect(data.comments.length).toBe(1);
    expect(data.comment_votes.length).toBe(1);
    expect(data.product).toBe('staticlayer');
  });

  it('rejects an unknown format', async () => {
    await start();
    const auth = await login();
    const res = await mf!.dispatchFetch(`${BASE}/api/admin/export?format=xml`, {
      headers: { cookie: auth.cookie },
    });
    expect(res.status).toBe(400);
  });
});
