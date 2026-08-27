# Phase 1 Review Dump

> Complete, untruncated contents of the Phase 1 security-critical files.
> Generated 2026-08-26 for manual review.

## Concurrency & Anti-Replay Fix Explanation

### The problem with the naive batch

The naive approach suggested in the Phase 1 spec was:

```sql
-- statement 1
INSERT OR IGNORE INTO used_challenges (challenge_id, used_at) VALUES (?, ?);
-- statement 2 (UNCONDITIONAL)
INSERT INTO comments (id, article_path, nickname, body, status, created_at, challenge_id)
VALUES (?, ?, ?, ?, ?, ?, ?);
```

Both statements run inside ONE `env.DB.batch()` transaction. When a request
loses the anti-replay race, `INSERT OR IGNORE` inserts nothing
(`meta.changes === 0`), **but the second statement still executes** — SQLite
does not abort the transaction just because `INSERT OR IGNORE` ignored a row.
The result: a duplicate comment (fresh UUID, same content) is committed to the
database *before* the handler can inspect `results[0].meta.changes` and return
`409`. That breaks the invariant "exactly one accepted comment per challenge".

### The fix: conditional comment insert

The comment insert is made conditional on the current transaction actually
having consumed the challenge:

```sql
INSERT INTO comments (id, article_path, nickname, body, status, created_at, challenge_id)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
WHERE changes() = 1;
```

How this guarantees **a duplicate comment is NEVER saved**:

1. `INSERT OR IGNORE` runs first in the batch. `changes()` (a SQLite
   connection-scoped function) then reports the number of rows written by that
   most recently completed write: **1** if this transaction inserted the
   challenge row, **0** if the row already existed (a previous/concurrent
   request won the race).
2. Because both statements execute on the **same connection, sequentially,
   inside the same transaction**, the `SELECT` in statement 2 evaluates
   `changes()` against statement 1. This is exactly the "execute and commit,
   sequentially, non-concurrently" behavior D1 documents for `batch()`.
3. If `changes() = 1` (this batch consumed the challenge), the `SELECT` yields
   exactly one row and the comment is inserted — atomically with the consume.
4. If `changes() = 0` (challenge already used), the `SELECT` yields zero rows
   and **no comment row is written** — the losing request stores nothing.

Under heavy concurrency, D1 serializes the batches (single-writer SQLite
transaction). Exactly one batch observes `changes() = 1`; every other batch
observes `changes() = 0` and writes no comment. No code path can insert a
comment without also consuming the challenge in the same transaction, and no
losing request can leave a comment behind.

### How `meta.changes` produces the 409

After `batch()` resolves:

```ts
const consumed = results[0].meta.changes;   // INSERT OR IGNORE result
const inserted = results[1].meta.changes;   // conditional comment insert result

if (consumed === 0) {
  return json({ error: 'Challenge Already Used' }, 409);
}
if (inserted !== 1) {
  // consumed === 1 but no comment row => internal inconsistency; never store silently
  return json({ error: 'comment not stored' }, 500);
}
```

- `results[0].meta.changes === 0` → the challenge was already consumed →
  return **409 Challenge Already Used** (and the batch wrote nothing).
- `results[0].meta.changes === 1` AND `results[1].meta.changes === 1` → this
  request consumed the challenge AND stored the comment → return **200** with
  the comment.
- Any `batch()` failure → the entire transaction rolls back → the challenge is
  **not** consumed and no comment is stored → return 500 (a failed store never
  burns a valid proof).

This logic is proven empirically by
`tests/security/replay-concurrency.test.ts`: **10 concurrent posts sharing one
`challenge_id` → exactly 1× 200 + 9× 409, and the store holds exactly 1 comment
and 1 consumed challenge** (asserted with `COUNT(*)` on both tables, not just
HTTP status codes).

---

## `packages/runtime/src/comments.ts`

