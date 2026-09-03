import {
  base64UrlToBytes,
  bytesToBase64Url,
  encodeCanonicalPayload,
  MAX_ARTICLE_PATH_BYTES,
  MAX_HOST_CONTEXT_BYTES,
  parseNonce,
  PROTOCOL_VERSION,
  ProtocolError,
  randomBytes,
  signChallenge,
  utf8EncodeStrict,
  verifyChallenge,
  verifyPow,
  type ChallengeFields,
} from '@staticlayer/protocol';
import type { D1Result } from '@cloudflare/workers-types';
import { DEFAULTS, envNumber, type Env } from './env.ts';
import { json, readJsonBody, validField } from './http.ts';
import { applyRateLimit } from './ratelimit.ts';
import { timeGateResponse } from './antiabuse.ts';
import { readSettings } from './settings.ts';
import { notifyReaction } from './telegram.ts';

/**
 * Reactions — anonymous, PoW-protected (mode "a": cost-based integrity).
 *
 * Public API:
 *   GET  /api/reactions?article_path=...        aggregate counts (cacheable)
 *   GET  /api/reactions/challenge?articlePath.. signed PoW challenge
 *   POST /api/reactions                         verify PoW + store one reaction
 *
 * Integrity model (honest, no identity):
 *   - every reaction costs a real Proof-of-Work (single-use challenge,
 *     atomic anti-replay — identical plumbing to comments);
 *   - difficulty ESCALATES per article as votes grow
 *     (base → ceiling, +1 every REACTION_ESCALATION_VOTES);
 *   - per-article + global rate limiting (route keys, never IP);
 *   - minimum interval between accepted reactions on the same article.
 *
 * Privacy invariants (unchanged):
 *   - a reaction row is an anonymous event (article_path, reaction, timestamp);
 *   - no IP, no user id, no cookie, no fingerprint, no persistent identifier;
 *   - repeated votes by the same person are NOT detectable by design: the
 *     guarantee is cost, not identity.
 */

/** Max byte length of a reaction string (an emoji is <= 4 bytes; this is generous). */
export const MAX_REACTION_BYTES = 16;

