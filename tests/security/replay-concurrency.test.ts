import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { base64UrlToBytes, bytesToBase64Url, mineNonce, PROTOCOL_VERSION, serializeNonce } from '@staticlayer/protocol';
import { SECRETS, spawnWorker } from './worker.ts';

const BASE = 'http://localhost';

/**
 * LOCAL D1 concurrency test for the anti-replay invariant (I5). While the D1
 * docs guarantee batch atomicity, production REMOTE D1 concurrency has now
 * ALSO been validated empirically (2026-09-04) against the deployed Worker +
 * production D1 — see tests/security/remote-concurrency.test.ts (runs only
 * when STATICLAYER_REMOTE_BASE is set) and SECURITY_REVIEW.md §14.4.
 */

/**
 * MANDATORY SECURITY INVARIANT (SECURITY_REVIEW.md I5):
 *   N concurrent requests that reuse the same valid `challenge_id` must result
 *   in EXACTLY ONE accepted comment. This is proven empirically here against
 *   the real Worker + local D1 in workerd — never inferred from code alone.
 */

interface Challenge {
  challengeId: string;
  hostContext: string;
  articlePath: string;
  difficulty: number;
  expiresAt: number;
  signature: string;
}

interface PostPayload {
  challengeId: string;
  hostContext: string;
  articlePath: string;
  nickname: string;
  body: string;
  difficulty: number;
  expiresAt: number;
  signature: string;
  nonce: number | string;
}

const NICKNAME = 'Alice';

async function obtainChallenge(mf: Miniflare, articlePath = '/blog/hello'): Promise<Challenge> {
  const res = await mf.dispatchFetch(
    `${BASE}/api/comments/challenge?hostContext=example.com&articlePath=${encodeURIComponent(articlePath)}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Challenge;
}

async function solve(challenge: Challenge, body: string): Promise<bigint> {
  return mineNonce(
    {
      version: PROTOCOL_VERSION,
      hostContext: challenge.hostContext,
      articlePath: challenge.articlePath,
      nickname: NICKNAME,
      body,
      challengeId: base64UrlToBytes(challenge.challengeId),
    },
    challenge.difficulty,
  );
}

function buildPayload(challenge: Challenge, nonce: bigint, body: string): PostPayload {
  return {
    challengeId: challenge.challengeId,
    hostContext: challenge.hostContext,
    articlePath: challenge.articlePath,
    nickname: NICKNAME,
    body,
    difficulty: challenge.difficulty,
    expiresAt: challenge.expiresAt,
    signature: challenge.signature,
    nonce: serializeNonce(nonce),
  };
}

function submit(mf: Miniflare, payload: PostPayload): Promise<Response> {
  return mf.dispatchFetch(`${BASE}/api/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('anti-replay — challenge consumption', () => {
  let mf: Miniflare | undefined;
  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it('MANDATORY: exactly 1 of 10 concurrent posts sharing one challenge_id succeeds (rest 409)', async () => {
    mf = await spawnWorker({ difficulty: 16 });
    const challenge = await obtainChallenge(mf);
    const body = 'Hello, concurrent world!';
    const nonce = await solve(challenge, body);
    const payload = buildPayload(challenge, nonce, body);

    const N = 10;
    const responses = await Promise.all(
      Array.from({ length: N }, () => submit(mf as Miniflare, payload)),
    );

    const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(N - 1);

    // The store holds exactly one comment and exactly one consumed challenge.
    const db = await (mf as Miniflare).getD1Database('DB');
    const comments = await db.prepare('SELECT COUNT(*) AS c FROM comments').first();
    const used = await db.prepare('SELECT COUNT(*) AS c FROM used_challenges').first();
    expect(comments?.c).toBe(1);
    expect(used?.c).toBe(1);
  });

  it('rejects a sequential replay of the same challenge (409) without storing a duplicate', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const challenge = await obtainChallenge(mf);
    const nonce = await solve(challenge, 'first');
    const payload = buildPayload(challenge, nonce, 'first');

    expect((await submit(mf, payload)).status).toBe(200);
    expect((await submit(mf, payload)).status).toBe(409);

    const db = await mf.getD1Database('DB');
    expect((await db.prepare('SELECT COUNT(*) AS c FROM comments').first())?.c).toBe(1);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM used_challenges').first())?.c).toBe(1);
  });

  it('accepts a NEW challenge after one was consumed (table does not over-block)', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const c1 = await obtainChallenge(mf);
    expect((await submit(mf, buildPayload(c1, await solve(c1, 'one'), 'one'))).status).toBe(200);

    const c2 = await obtainChallenge(mf);
    expect((await submit(mf, buildPayload(c2, await solve(c2, 'two'), 'two'))).status).toBe(200);

    const db = await mf.getD1Database('DB');
    expect((await db.prepare('SELECT COUNT(*) AS c FROM comments').first())?.c).toBe(2);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM used_challenges').first())?.c).toBe(2);
  });

  it('rejects an expired challenge with 410', async () => {
    mf = await spawnWorker({ difficulty: 8, challengeTtlSeconds: 0 });
    const challenge = await obtainChallenge(mf); // expiresAt <= now immediately
    // No mining needed: expiry is verified before PoW.
    const res = await submit(mf, buildPayload(challenge, 0n, 'too late'));
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/expired/i) });
  });

  it('rejects a proof that does not satisfy the difficulty (400 invalid proof of work)', async () => {
    mf = await spawnWorker({ difficulty: 24 });
    const challenge = await obtainChallenge(mf);
    const res = await submit(mf, buildPayload(challenge, 0n, 'no work done'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/proof of work/i) });
  });

  it('rejects a tampered challenge signature (400)', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const challenge = await obtainChallenge(mf);
    const payload = buildPayload(challenge, await solve(challenge, 'tampered'), 'tampered');
    // Deterministic, robust tamper: flip a byte in the MIDDLE of the decoded
    // signature, then re-encode. This can never re-encode to the original
    // signature (unlike flipping the final base64 character, whose effective
    // bits depend on the padding semantics of the encoded length).
    const sig = base64UrlToBytes(payload.signature);
    sig[Math.floor(sig.length / 2)] ^= 0x01;
    payload.signature = bytesToBase64Url(sig);
    const res = await submit(mf, payload);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/signature/i) });
  });

  it('rejects a comment body over the 3000-byte limit (400)', async () => {
    mf = await spawnWorker({ difficulty: 8 });
    const challenge = await obtainChallenge(mf);
    const payload = buildPayload(challenge, await solve(challenge, 'x'), 'x');
    payload.body = 'b'.repeat(3001);
    const res = await submit(mf, payload);
    expect(res.status).toBe(400);
  });
});