```ts
import {
  base64UrlToBytes,
  encodeCanonicalPayload,
  MAX_ARTICLE_PATH_BYTES,
  MAX_BODY_BYTES,
  MAX_HOST_CONTEXT_BYTES,
  MAX_NICKNAME_BYTES,
  parseNonce,
  PROTOCOL_VERSION,
  ProtocolError,
  utf8EncodeStrict,
  verifyChallenge,
  verifyPow,
  type ChallengeFields,
} from '@staticlayer/protocol';
import type { D1Result } from '@cloudflare/workers-types';
import { DEFAULTS, envNumber, type Env } from './env.ts';
import { json, readJsonBody } from './http.ts';
import { applyRateLimit } from './ratelimit.ts';

/**
 * POST /api/comments
 *
 * Full verification pipeline — every step FAILS CLOSED:
 *   1. body byte cap (MAX_REQUEST_BYTES) + strict field type checks;
 *   2. UTF-8 strictness + byte-length limits (255/255/50/3000) via the protocol;
 *   3. challenge signature verification (HMAC-SHA256, constant-time);
 *   4. challenge expiry;
 *   5. difficulty must equal the configured value (defense in depth);
 *   6. proof-of-work over the canonical payload (leading-zero bits);
 *   7. ATOMIC anti-replay: consume the challenge + insert the comment in ONE
 *      D1 batch() transaction.
 *
 * ANTI-REPLAY (SECURITY INVARIANT):
 *   The comment INSERT is guarded by `WHERE changes() = 1`, i.e. it only fires
 *   when THIS batch actually consumed the challenge (INSERT OR IGNORE inserted
 *   a row). Without that guard, a request that loses the race (changes === 0)
 *   would still insert a duplicate comment before we return 409 — breaking
 *   "exactly one accepted comment per challenge". `changes()` reflects the most
 *   recently completed write on the same connection, i.e. statement 1 of this
 *   batch (verified empirically by tests/security/replay-concurrency.test.ts).
 *
 *   D1 batch() is a transaction (docs/cloudflare-assumptions.md §2): if the
 *   comment insert fails, the whole batch rolls back and the challenge is NOT
 *   consumed, so a failed store never burns the proof.
 */

interface SubmitFields {
  challengeIdB64: string;
  hostContext: string;
  articlePath: string;
  nickname: string;
  body: string;
  difficulty: number;
  expiresAt: number;
  signatureB64: string;
  nonce: bigint;
}

function requireString(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' ? value : null;
}

/** Strict UTF-8 byte length of a field, or null when invalid/over-limit. */
function validField(value: string, maxBytes: number): boolean {
  let len: number;
  try {
    len = utf8EncodeStrict(value).length;
  } catch {
    return false;
  }
  return len <= maxBytes;
}

export async function handleSubmitComment(request: Request, env: Env): Promise<Response> {
  const limited = await applyRateLimit(env.RATE_LIMITER, 'comments');
  if (limited) return limited;

  const maxBytes = envNumber(env.MAX_REQUEST_BYTES, DEFAULTS.MAX_REQUEST_BYTES);
  const read = await readJsonBody(request, maxBytes);
  if (!read.ok) {
    return json(
      { error: read.status === 413 ? 'request body too large' : 'invalid JSON body' },
      read.status,
    );
  }
  const data = read.value;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return json({ error: 'body must be a JSON object' }, 400);
  }
  const record = data as Record<string, unknown>;

  // ---- strict field extraction (fail closed on wrong types) ----
  const challengeIdB64 = requireString(record, 'challengeId');
  const hostContext = requireString(record, 'hostContext');
  const articlePath = requireString(record, 'articlePath');
  const body = requireString(record, 'body');
  const signatureB64 = requireString(record, 'signature');
  const difficulty = record.difficulty;
  const expiresAt = record.expiresAt;
  if (!challengeIdB64 || !hostContext || !articlePath || !body || !signatureB64) {
    return json({ error: 'missing required fields' }, 400);
  }
  // nickname is optional (anonymous comments): missing => '', but a present
  // non-string value is rejected (fail closed).
  let nickname = '';
  if (record.nickname !== undefined) {
    const nick = requireString(record, 'nickname');
    if (nick === null) return json({ error: 'nickname must be a string' }, 400);
    nickname = nick;
  }
  if (typeof difficulty !== 'number' || !Number.isSafeInteger(difficulty) || difficulty < 0) {
    return json({ error: 'difficulty must be a non-negative integer' }, 400);
  }
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    return json({ error: 'expiresAt must be a non-negative integer' }, 400);
  }

  let nonce: bigint;
  let challengeId: Uint8Array;
  let signature: Uint8Array;
  try {
    nonce = parseNonce(record.nonce);
    challengeId = base64UrlToBytes(challengeIdB64);
    signature = base64UrlToBytes(signatureB64);
  } catch {
    return json({ error: 'invalid challengeId, signature or nonce encoding' }, 400);
  }

  // ---- 2. UTF-8 strictness + byte limits (fail closed, before any crypto) ----
  if (!validField(hostContext, MAX_HOST_CONTEXT_BYTES)) {
    return json({ error: `hostContext must be valid UTF-8 within ${MAX_HOST_CONTEXT_BYTES} bytes` }, 400);
  }
  if (!validField(articlePath, MAX_ARTICLE_PATH_BYTES)) {
    return json({ error: `articlePath must be valid UTF-8 within ${MAX_ARTICLE_PATH_BYTES} bytes` }, 400);
  }
  if (!validField(nickname, MAX_NICKNAME_BYTES)) {
    return json({ error: `nickname must be valid UTF-8 within ${MAX_NICKNAME_BYTES} bytes` }, 400);
  }
  if (!validField(body, MAX_BODY_BYTES)) {
    return json({ error: `body must be valid UTF-8 within ${MAX_BODY_BYTES} bytes` }, 400);
  }

  // ---- 3. challenge signature (constant-time, fail closed) ----
  const challenge: ChallengeFields = {
    version: PROTOCOL_VERSION,
    hostContext,
    articlePath,
    challengeId,
    expiresAt: BigInt(expiresAt),
    difficulty,
  };
  if (!(await verifyChallenge(challenge, signature, env.POW_SECRET))) {
    return json({ error: 'invalid challenge signature' }, 400);
  }

  // ---- 4. expiry (fail closed) ----
  const nowSec = Math.floor(Date.now() / 1000);
  if (expiresAt <= nowSec) {
    return json({ error: 'challenge expired' }, 410);
  }

  // ---- 5. difficulty must match the configured value ----
  const expectedDifficulty = envNumber(env.POW_DIFFICULTY, DEFAULTS.POW_DIFFICULTY);
  if (difficulty !== expectedDifficulty) {
    return json({ error: 'unexpected difficulty' }, 400);
  }

  // ---- 6. proof of work over the canonical payload ----
  let canonical: Uint8Array;
  try {
    canonical = encodeCanonicalPayload({
      version: PROTOCOL_VERSION,
      hostContext,
      articlePath,
      nickname,
      body,
      challengeId,
      nonce,
    });
  } catch (err) {
    if (err instanceof ProtocolError) return json({ error: err.message }, 400);
    throw err;
  }
  if (!(await verifyPow(canonical, difficulty))) {
    return json({ error: 'invalid proof of work' }, 400);
  }

  // ---- 7. ATOMIC anti-replay ----
  const id = crypto.randomUUID();
  const createdAt = nowSec;
  const status = 'published';

  const consume = env.DB.prepare(
    'INSERT OR IGNORE INTO used_challenges (challenge_id, used_at) VALUES (?, ?)',
  ).bind(challengeIdB64, createdAt);

  // Conditional insert: only fires when THIS batch consumed the challenge.
  const insertComment = env.DB.prepare(
    `INSERT INTO comments (id, article_path, nickname, body, status, created_at, challenge_id)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE changes() = 1`,
  ).bind(id, articlePath, nickname, body, status, createdAt, challengeIdB64);

  let results: D1Result[];
  try {
    results = await env.DB.batch([consume, insertComment]);
  } catch {
    // Whole transaction rolled back => challenge NOT consumed.
    return json({ error: 'storage error' }, 500);
  }

  const consumed = results[0].meta.changes;
  if (consumed === 0) {
    return json({ error: 'Challenge Already Used' }, 409);
  }

  const inserted = results[1].meta.changes;
  if (inserted !== 1) {
    // Defensive: consumed === 1 but no comment row => internal inconsistency.
    return json({ error: 'comment not stored' }, 500);
  }

  return json({
    comment: {
      id,
      article_path: articlePath,
      nickname,
      body,
      status,
      created_at: createdAt,
    },
  });
}
```

