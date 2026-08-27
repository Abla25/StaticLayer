/**
 * Reactions — anonymous, PoW-protected (mode "a": cost-based integrity).
 *
 * Covers: public aggregate counts, escalating difficulty per article,
 * full POST pipeline (signature → PoW → anti-replay → interval), invalid
 * reaction rejection, disabled deployments, and reaction counts surfaced in
 * the admin articles overview.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { base64UrlToBytes, mineNonce, PROTOCOL_VERSION, serializeNonce } from '@staticlayer/protocol';
import { SECRETS, spawnWorker, type WorkerOptions } from './worker.ts';

const BASE = 'http://localhost';
const ARTICLE = '/blog/reactions';

let mf: Awaited<ReturnType<typeof spawnWorker>> | undefined;

async function start(options: WorkerOptions = {}) {
  mf = await spawnWorker({
    reactionBase: 8, // fast for tests (~tens of ms)
    reactionCeiling: 12,
    reactionEscalationVotes: 3,
    ...options,
  });
  return mf;
}

afterEach(async () => {
  if (mf) {
    await mf.dispose();
    mf = undefined;
  }
});

interface Challenge {
  challengeId: string;
  hostContext: string;
  articlePath: string;
  difficulty: number;
  expiresAt: number;
  signature: string;
}

async function getChallenge(mf: Miniflare, article = ARTICLE): Promise<Challenge> {
  const res = await mf.dispatchFetch(
    `${BASE}/api/reactions/challenge?hostContext=example.com&articlePath=${encodeURIComponent(article)}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Challenge;
}

async function postReaction(mf: Miniflare, challenge: Challenge, reaction: string): Promise<Response> {
  const nonce = await mineNonce(
    {
      version: PROTOCOL_VERSION,
      hostContext: challenge.hostContext,
      articlePath: challenge.articlePath,
      nickname: '',
      body: '',
      challengeId: base64UrlToBytes(challenge.challengeId),
    },
    challenge.difficulty,
  );
  return mf.dispatchFetch(`${BASE}/api/reactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      hostContext: challenge.hostContext,
      articlePath: challenge.articlePath,
      reaction,
      difficulty: challenge.difficulty,
      expiresAt: challenge.expiresAt,
      signature: challenge.signature,
      nonce: serializeNonce(nonce),
    }),
  });
}

async function seedVotes(mf: Miniflare, article: string, n: number): Promise<void> {
  const db = await mf.getD1Database('DB');
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(
    'INSERT INTO reactions (id, article_path, reaction, created_at) VALUES (?, ?, ?, ?)',
  );
  for (let i = 0; i < n; i += 1) {
    // unique ids; old timestamps so the min-interval never interferes
    await stmt
      .bind(`seed-${crypto.randomUUID()}`, article, i % 2 === 0 ? '👍' : '❤️', now - 3600 - i)
      .run();
  }
}

describe('reactions — GET aggregates', () => {
  it('returns empty counts for an article with no reactions', async () => {
    const w = await start();
    const res = await w.dispatchFetch(`${BASE}/api/reactions?article_path=${encodeURIComponent(ARTICLE)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reactions: [] });
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('groups and orders counts', async () => {
    const w = await start();
    await seedVotes(w, ARTICLE, 3); // 2x 👍, 1x ❤️
    const res = await w.dispatchFetch(`${BASE}/api/reactions?article_path=${encodeURIComponent(ARTICLE)}`);
    const body = (await res.json()) as { reactions: { reaction: string; count: number }[] };
    const byR = Object.fromEntries(body.reactions.map((r) => [r.reaction, r.count]));
    expect(byR['👍']).toBe(2);
    expect(byR['❤️']).toBe(1);
  });
});

describe('reactions — escalating difficulty (per article, no identity)', () => {
  it('starts at base and rises every REACTION_ESCALATION_VOTES', async () => {
    const w = await start();
    expect((await getChallenge(w, '/a')).difficulty).toBe(8);
    expect((await getChallenge(w, '/b')).difficulty).toBe(8); // independent articles

    await seedVotes(w, '/a', 3);
    expect((await getChallenge(w, '/a')).difficulty).toBe(9);
    await seedVotes(w, '/a', 3); // total 6
    expect((await getChallenge(w, '/a')).difficulty).toBe(10);
    await seedVotes(w, '/a', 20); // total 26
    expect((await getChallenge(w, '/a')).difficulty).toBe(12); // ceiling
  });
});

describe('reactions — POST pipeline (fail closed)', () => {
  it('accepts a valid reaction and returns fresh counts', async () => {
    const w = await start();
    const challenge = await getChallenge(w);
    const res = await postReaction(w, challenge, '👍');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reactions: { reaction: string; count: number }[] };
    expect(body.ok).toBe(true);
    expect(body.reactions.find((r) => r.reaction === '👍')?.count).toBe(1);
  });

  it('rejects a reaction outside the allowed options', async () => {
    const w = await start();
    const challenge = await getChallenge(w);
    const res = await postReaction(w, challenge, '💣💣💣💣💣');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('not allowed');
  });

  it('rejects an over-long reaction string', async () => {
    const w = await start();
    const challenge = await getChallenge(w);
    const res = await postReaction(w, challenge, 'x'.repeat(17));
    expect(res.status).toBe(400);
  });

  it('reuses one challenge only (atomic anti-replay → 409)', async () => {
    const w = await start();
    const challenge = await getChallenge(w);
    const first = await postReaction(w, challenge, '👍');
    expect(first.status).toBe(200);
    const second = await postReaction(w, challenge, '❤️');
    expect(second.status).toBe(409);
    // only the first vote counted
    const list = await w.dispatchFetch(`${BASE}/api/reactions?article_path=${encodeURIComponent(ARTICLE)}`);
    const body = (await list.json()) as { reactions: { reaction: string; count: number }[] };
    expect(body.reactions.reduce((n, r) => n + r.count, 0)).toBe(1);
  });

  it('enforces the per-article minimum interval', async () => {
    const w = await start({ reactionIntervalSeconds: 60 });
    const c1 = await getChallenge(w);
    expect((await postReaction(w, c1, '👍')).status).toBe(200);
    const c2 = await getChallenge(w);
    const res = await postReaction(w, c2, '❤️');
    expect(res.status).toBe(429);
  });

  it('rejects invalid challenge signatures and expired challenges', async () => {
    const w = await start();
    const challenge = await getChallenge(w);
    const tampered = { ...challenge, difficulty: challenge.difficulty + 1 };
    const bad = await postReaction(w, tampered, '👍');
    expect(bad.status).toBe(400);

    const expired = await getChallenge(w);
    const expiredBody = await postReaction(w, { ...expired, expiresAt: Math.floor(Date.now() / 1000) - 1 }, '👍');
    // signature covers expiresAt, so a tampered expiry fails signature first
    expect(expiredBody.status).toBe(400);
  });

  it('disables reactions when REACTION_OPTIONS is empty', async () => {
    const w = await start({ reactionOptions: '' });
    const res = await w.dispatchFetch(
      `${BASE}/api/reactions/challenge?articlePath=${encodeURIComponent(ARTICLE)}`,
    );
    expect(res.status).toBe(400);
  });
});

describe('reactions — admin articles overview includes counts', () => {
  it('surfaces reaction counts per page (session required)', async () => {
    const w = await start({ reactionIntervalSeconds: 0 });
    await seedVotes(w, '/reaction-only', 2);
    const challenge = await getChallenge(w, '/reaction-only');
    await postReaction(w, challenge, '❤️'); // now 3

    const login = await w.dispatchFetch(`${BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: SECRETS.ADMIN_SECRET }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

    const res = await w.dispatchFetch(`${BASE}/api/admin/articles`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { articles: { article_path: string; reactions: number }[] };
    const page = body.articles.find((a) => a.article_path === '/reaction-only');
    expect(page).toBeTruthy();
    expect(page!.reactions).toBe(3);
  });
});