/**
 * Issue: "Load-test solve-flooding against D1 daily write cap".
 *
 * What a solve-flood looks like at the data layer: an attacker mints and
 * submits many VALID pre-solved challenges. The only D1 writes are on submit
 * (used_challenges + comment in ONE batch), and the retention cron bounds the
 * table to ~24h of traffic. These tests prove the flood invariants that the
 * quota math relies on, deterministically on the local engine:
 *   - every unique valid solve is accepted EXACTLY once → DB growth is 1:1
 *     with accepted comments (no duplicates, no orphaned challenge rows);
 *   - replaying/storming any consumed challenge NEVER adds rows (409) — the
 *     anti-replay table cannot be grown by replay traffic.
 * (The absolute 100k rows-written/day free cap itself cannot be exercised
 * against local Miniflare — that is a REMOTE-D1 launch check, see
 * SECURITY_REVIEW.md §14.4.)
 */
describe('anti-replay — solve flood growth (Issue: load-test solve-flooding)', () => {
  let mf: Miniflare | undefined;
  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it('N unique pre-solved challenges submitted concurrently: all accepted once, DB grows 1:1', async () => {
    mf = await spawnWorker({ difficulty: 6 });
    const N = 20;
    const payloads: PostPayload[] = [];
    for (let i = 0; i < N; i += 1) {
      const c = await obtainChallenge(mf, `/flood/${i}`);
      payloads.push(buildPayload(c, await solve(c, `flood body ${i}`), `flood body ${i}`));
    }

    const responses = await Promise.all(payloads.map((p) => submit(mf as Miniflare, p)));
    for (const r of responses) {
      expect(r.status).toBe(200);
    }

    const db = await (mf as Miniflare).getD1Database('DB');
    expect((await db.prepare('SELECT COUNT(*) AS c FROM comments').first())?.c).toBe(N);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM used_challenges').first())?.c).toBe(N);
  });

  it('replay storm of every consumed challenge never grows comments or used_challenges', async () => {
    mf = await spawnWorker({ difficulty: 6 });
    const N = 8;
    const payloads: PostPayload[] = [];
    for (let i = 0; i < N; i += 1) {
      const c = await obtainChallenge(mf, `/storm/${i}`);
      payloads.push(buildPayload(c, await solve(c, `storm ${i}`), `storm ${i}`));
    }
    for (const p of payloads) {
      expect((await submit(mf as Miniflare, p)).status).toBe(200);
    }

    // Blast every consumed challenge again, 5 concurrent replays each.
    const storms: Promise<Response>[] = [];
    for (const p of payloads) {
      for (let k = 0; k < 5; k += 1) storms.push(submit(mf as Miniflare, p));
    }
    const responses = await Promise.all(storms);
    for (const r of responses) {
      expect(r.status).toBe(409);
    }

    const db = await (mf as Miniflare).getD1Database('DB');
    expect((await db.prepare('SELECT COUNT(*) AS c FROM comments').first())?.c).toBe(N);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM used_challenges').first())?.c).toBe(N);
  });
});

describe('admin login skeleton', () => {
  let mf: Miniflare | undefined;
  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it('rejects a wrong ADMIN_SECRET with 401', async () => {
    mf = await spawnWorker();
    const res = await mf.dispatchFetch(`${BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts the correct ADMIN_SECRET and sets a __Host- cookie WITHOUT Domain', async () => {
    mf = await spawnWorker();
    const res = await mf.dispatchFetch(`${BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: SECRETS.ADMIN_SECRET }),
    });
    expect(res.status).toBe(200);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('__Host-StaticLayerSession=');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toMatch(/Domain=/i);

    const body = (await res.json()) as { csrf?: string };
    expect(typeof body.csrf).toBe('string');
    expect(body.csrf).toBeTruthy();
  });

  it('keeps working when the RATE_LIMITER binding is present', async () => {
    mf = await spawnWorker({ withRateLimiter: true });
    const res = await mf.dispatchFetch(
      `${BASE}/api/comments/challenge?hostContext=example.com&articlePath=/x`,
    );
    expect(res.status).toBe(200);
  });
});