---

## `packages/protocol/src/base64url.ts`

```ts
import { ProtocolError } from './errors.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP: Int16Array = buildLookup();

function buildLookup(): Int16Array {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
}

/**
 * RFC 4648 §5 base64url WITHOUT padding.
 * Used for `challenge_id` and `signature` in the API JSON.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : undefined;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : undefined;

    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) {
      out += ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    }
    if (b2 !== undefined) {
      out += ALPHABET[b2 & 0x3f];
    }
  }
  return out;
}

/**
 * Strict base64url (no padding) decoder. Rejects padding, whitespace and any
 * character outside the base64url alphabet (fail closed).
 */
export function base64UrlToBytes(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  if (input.includes('=')) {
    throw new ProtocolError('base64url input must not contain padding');
  }
  if (input.length % 4 === 1) {
    throw new ProtocolError('base64url input has invalid length');
  }

  const out: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const value = code < 128 ? LOOKUP[code] : -1;
    if (value < 0) {
      throw new ProtocolError(`invalid base64url character at index ${i}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Hex encoding (lowercase) — used for test vectors and debugging only. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** Strict hex decoder (even length, [0-9a-fA-F] only). */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new ProtocolError('hex input must have even length');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = parseInt(hex[i * 2] as string, 16);
    const lo = parseInt(hex[i * 2 + 1] as string, 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) {
      throw new ProtocolError('hex input contains non-hex characters');
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}
```

---

## `migrations/001_initial.sql`

```sql
-- StaticLayer v1 — initial schema (Phase 1)
-- D1 / SQLite. Applied via `wrangler d1 migrations apply` (see
-- docs/cloudflare-assumptions.md §7).

