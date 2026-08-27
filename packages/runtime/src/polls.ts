import {
  base64UrlToBytes,
  bytesToBase64Url,
  encodeCanonicalPollPayload,
  MAX_OPTION_BYTES,
  MAX_POLL_ID_BYTES,
  parseNonce,
  PROTOCOL_VERSION,
  ProtocolError,
  randomBytes,
  sha256,
  signChallenge,
  utf8EncodeStrict,
  verifyChallenge,
  verifyHmacSha256,
  verifyPow,
  hmacSha256,
} from '@staticlayer/protocol';
import type { D1Result } from '@cloudflare/workers-types';
import { DEFAULTS, envNumber, type Env } from './env.ts';
import { json, readJsonBody } from './http.ts';
import { applyRateLimit } from './ratelimit.ts';
import { readSettings, settingNumber } from './settings.ts';

/**
 * Polls (StrawPoll-style, privacy-first — Round 21.15).
 *
 *   GET  /api/polls?article_path=...      public, cacheable (with optional
 *                                          voterToken to report "you voted")
 *   GET  /api/polls/challenge?hostContext=..&articlePath=..&pollId=..
 *                                          signed PoW challenge (same as comments)
 *   POST /api/polls/vote                   PoW + atomic anti-replay + optional
 *                                          anonymous single-vote guard
 *
 * Privacy invariants (same as everything else):
 *   - a vote stores ONLY { poll_id, option, timestamp, challenge_id };
 *   - the optional "one vote per browser" guard stores ONLY an anonymous hash
 *     of a server-signed random token — never the token, never personal data;
 *   - no cookies are set; the voter token lives only in the visitor's browser
 *     localStorage when the owner enables single_vote for a poll.
 */

interface PollRow {
  id: string;
  article_path: string;
  question: string;
  options: string; // JSON array of strings
  multi: number;
  single_vote: number;
  status: string;
  created_at: number;
}

interface PollCounts {
  [option: string]: number;
}

/** Parse options JSON defensively (fail closed on malformed rows). */
function parseOptions(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.every((o) => typeof o === 'string' && o.length)) {
      return arr.map((o) => String(o));
    }
  } catch {
    /* fallthrough */
  }
  return [];
}

async function loadPoll(env: Env, pollId: string): Promise<PollRow | null> {
  return (await env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(pollId).first()) as PollRow | null;
}

async function loadCounts(env: Env, pollId: string): Promise<PollCounts> {
  const { results } = await env.DB.prepare(
    'SELECT option, COUNT(*) AS c FROM poll_votes WHERE poll_id = ? GROUP BY option',
  )
    .bind(pollId)
    .all<{ option: string; c: number }>();
  const counts: PollCounts = {};
  for (const r of results) counts[r.option] = Number(r.c);
  return counts;
}

function serializePoll(row: PollRow, counts: PollCounts): Record<string, unknown> {
  const total = Object.values(counts).reduce((n, c) => n + c, 0);
  return {
    id: row.id,
    article_path: row.article_path,
    question: row.question,
    options: parseOptions(row.options),
    multi: row.multi === 1,
    singleVote: row.single_vote === 1,
    status: row.status,
    created_at: row.created_at,
    counts,
    total,
  };
}

/** GET /api/polls?article_path=... — public read (cacheable without token). */
export async function handleListPolls(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const articlePath = url.searchParams.get('article_path') ?? '';
  if (!articlePath) return json({ error: 'article_path is required' }, 400);

  const rows = (await env.DB.prepare(
    'SELECT * FROM polls WHERE article_path = ? ORDER BY created_at DESC LIMIT 50',
  )
    .bind(articlePath)
    .all<PollRow>()).results;

  // Optional anonymous voter token: reports "you already voted" on single-vote
  // polls without revealing anything (only an HMAC-verified id is used).
  let voterHash: string | null = null;
  const voterToken = url.searchParams.get('voterToken') ?? '';
  if (voterToken) {
    const id = await verifyVoterToken(voterToken, env);
    if (id) voterHash = bytesToBase64Url(await sha256(id));
  }

  const polls: Record<string, unknown>[] = [];
  for (const row of rows) {
    const counts = await loadCounts(env, row.id);
    const poll = serializePoll(row, counts);
    if (voterHash && row.single_vote === 1) {
      const already = await env.DB.prepare(
        'SELECT 1 FROM poll_votes WHERE poll_id = ? AND voter_hash = ? LIMIT 1',
      )
        .bind(row.id, voterHash)
        .first();
      poll.voted = already !== null;
    } else {
      poll.voted = false;
    }
    polls.push(poll);
  }

  const headers: Record<string, string> = voterHash || voterToken ? {} : { 'cache-control': 'public, max-age=30' };
  return json({ polls }, 200, headers);
}

