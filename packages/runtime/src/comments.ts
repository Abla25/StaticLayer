import {
  base64UrlToBytes,
  bytesToBase64Url,
  encodeCanonicalCommentActionPayload,
  encodeCanonicalPayload,
  MAX_ARTICLE_PATH_BYTES,
  MAX_BODY_BYTES,
  MAX_COMMENT_ID_BYTES,
  MAX_HOST_CONTEXT_BYTES,
  MAX_NICKNAME_BYTES,
  parseNonce,
  PROTOCOL_VERSION,
  ProtocolError,
  randomBytes,
  sha256,
  utf8EncodeStrict,
  verifyChallenge,
  verifyPow,
  type ChallengeFields,
} from '@staticlayer/protocol';
import type { D1Result } from '@cloudflare/workers-types';
import { DEFAULTS, envNumber, type Env } from './env.ts';
import { json, readJsonBody, validField } from './http.ts';
import { applyRateLimit } from './ratelimit.ts';
import { readSettings, settingModerationMode, settingNumber } from './settings.ts';
import { decide, readLists } from './moderation-lists.ts';
import { findBlockedTerm, readBlockedTerms } from './blocked-terms.ts';
import { notifyPendingComment } from './telegram.ts';
import { fakePendingComment, isHoneypotTriggered, timeGateResponse } from './antiabuse.ts';
import { signVoterToken, verifyVoterToken } from './polls.ts';

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

  // ---- 0.5 honeypot (anti-bot, zero data): silently drop filled honeypots ---
  // A hidden field that real humans never see. Triggered => return a plausible
  // fake "pending" so the bot learns nothing; nothing is stored or consumed.
  if (isHoneypotTriggered(record)) {
    return fakePendingComment();
  }

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
  // Optional nested reply: parent_id (validated server-side — the parent must
  // exist, be approved and belong to the same article). The PoW payload does
  // not cover parent_id: it is pure routing, and content+volume stay protected
  // by PoW + anti-replay + rate limits, so re-pointing a reply is not an
  // abuse vector.
  let parentId: string | null = null;
  if (record.parentId !== undefined) {
    const pid = requireString(record, 'parentId');
    if (pid === null) return json({ error: 'parentId must be a string' }, 400);
    parentId = pid;
  }
  if (parentId !== null && parentId.length > 64) return json({ error: 'parentId too long' }, 400);

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

  // ---- 4.1 time gate (anti-bot, zero data) ----
  const gateRes = timeGateResponse(env, nowSec, expiresAt);
  if (gateRes) return gateRes;

  // ---- 4.5 live settings (the admin panel can change difficulty without a redeploy) ----
  const settings = await readSettings(env.DB);

  // ---- 5. difficulty must match the configured value ----
  const expectedDifficulty = settingNumber(
    settings,
    'pow_difficulty',
    envNumber(env.POW_DIFFICULTY, DEFAULTS.POW_DIFFICULTY),
  );
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

  // ---- 6.5 moderation lists (block / allowlist auto-approve / allowlist-only mode) ----
  const mode = settingModerationMode(settings, 'open');
  const lists = await readLists(env.DB);
  const decision = decide(nickname, lists);
  if (decision.verdict === 'blocked') {
    return json({ error: 'this nickname is not allowed' }, 403);
  }
  // ---- 6.6 blocked terms (word blacklist) — auto-reject, never stored ----
  const blockedTerm = findBlockedTerm(body, await readBlockedTerms(env.DB));
  if (blockedTerm) {
    return json({ error: 'comment contains a blocked term' }, 403);
  }
  let status = 'pending'; // moderation pipeline: pending -> approved (Phase 2)
  if (decision.verdict === 'allowlisted') {
    status = 'approved'; // allowlisted commenters skip the queue
  } else if (mode === 'allowlist') {
    return json({ error: 'only allowlisted commenters can comment' }, 403);
  }

  // ---- 7. ATOMIC anti-replay ----
  // ---- 6.7 nested reply: the parent must exist, be approved, same article ----
  if (parentId !== null) {
    const parent = await env.DB
      .prepare('SELECT id, status, article_path FROM comments WHERE id = ?')
      .bind(parentId)
      .first<{ id: string; status: string; article_path: string }>();
    if (!parent) return json({ error: 'parent comment not found' }, 400);
    if (parent.status !== 'approved') return json({ error: 'cannot reply to a comment that is not approved' }, 400);
    if (parent.article_path !== articlePath) return json({ error: 'parent comment is on a different article' }, 400);
  }

  const id = crypto.randomUUID();
  const createdAt = nowSec;

  const consume = env.DB.prepare(
    'INSERT OR IGNORE INTO used_challenges (challenge_id, used_at) VALUES (?, ?)',
  ).bind(challengeIdB64, createdAt);

  // Conditional insert: only fires when THIS batch consumed the challenge.
  const insertComment = env.DB.prepare(
    `INSERT INTO comments (id, article_path, nickname, body, status, created_at, challenge_id, parent_id)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
     WHERE changes() = 1`,
  ).bind(id, articlePath, nickname, body, status, createdAt, challengeIdB64, parentId);

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

  // Owner notification when the comment enters the moderation queue.
  // GDPR-minimal: the alert carries no comment data — only the page where the
  // comment arrived + the admin link (see telegram.ts). Best-effort; never
  // blocks or fails the submit.
  if (status === 'pending') {
    const origin = new URL(request.url).origin;
    await notifyPendingComment(env, `${origin}/admin.html`, { hostContext, articlePath });
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

/**
 * POST /api/comments/flag
 *
 * Minimal, privacy-first visitor "report". Body mirrors a comment submission
 * but targets a commentId and is bound to a dedicated canonical action schema
 * (action 'flag'). The same pipeline applies: rate limit → signed challenge →
 * expiry → time gate → PoW → ATOMIC anti-replay. On success a row is added to
 * `comment_flags`; the owner sees the count in moderation. The flag stores ONLY
 * { comment_id, created_at, challenge_id } — no reason text, no identity.
 */
export async function handleFlagComment(request: Request, env: Env): Promise<Response> {
  const limited = await applyRateLimit(env.RATE_LIMITER, 'comments');
  if (limited) return limited;

  const maxBytes = envNumber(env.MAX_REQUEST_BYTES, DEFAULTS.MAX_REQUEST_BYTES);
  const read = await readJsonBody(request, maxBytes);
  if (!read.ok || typeof read.value !== 'object' || read.value === null) {
    return json({ error: read.ok ? 'body must be a JSON object' : 'invalid JSON body' }, read.ok ? 400 : read.status);
  }
  const data = read.value as Record<string, unknown>;
  const challengeIdB64 = requireString(data, 'challengeId');
  const hostContext = requireString(data, 'hostContext');
  const articlePath = requireString(data, 'articlePath');
  const commentId = requireString(data, 'commentId');
  const signatureB64 = requireString(data, 'signature');
  const difficulty = data.difficulty;
  const expiresAt = data.expiresAt;
  if (!challengeIdB64 || !hostContext || !articlePath || !commentId || !signatureB64) {
    return json({ error: 'missing required fields' }, 400);
  }
  if (typeof difficulty !== 'number' || !Number.isSafeInteger(difficulty) || difficulty < 0) {
    return json({ error: 'difficulty must be a non-negative integer' }, 400);
  }
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    return json({ error: 'expiresAt must be a non-negative integer' }, 400);
  }
  if (commentId.length > MAX_COMMENT_ID_BYTES) {
    return json({ error: 'commentId too long' }, 400);
  }
  if (!validField(articlePath, MAX_ARTICLE_PATH_BYTES) || !validField(hostContext, MAX_HOST_CONTEXT_BYTES)) {
    return json({ error: 'invalid hostContext or articlePath' }, 400);
  }

  // The flagged comment must exist and be publicly visible.
  const comment = await env.DB.prepare(
    'SELECT id FROM comments WHERE id = ? AND status = ? LIMIT 1',
  ).bind(commentId, 'approved').first<{ id: string }>();
  if (!comment) return json({ error: 'comment not found' }, 404);

  let challengeId: Uint8Array;
  let signature: Uint8Array;
  let nonce: bigint;
  try {
    challengeId = base64UrlToBytes(challengeIdB64);
    signature = base64UrlToBytes(signatureB64);
    nonce = parseNonce(data.nonce);
  } catch {
    return json({ error: 'invalid challengeId, signature or nonce encoding' }, 400);
  }

  const ok = await verifyChallenge(
    { version: PROTOCOL_VERSION, hostContext, articlePath, challengeId, expiresAt: BigInt(expiresAt), difficulty },
    signature,
    env.POW_SECRET,
  );
  if (!ok) return json({ error: 'invalid challenge signature' }, 400);

  const nowSec = Math.floor(Date.now() / 1000);
  const gateRes = timeGateResponse(env, nowSec, expiresAt);
  if (gateRes) return gateRes;

  const powOk = await verifyPow(
    encodeCanonicalCommentActionPayload({
      version: PROTOCOL_VERSION,
      action: 'flag',
      hostContext,
      articlePath,
      commentId,
      challengeId,
      nonce,
    }),
    difficulty,
  );
  if (!powOk) return json({ error: 'proof of work not satisfied' }, 400);

  // Atomic anti-replay: consume the challenge + insert the flag in ONE batch.
  const consume = env.DB.prepare(
    'INSERT OR IGNORE INTO used_challenges (challenge_id, used_at) VALUES (?, ?)',
  ).bind(challengeIdB64, nowSec);
  const insertFlag = env.DB.prepare(
    `INSERT INTO comment_flags (id, comment_id, created_at, challenge_id)
     SELECT ?1, ?2, ?3, ?4
     WHERE changes() = 1`,
  ).bind(crypto.randomUUID(), commentId, nowSec, challengeIdB64);

  let results: D1Result[];
  try {
    results = await env.DB.batch([consume, insertFlag]);
  } catch {
    return json({ error: 'storage error' }, 500);
  }
  if (results[0].meta.changes === 0) {
    return json({ error: 'Challenge Already Used' }, 409);
  }
  if (results[1].meta.changes !== 1) {
    return json({ error: 'flag not stored' }, 500);
  }
  return json({ ok: true, flagged: true });
}