-- Anti-replay table. `challenge_id` is the canonical base64url text form of
-- the 32-byte CSPRNG challenge id. It is the single-writer PK that makes the
-- atomic anti-replay invariant hold: INSERT OR IGNORE + meta.changes check in
-- one D1 batch() transaction.
CREATE TABLE IF NOT EXISTS used_challenges (
  challenge_id TEXT PRIMARY KEY,
  used_at      INTEGER NOT NULL
) WITHOUT ROWID;

-- Public comments. `status` is plain-text pipeline state ('published' for v1).
-- `challenge_id` records which challenge was consumed by this comment.
CREATE TABLE IF NOT EXISTS comments (
  id           TEXT PRIMARY KEY,
  article_path TEXT NOT NULL,
  nickname     TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  challenge_id TEXT NOT NULL
) WITHOUT ROWID;

-- Listing endpoint reads are ordered per article.
CREATE INDEX IF NOT EXISTS idx_comments_article_path
  ON comments (article_path, created_at);
```

---

## `tests/security/replay-concurrency.test.ts`

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { base64UrlToBytes, mineNonce, PROTOCOL_VERSION, serializeNonce } from '@staticlayer/protocol';
import { SECRETS, spawnWorker } from './worker.ts';

const BASE = 'http://localhost';

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
    payload.signature =
      payload.signature.slice(0, -1) + (payload.signature.endsWith('A') ? 'B' : 'A');
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
```

---

## `wrangler.jsonc`

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "staticlayer",
  "main": "packages/runtime/src/index.ts",
  "compatibility_date": "2026-08-26",
  "workers_dev": false,

  // Non-secret, tunable runtime configuration.
  // Secrets (ADMIN_SECRET, SESSION_SECRET, POW_SECRET) are declared below and
  // must be set via `wrangler secret put` (or `.dev.vars` for local dev).
  "vars": {
    "POW_DIFFICULTY": 16,
    "CHALLENGE_TTL_SECONDS": 300,
    "SESSION_TTL_SECONDS": 7200,
    "MAX_REQUEST_BYTES": 65536
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "staticlayer",
      // Run `wrangler d1 create staticlayer` and paste the returned ID here.
      "database_id": "REPLACE_WITH_D1_DATABASE_ID",
      "migrations_dir": "migrations"
    }
  ],

  // Edge-local rate limiting (see docs/cloudflare-assumptions.md §5).
  // namespace_id is an account-unique integer; see the Rate Limiting docs.
  "ratelimits": [
    {
      "name": "RATE_LIMITER",
      "namespace_id": "REPLACE_WITH_RATELIMIT_NAMESPACE_ID",
      "simple": {
        "limit": 60,
        "period": 60
      }
    }
  ],

  // Exactly three secrets, strictly separated roles (see SECURITY_REVIEW.md §6).
  "secrets": {
    "required": ["ADMIN_SECRET", "SESSION_SECRET", "POW_SECRET"]
  }
}
```
