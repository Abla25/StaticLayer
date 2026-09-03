import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  mineNonce,
  PROTOCOL_VERSION,
  serializeNonce,
} from '@staticlayer/protocol';

/**
 * REMOTE-D1 anti-replay concurrency validation (Issue 2).
 *
 * Runs ONLY when STATICLAYER_REMOTE_BASE is set (e.g.
 *   STATICLAYER_REMOTE_BASE=https://<worker>.workers.dev npx vitest run ...),
 * otherwise the whole suite is skipped — the base URL is deliberately NEVER
 * hardcoded here, so this file is safe to commit.
 *
 * Why: the mandatory local invariant (exactly 1 of N concurrent requests
 * sharing one challenge_id is accepted) is proven against LOCAL Miniflare D1
 * (tests/security/replay-concurrency.test.ts). SECURITY_REVIEW.md §14.4 flags
 * that production REMOTE D1 concurrency needs empirical validation before
 * launch. This file performs that validation over plain HTTPS against the
 * deployed Worker + D1.
 *
 * Notes:
 *  - PoW difficulty and time-gate are discovered/obeyed at runtime (wait past
 *    the 3s default gate before submitting).
 *  - Each successful POST stores ONE pending test comment + ONE consumed
 *    challenge in the remote D1 — clean them up from the admin console.
 */
const BASE = process.env.STATICLAYER_REMOTE_BASE?.replace(/\/+$/, '');
const run = BASE ? describe : describe.skip;

interface RemoteChallenge {
  challengeId: string;
  hostContext: string;
  articlePath: string;
  difficulty: number;
  expiresAt: number;
  signature: string;
}

const NICKNAME = 'RemoteTester';
/** Conservative default TTL used to back-compute the signed issue time. */
const TTL_SECONDS = 300;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchChallenge(articlePath: string): Promise<RemoteChallenge> {
  const res = await fetch(
    `${BASE}/api/comments/challenge?hostContext=example.com&articlePath=${encodeURIComponent(articlePath)}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as RemoteChallenge;
}

async function solve(c: RemoteChallenge, body: string): Promise<bigint> {
  return mineNonce(
    {
      version: PROTOCOL_VERSION,
      hostContext: c.hostContext,
      articlePath: c.articlePath,
      nickname: NICKNAME,
      body,
      challengeId: base64UrlToBytes(c.challengeId),
    },
    c.difficulty,
  );
}

async function waitPastTimeGate(c: RemoteChallenge): Promise<void> {
  const issuedAt = c.expiresAt - TTL_SECONDS;
  const waitMs = (issuedAt + 4) * 1000 - Date.now();
  if (waitMs > 0) await sleep(waitMs);
}

function payload(c: RemoteChallenge, nonce: bigint, body: string) {
  return {
    challengeId: c.challengeId,
    hostContext: c.hostContext,
    articlePath: c.articlePath,
    nickname: NICKNAME,
    body,
    difficulty: c.difficulty,
    expiresAt: c.expiresAt,
    signature: c.signature,
    nonce: serializeNonce(nonce),
  };
}

function submit(p: ReturnType<typeof payload>): Promise<Response> {
  return fetch(`${BASE}/api/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(p),
  });
}

run('remote D1 — anti-replay concurrency (Issue 2, §14.4 validation)', () => {
  it(
    'exactly 1 of N concurrent posts sharing one challenge_id succeeds (rest 409), across K rounds',
    async () => {
      const N = 10;
      const K = 3;
      const summary: string[] = [];
      for (let round = 0; round < K; round += 1) {
        const articlePath = `/remote-concurrency-round-${round}-${Date.now()}`;
        const c = await fetchChallenge(articlePath);
        const body = `remote concurrency probe round ${round}`;
        const nonce = await solve(c, body);
        const p = payload(c, nonce, body);
        await waitPastTimeGate(c);

        const responses = await Promise.all(Array.from({ length: N }, () => submit(p)));
        const statuses = responses.map((r) => r.status);
        const counts = statuses.reduce<Record<number, number>>((acc, s) => {
          acc[s] = (acc[s] ?? 0) + 1;
          return acc;
        }, {});
        summary.push(`round ${round}: ${JSON.stringify(counts)}`);

        expect(counts[200], `round ${round} must have exactly one 200 — got ${summary.join('; ')}`).toBe(1);
        expect(counts[409], `round ${round} must have ${N - 1}× 409 — got ${summary.join('; ')}`).toBe(N - 1);
        expect(counts[429], `round ${round} hit rate limiting — got ${summary.join('; ')}`).toBeUndefined();
      }
      // eslint-disable-next-line no-console
      console.log(`REMOTE anti-replay OK (N=${N}, K=${K}):`, summary.join(' | '));
    },
    120_000,
  );

  it('a sequential replay of the same challenge after success is rejected with 409', async () => {
    const articlePath = `/remote-replay-${Date.now()}`;
    const c = await fetchChallenge(articlePath);
    const body = 'remote sequential replay probe';
    const nonce = await solve(c, body);
    const p = payload(c, nonce, body);
    await waitPastTimeGate(c);

    expect((await submit(p)).status).toBe(200);
    expect((await submit(p)).status).toBe(409);
  }, 120_000);
});