/** Stable FNV-1a (32-bit) hex — short rate-limit keys derived from article paths. */
export function stableKey(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Allowed reactions from REACTION_OPTIONS (comma-separated). Empty => disabled. */
export function reactionOptions(env: Env): string[] {
  const raw = env.REACTION_OPTIONS ?? DEFAULTS.REACTION_OPTIONS;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Reactions as configured live via the admin settings panel (falls back to env). */
async function reactionOptionsEffective(env: Env): Promise<string[]> {
  const settings = await readSettings(env.DB);
  const raw = settings.get('reaction_options');
  if (raw !== undefined) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return reactionOptions(env);
}

/**
 * Escalating difficulty for an article with `votes` reactions:
 *   base + min(floor(votes / step), ceiling - base)
 * Defaults: base 16, step 20, ceiling 20 → 16 → 17 → 18 → 19 → 20.
 */
export function reactionDifficulty(env: Env, votes: number): number {
  const base = envNumber(env.REACTION_DIFFICULTY_BASE, DEFAULTS.REACTION_DIFFICULTY_BASE);
  const ceiling = envNumber(env.REACTION_DIFFICULTY_CEILING, DEFAULTS.REACTION_DIFFICULTY_CEILING);
  const step = envNumber(env.REACTION_ESCALATION_VOTES, DEFAULTS.REACTION_ESCALATION_VOTES);
  const effectiveBase = Math.max(0, Math.min(base, ceiling));
  const capped = Math.max(effectiveBase, Math.min(ceiling, effectiveBase + (step > 0 ? Math.floor(votes / step) : 0)));
  return capped;
}

async function countVotes(env: Env, articlePath: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM reactions WHERE article_path = ?')
    .bind(articlePath)
    .first<{ n: number }>();
  return row ? Number(row.n) : 0;
}

/* ------------------------------- GET ---------------------------------- */

/**
 * GET /api/reactions?article_path=... — public aggregate counts.
 * Cacheable 60s, never sets a cookie.
 */
export async function handleListReactions(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const articlePath = url.searchParams.get('article_path') ?? '';
  if (articlePath.length === 0) {
    return json({ error: 'article_path is required' }, 400);
  }
  if (!validField(articlePath, MAX_ARTICLE_PATH_BYTES)) {
    return json({ error: `article_path must be valid UTF-8 within ${MAX_ARTICLE_PATH_BYTES} bytes` }, 400);
  }

  const { results } = await env.DB.prepare(
    `SELECT reaction, COUNT(*) AS count
     FROM reactions
     WHERE article_path = ?
     GROUP BY reaction
     ORDER BY count DESC`,
  )
    .bind(articlePath)
    .all<{ reaction: string; count: number }>();

  return json({ reactions: results }, 200, { 'cache-control': 'public, max-age=60' });
}

/* --------------------------- GET challenge ---------------------------- */

/**
 * GET /api/reactions/challenge?hostContext=..&articlePath=..
 *
 * Like the comments challenge, but difficulty is computed with the per-article
 * escalation curve. The signed challenge commits the client to that difficulty
 * for the whole TTL (defense in depth: the difficulty cannot be tampered with).
 */
export async function handleReactionChallenge(request: Request, env: Env): Promise<Response> {
  const options = await reactionOptionsEffective(env);
  if (options.length === 0) {
    return json({ error: 'reactions are disabled on this deployment' }, 400);
  }
  const limited = await applyRateLimit(env.RATE_LIMITER, 'reaction-challenge');
  if (limited) return limited;

  const url = new URL(request.url);
  const hostContext = url.searchParams.get('hostContext') ?? '';
  const articlePath = url.searchParams.get('articlePath') ?? '';
  if (articlePath.length === 0) {
    return json({ error: 'articlePath is required' }, 400);
  }
  if (!validField(articlePath, MAX_ARTICLE_PATH_BYTES)) {
    return json({ error: `articlePath must be valid UTF-8 within ${MAX_ARTICLE_PATH_BYTES} bytes` }, 400);
  }
  if (hostContext.length > 0 && !validField(hostContext, MAX_HOST_CONTEXT_BYTES)) {
    return json({ error: `hostContext must be valid UTF-8 within ${MAX_HOST_CONTEXT_BYTES} bytes` }, 400);
  }

  const votes = await countVotes(env, articlePath);
  const difficulty = reactionDifficulty(env, votes);
  const ttl = envNumber(env.CHALLENGE_TTL_SECONDS, DEFAULTS.CHALLENGE_TTL_SECONDS);

  const challengeId = randomBytes(32);
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = BigInt(nowSec + ttl);

  let signature: Uint8Array;
  try {
    signature = await signChallenge(
      { version: PROTOCOL_VERSION, hostContext, articlePath, challengeId, expiresAt, difficulty },
      env.POW_SECRET,
    );
  } catch (err) {
    if (err instanceof ProtocolError) return json({ error: err.message }, 400);
    throw err;
  }

  return json({
    challengeId: bytesToBase64Url(challengeId),
    hostContext,
    articlePath,
    difficulty,
    expiresAt: Number(expiresAt),
    signature: bytesToBase64Url(signature),
  });
}

/* ------------------------------- POST --------------------------------- */

interface ReactionFields {
  challengeIdB64: string;
  hostContext: string;
  articlePath: string;
  reaction: string;
  difficulty: number;
  expiresAt: number;
  signatureB64: string;
  nonce: bigint;
}

function requireString(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' ? value : null;
}

function isAllowedReaction(reaction: string, options: string[]): boolean {
  let len = 0;
  try {
    len = utf8EncodeStrict(reaction).length;
  } catch {
    return false;
  }
  if (len === 0 || len > MAX_REACTION_BYTES) return false;
  return options.includes(reaction);
}

/**
 * POST /api/reactions — full verification pipeline (fail closed), identical
 * in spirit to POST /api/comments:
 *   1. rate limit (per-article hashed key + global);
 *   2. body byte cap + strict field types;
 *   3. reaction allowed + within byte limits;
 *   4. challenge signature (constant-time), expiry;
 *   5. proof-of-work over the canonical payload at the SIGNED difficulty;
 *   6. min-interval backstop per article;
 *   7. ATOMIC anti-replay (consume challenge + insert reaction in one batch).
 */
export async function handlePostReaction(request: Request, env: Env): Promise<Response> {
  const options = await reactionOptionsEffective(env);
  if (options.length === 0) {
    return json({ error: 'reactions are disabled on this deployment' }, 400);
  }

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

  const challengeIdB64 = requireString(record, 'challengeId');
  const hostContext = requireString(record, 'hostContext');
  const articlePath = requireString(record, 'articlePath');
  const reaction = requireString(record, 'reaction');
  const signatureB64 = requireString(record, 'signature');
  const difficulty = record.difficulty;
  const expiresAt = record.expiresAt;
  if (!challengeIdB64 || !hostContext || !articlePath || !reaction || !signatureB64) {
    return json({ error: 'missing required fields' }, 400);
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

  // ---- UTF-8 + byte limits (before any crypto) ----
  if (!validField(hostContext, MAX_HOST_CONTEXT_BYTES)) {
    return json({ error: `hostContext must be valid UTF-8 within ${MAX_HOST_CONTEXT_BYTES} bytes` }, 400);
  }
  if (!validField(articlePath, MAX_ARTICLE_PATH_BYTES)) {
    return json({ error: `articlePath must be valid UTF-8 within ${MAX_ARTICLE_PATH_BYTES} bytes` }, 400);
  }
  if (!isAllowedReaction(reaction, options)) {
    return json({ error: 'reaction is not allowed' }, 400);
  }

  // ---- challenge signature (constant-time) + expiry ----
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
  const nowSec = Math.floor(Date.now() / 1000);
  if (expiresAt <= nowSec) {
    return json({ error: 'challenge expired' }, 410);
  }
  // Time gate (anti-bot, zero data): reject submissions faster than the gate.
  const gateRes = timeGateResponse(env, nowSec, expiresAt);
  if (gateRes) return gateRes;

  // ---- proof of work over the canonical payload (at the SIGNED difficulty) ----
  let canonical: Uint8Array;
  try {
    canonical = encodeCanonicalPayload({
      version: PROTOCOL_VERSION,
      hostContext,
      articlePath,
      nickname: '', // reactions carry no nickname
      body: '', // and no comment body
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

  // ---- per-article rate limit (hashed key, never IP) ----
  const limitedArticle = await applyRateLimit(
    env.RATE_LIMITER,
    `reaction:${stableKey(articlePath)}`,
  );
  if (limitedArticle) return limitedArticle;

  // ---- already-used challenge short-circuit (replays → 409, not 429) ----
  // Lets a network retry of an already-accepted vote report "already used"
  // instead of hitting the per-article interval. The batch below remains the
  // authoritative anti-replay boundary (TOCTOU-safe).
  const used = await env.DB.prepare(
    'SELECT 1 AS u FROM used_challenges WHERE challenge_id = ?',
  )
    .bind(challengeIdB64)
    .first();
  if (used) {
    return json({ error: 'Challenge Already Used' }, 409);
  }

  // ---- minimum interval between accepted reactions on the same article ----
  const interval = envNumber(
    env.REACTION_MIN_INTERVAL_SECONDS,
    DEFAULTS.REACTION_MIN_INTERVAL_SECONDS,
  );
  if (interval > 0) {
    const last = await env.DB.prepare(
      'SELECT created_at FROM reactions WHERE article_path = ? ORDER BY created_at DESC LIMIT 1',
    )
      .bind(articlePath)
      .first<{ created_at: number }>();
    if (last && nowSec - Number(last.created_at) < interval) {
      return json({ error: 'too many reactions — slow down' }, 429);
    }
  }

  // ---- ATOMIC anti-replay ----
  const id = crypto.randomUUID();
  const consume = env.DB.prepare(
    'INSERT OR IGNORE INTO used_challenges (challenge_id, used_at) VALUES (?, ?)',
  ).bind(challengeIdB64, nowSec);
  const insertReaction = env.DB.prepare(
    `INSERT INTO reactions (id, article_path, reaction, created_at)
     SELECT ?1, ?2, ?3, ?4
     WHERE changes() = 1`,
  ).bind(id, articlePath, reaction, nowSec);

  let results: D1Result[];
  try {
    results = await env.DB.batch([consume, insertReaction]);
  } catch {
    return json({ error: 'storage error' }, 500);
  }

  const consumed = results[0].meta.changes;
  if (consumed === 0) {
    return json({ error: 'Challenge Already Used' }, 409);
  }
  const inserted = results[1].meta.changes;
  if (inserted !== 1) {
    return json({ error: 'storage error' }, 500);
  }

  // Return fresh aggregate counts for the article.
  const { results: counts } = await env.DB.prepare(
    `SELECT reaction, COUNT(*) AS count
     FROM reactions WHERE article_path = ?
     GROUP BY reaction ORDER BY count DESC`,
  )
    .bind(articlePath)
    .all<{ reaction: string; count: number }>();

  // Owner notification on an accepted reaction (best-effort). GDPR-minimal:
  // the alert never contains the reaction itself — only the page + admin link.
  const origin = new URL(request.url).origin;
  await notifyReaction(env, `${origin}/admin.html`, { hostContext, articlePath });

  return json({ ok: true, reaction, reactions: counts });
}