/** GET /api/polls/challenge?hostContext=..&articlePath=.. — signed PoW challenge. */
export async function handlePollChallenge(request: Request, env: Env): Promise<Response> {
  const limited = await applyRateLimit(env.RATE_LIMITER, 'challenge');
  if (limited) return limited;

  const url = new URL(request.url);
  const hostContext = url.searchParams.get('hostContext') ?? '';
  const articlePath = url.searchParams.get('articlePath') ?? '';
  if (!articlePath) return json({ error: 'articlePath is required' }, 400);

  const settings = await readSettings(env.DB);
  const difficulty = settingNumber(settings, 'pow_difficulty', envNumber(env.POW_DIFFICULTY, DEFAULTS.POW_DIFFICULTY));
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

/**
 * POST /api/polls/vote
 * Body: { challengeId, hostContext, articlePath, pollId, option, difficulty,
 *         expiresAt, signature, nonce, voterToken? }
 */
export async function handlePollVote(request: Request, env: Env): Promise<Response> {
  const limited = await applyRateLimit(env.RATE_LIMITER, 'comments');
  if (limited) return limited;

  const maxBytes = envNumber(env.MAX_REQUEST_BYTES, DEFAULTS.MAX_REQUEST_BYTES);
  const read = await readJsonBody(request, maxBytes);
  if (!read.ok || typeof read.value !== 'object' || read.value === null) {
    return json({ error: read.ok ? 'body must be a JSON object' : 'invalid JSON body' }, read.ok ? 400 : read.status);
  }
  const data = read.value as Record<string, unknown>;

  const str = (k: string): string | null => (typeof data[k] === 'string' ? (data[k] as string) : null);
  const challengeIdB64 = str('challengeId');
  const hostContext = str('hostContext');
  const articlePath = str('articlePath');
  const pollId = str('pollId');
  const option = str('option');
  const signatureB64 = str('signature');
  const voterToken = str('voterToken') ?? '';
  const difficulty = data.difficulty;
  const expiresAt = data.expiresAt;
  if (!challengeIdB64 || !hostContext || !articlePath || !pollId || !option || !signatureB64) {
    return json({ error: 'missing required fields' }, 400);
  }
  if (typeof difficulty !== 'number' || !Number.isSafeInteger(difficulty) || difficulty < 0) {
    return json({ error: 'difficulty must be a non-negative integer' }, 400);
  }
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    return json({ error: 'expiresAt must be a non-negative integer' }, 400);
  }
  if (pollId.length > MAX_POLL_ID_BYTES || option.length > MAX_OPTION_BYTES) {
    return json({ error: 'pollId or option too long' }, 400);
  }

  const poll = await loadPoll(env, pollId);
  if (!poll) return json({ error: 'poll not found' }, 404);
  if (poll.status !== 'open') return json({ error: 'poll is closed' }, 403);
  if (poll.article_path !== articlePath) return json({ error: 'poll does not belong to this article' }, 400);
  const options = parseOptions(poll.options);
  if (!options.includes(option)) return json({ error: 'invalid option' }, 400);

  // Decode challenge + nonce (fail closed on bad encodings).
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

  // Verify the challenge signature (host/article/difficulty/expiry are fixed).
  const ok = await verifyChallenge(
    { version: PROTOCOL_VERSION, hostContext, articlePath, challengeId, expiresAt: BigInt(expiresAt), difficulty },
    signature,
    env.POW_SECRET,
  );
  if (!ok) return json({ error: 'invalid challenge signature' }, 400);

  // Verify the proof of work over the canonical POLL payload.
  const powOk = await verifyPow(
    encodeCanonicalPollPayload({
      version: PROTOCOL_VERSION,
      hostContext,
      articlePath,
      pollId,
      option,
      challengeId,
      nonce,
    }),
    difficulty,
  );
  if (!powOk) return json({ error: 'proof of work not satisfied' }, 400);

  // Optional anonymous single-vote guard.
  let voterHash: string | null = null;
  let issuedToken: string | null = null;
  if (poll.single_vote === 1) {
    const existing = await verifyVoterToken(voterToken, env);
    if (existing) {
      voterHash = bytesToBase64Url(await sha256(existing));
      const already = await env.DB.prepare(
        'SELECT 1 FROM poll_votes WHERE poll_id = ? AND voter_hash = ? LIMIT 1',
      )
        .bind(poll.id, voterHash)
        .first();
      if (already) return json({ error: 'already voted' }, 409);
    } else {
      // First vote: issue a fresh anonymous voter token and return it to the
      // browser so future votes from the same browser are rejected.
      const id = randomBytes(16);
      const sig = await signVoterToken(id, env);
      issuedToken = `${bytesToBase64Url(id)}.${bytesToBase64Url(sig)}`;
      voterHash = bytesToBase64Url(await sha256(id));
    }
  }

  // Atomic anti-replay: consume the challenge and store the vote in ONE batch.
  const voteId = crypto.randomUUID();
  const nowSec = Math.floor(Date.now() / 1000);
  const consume = env.DB.prepare(
    'INSERT OR IGNORE INTO used_challenges (challenge_id, used_at) VALUES (?, ?)',
  ).bind(challengeIdB64, nowSec);
  const insertVote = env.DB.prepare(
    `INSERT INTO poll_votes (id, poll_id, option, created_at, challenge_id, voter_hash)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
     WHERE changes() = 1`,
  ).bind(voteId, poll.id, option, nowSec, challengeIdB64, voterHash);

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

  const counts = await loadCounts(env, poll.id);
  return json({
    ok: true,
    poll: serializePoll(poll, counts),
    voted: true,
    voterToken: issuedToken,
  });
}

/* ------------------------- voter token helpers ------------------------- */
// The anonymous voter token is `base64url(randomId).base64url(HMAC(id))`.
// The server verifies the HMAC and stores ONLY sha256(id) — never the token.

async function verifyVoterToken(token: string, env: Env): Promise<Uint8Array | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const id = base64UrlToBytes(parts[0]);
    const sig = base64UrlToBytes(parts[1]);
    const key = utf8EncodeStrict(env.POW_SECRET);
    if (!(await verifyHmacSha256(key, id, sig))) return null;
    return id;
  } catch {
    return null;
  }
}

async function signVoterToken(id: Uint8Array, env: Env): Promise<Uint8Array> {
  return hmacSha256(utf8EncodeStrict(env.POW_SECRET), id);
}