/**
 * POST /api/comments/vote
 *
 * Anonymous like/upvote for a comment. Same PoW + anti-replay pipeline as the
 * flag, bound to the canonical action 'vote'. The optional per-browser guard
 * (always on for votes) stores ONLY a hash of an anonymous token — a returning
 * browser can like each comment once; no personal data, no cookies.
 */
export async function handleVoteComment(request: Request, env: Env): Promise<Response> {
  const limited = await applyRateLimit(env.RATE_LIMITER, 'comments');
  if (limited) return limited;

  const maxBytes = envNumber(env.MAX_REQUEST_BYTES, DEFAULTS.MAX_REQUEST_BYTES);
  const read = await readJsonBody(request, maxBytes);
  if (!read.ok || typeof read.value !== 'object' || read.value === null) {
    return json({ error: read.ok ? 'body must be a JSON object' : 'invalid JSON body' }, read.ok ? 400 : read.status);
  }
  const data = read.value as Record<string, unknown>;
  const challengeIdB64 = requireString(data, 'challengeId');
  const hostContext = requireString(data, 'hostContext');
  const articlePath = requireString(data, 'articlePath');
  const commentId = requireString(data, 'commentId');
  const signatureB64 = requireString(data, 'signature');
  const voterToken = requireString(data, 'voterToken') ?? '';
  const difficulty = data.difficulty;
  const expiresAt = data.expiresAt;
  if (!challengeIdB64 || !hostContext || !articlePath || !commentId || !signatureB64) {
    return json({ error: 'missing required fields' }, 400);
  }
  if (typeof difficulty !== 'number' || !Number.isSafeInteger(difficulty) || difficulty < 0) {
    return json({ error: 'difficulty must be a non-negative integer' }, 400);
  }
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    return json({ error: 'expiresAt must be a non-negative integer' }, 400);
  }
  if (commentId.length > MAX_COMMENT_ID_BYTES) {
    return json({ error: 'commentId too long' }, 400);
  }
  if (!validField(articlePath, MAX_ARTICLE_PATH_BYTES) || !validField(hostContext, MAX_HOST_CONTEXT_BYTES)) {
    return json({ error: 'invalid hostContext or articlePath' }, 400);
  }

  const comment = await env.DB.prepare(
    'SELECT id FROM comments WHERE id = ? AND status = ? LIMIT 1',
  ).bind(commentId, 'approved').first<{ id: string }>();
  if (!comment) return json({ error: 'comment not found' }, 404);

  let challengeId: Uint8Array;
  let signature: Uint8Array;
  let nonce: bigint;
  try {
    challengeId = base64UrlToBytes(challengeIdB64);
    signature = base64UrlToBytes(signatureB64);
    nonce = parseNonce(data.nonce);
  } catch {
    return json({ error: 'invalid challengeId, signature or nonce encoding' }, 400);
  }

  const ok = await verifyChallenge(
    { version: PROTOCOL_VERSION, hostContext, articlePath, challengeId, expiresAt: BigInt(expiresAt), difficulty },
    signature,
    env.POW_SECRET,
  );
  if (!ok) return json({ error: 'invalid challenge signature' }, 400);

  const nowSec = Math.floor(Date.now() / 1000);
  const gateRes = timeGateResponse(env, nowSec, expiresAt);
  if (gateRes) return gateRes;

  const powOk = await verifyPow(
    encodeCanonicalCommentActionPayload({
      version: PROTOCOL_VERSION,
      action: 'vote',
      hostContext,
      articlePath,
      commentId,
      challengeId,
      nonce,
    }),
    difficulty,
  );
  if (!powOk) return json({ error: 'proof of work not satisfied' }, 400);

  // Per-browser guard: anonymous token, only its hash is stored.
  let voterHash: string | null = null;
  let issuedToken: string | null = null;
  const existing = await verifyVoterToken(voterToken, env);
  if (existing) {
    voterHash = bytesToBase64Url(await sha256(existing));
    const already = await env.DB.prepare(
      'SELECT 1 FROM comment_votes WHERE comment_id = ? AND voter_hash = ? LIMIT 1',
    ).bind(commentId, voterHash).first();
    if (already) return json({ error: 'already voted' }, 409);
  } else {
    const id = randomBytes(16);
    const sig = await signVoterToken(id, env);
    issuedToken = `${bytesToBase64Url(id)}.${bytesToBase64Url(sig)}`;
    voterHash = bytesToBase64Url(await sha256(id));
  }

  // Atomic anti-replay: consume the challenge + insert the vote in ONE batch.
  const consume = env.DB.prepare(
    'INSERT OR IGNORE INTO used_challenges (challenge_id, used_at) VALUES (?, ?)',
  ).bind(challengeIdB64, nowSec);
  const insertVote = env.DB.prepare(
    `INSERT INTO comment_votes (id, comment_id, created_at, challenge_id, voter_hash)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE changes() = 1`,
  ).bind(crypto.randomUUID(), commentId, nowSec, challengeIdB64, voterHash);

  let results: D1Result[];
  try {
    results = await env.DB.batch([consume, insertVote]);
  } catch {
    return json({ error: 'storage error' }, 500);
  }
  if (results[0].meta.changes === 0) {
    return json({ error: 'Challenge Already Used' }, 409);
  }
  if (results[1].meta.changes !== 1) {
    return json({ error: 'vote not stored' }, 500);
  }

  const countRow = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM comment_votes WHERE comment_id = ?',
  ).bind(commentId).first<{ c: number }>();
  return json({
    ok: true,
    votes: Number(countRow?.c ?? 0),
    voted: true,
    voterToken: issuedToken,
  });
}
