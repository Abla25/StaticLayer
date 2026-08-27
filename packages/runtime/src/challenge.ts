import {
  bytesToBase64Url,
  PROTOCOL_VERSION,
  ProtocolError,
  randomBytes,
  signChallenge,
} from '@staticlayer/protocol';
import { DEFAULTS, envNumber, type Env } from './env.ts';
import { json } from './http.ts';
import { applyRateLimit } from './ratelimit.ts';

/**
 * GET /api/comments/challenge?hostContext=...&articlePath=...
 *
 * Issues a STATELESS, signed PoW challenge:
 *   - 32 CSPRNG bytes for the challenge id;
 *   - expiresAt = now + TTL (default 300s);
 *   - difficulty = configured value (default 16);
 *   - the challenge fields are signed with POW_SECRET (HMAC-SHA256) so the
 *     client cannot alter host context, article path, difficulty or expiry.
 *
 * `challengeId` and `signature` are serialized as base64url WITHOUT padding.
 */
export async function handleChallenge(request: Request, env: Env): Promise<Response> {
  const limited = await applyRateLimit(env.RATE_LIMITER, 'challenge');
  if (limited) return limited;

  const url = new URL(request.url);
  const hostContext = url.searchParams.get('hostContext') ?? '';
  const articlePath = url.searchParams.get('articlePath') ?? '';
  if (articlePath.length === 0) {
    return json({ error: 'articlePath is required' }, 400);
  }

  const difficulty = envNumber(env.POW_DIFFICULTY, DEFAULTS.POW_DIFFICULTY);
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
    if (err instanceof ProtocolError) {
      // e.g. hostContext/articlePath over their byte limits.
      return json({ error: err.message }, 400);
    }
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
