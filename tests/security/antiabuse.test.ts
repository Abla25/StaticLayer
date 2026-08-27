/**
 * Anti-abuse, zero-data layer (Round 21.18).
 *
 * ① Honeypot — a filled hidden field is silently dropped (fake "pending",
 *    nothing stored, nothing consumed).
 * ② Time gate — submissions faster than CHALLENGE_TIME_GATE_SECONDS are
 *    rejected with 429; a delayed resubmission of the SAME challenge passes
 *    (proving the 429 does not consume the challenge).
 *
 * Both checks never read, store or persist any content or personal data.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { base64UrlToBytes, mineNonce, PROTOCOL_VERSION, serializeNonce } from '@staticlayer/protocol';
import { SECRETS, spawnWorker, type WorkerOptions } from './worker.ts';

const BASE = 'http://localhost';
const ARTICLE = '/blog/antiabuse';

let mf: Awaited<ReturnType<typeof spawnWorker>> | undefined;

async function start(options: WorkerOptions = {}) {
  mf = await spawnWorker({ difficulty: 8, ...options });
  return mf;
}

afterEach(async () => {
  if (mf) {
    await mf.dispose();
    mf = undefined;
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface CommentChallenge {
  challengeId: string;
  hostContext: string;
  articlePath: string;
  difficulty: number;
  expiresAt: number;
  signature: string;
}

async function getCommentChallenge(mf: Miniflare, article = ARTICLE): Promise<CommentChallenge> {
  const res = await mf.dispatchFetch(
    `${BASE}/api/comments/challenge?hostContext=example.com&articlePath=${encodeURIComponent(article)}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as CommentChallenge;
}

async function postComment(
  mf: Miniflare,
  challenge: CommentChallenge,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const nonce = await mineNonce(
    {
      version: PROTOCOL_VERSION,
      hostContext: challenge.hostContext,
      articlePath: challenge.articlePath,
      nickname: 'Bob',
      body: 'hello antiabuse',
      challengeId: base64UrlToBytes(challenge.challengeId),
    },
    challenge.difficulty,
  );
  return mf.dispatchFetch(`${BASE}/api/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      hostContext: challenge.hostContext,
      articlePath: challenge.articlePath,
      nickname: 'Bob',
      body: 'hello antiabuse',
      difficulty: challenge.difficulty,
      expiresAt: challenge.expiresAt,
      signature: challenge.signature,
      nonce: serializeNonce(nonce),
      ...extra,
    }),
  });
}

async function listComments(mf: Miniflare): Promise<unknown[]> {
  // Comments are stored as 'pending' by default, so count them via the admin
  // queue (public GET only surfaces approved ones).
  const login = await mf.dispatchFetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: SECRETS.ADMIN_SECRET }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const res = await mf.dispatchFetch(`${BASE}/api/admin/comments?status=pending`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { comments: unknown[] };
  return data.comments.filter((c) => (c as { article_path: string }).article_path === ARTICLE);
}

describe('anti-abuse · honeypot (zero data)', () => {
  it('silently drops a submission with a filled honeypot field', async () => {
    const worker = await start();
    const challenge = await getCommentChallenge(worker);
    const res = await postComment(worker, challenge, { honeypot: 'http://spam.example' });

    // The bot receives a PLAUSIBLE fake success — it must not learn anything.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comment: { status: string } };
    expect(body.comment.status).toBe('pending');

    // ...but nothing was persisted.
    expect(await listComments(worker)).toHaveLength(0);
  });

  it('an empty honeypot field does NOT trigger the drop', async () => {
    const worker = await start();
    const challenge = await getCommentChallenge(worker);
    const res = await postComment(worker, challenge, { honeypot: '' }); // real users send ''
    expect(res.status).toBe(200);
    expect(await listComments(worker)).toHaveLength(1);
  });
});

describe('anti-abuse · time gate', () => {
  it('rejects a submission faster than the gate with 429', async () => {
    const worker = await start({ timeGateSeconds: 3 });
    const challenge = await getCommentChallenge(worker);

    // PoW at difficulty 8 takes ~ms — well under the 3s gate.
    const res = await postComment(worker, challenge);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('submitted too quickly');

    // Nothing was persisted by the rejected submission.
    expect(await listComments(worker)).toHaveLength(0);
  });

  it('accepts the same challenge once enough time has passed (429 does not consume)', async () => {
    const worker = await start({ timeGateSeconds: 3 });
    const challenge = await getCommentChallenge(worker);

    const fast = await postComment(worker, challenge);
    expect(fast.status).toBe(429);

    // Wait past the gate (3s + margin) and resubmit the SAME challenge.
    await sleep(3400);
    const slow = await postComment(worker, challenge);
    expect(slow.status).toBe(200);

    const comments = await listComments(worker);
    expect(comments).toHaveLength(1);
  });

  it('gate 0 (default) accepts immediate submissions', async () => {
    const worker = await start(); // timeGateSeconds undefined → 0
    const challenge = await getCommentChallenge(worker);
    const res = await postComment(worker, challenge);
    expect(res.status).toBe(200);
    expect(await listComments(worker)).toHaveLength(1);
  });
});
