import { DEFAULTS, envNumber, type Env } from './env.ts';
import { json } from './http.ts';

/**
 * Privacy-zero anti-spam helpers (Round 21.18).
 *
 * Both layers are PURE behavioural checks: they never read, store or persist
 * any personal data, and they never touch the comment content — fully
 * GDPR-neutral, consistent with the whole system.
 *
 *   ① Honeypot — a hidden form field that bots fill and humans never see.
 *        Triggered => the submission is silently dropped (a plausible fake
 *        "pending" is returned so bots learn nothing). 0 data, 0 persistence.
 *   ② Time gate — submissions arriving sooner than CHALLENGE_TIME_GATE_SECONDS
 *        after the challenge was issued are rejected with 429. The issue time
 *        is recovered from the SIGNED challenge (expiresAt − TTL), so the
 *        server keeps ZERO state and stores nothing.
 */

/** True when the (hidden) honeypot field was filled → this is a bot. */
export function isHoneypotTriggered(data: Record<string, unknown>): boolean {
  const hp = data.honeypot;
  return typeof hp === 'string' && hp.trim().length > 0;
}

/**
 * Time gate: returns a 429 Response when `now` is less than the configured
 * gate after `expiresAt − TTL` (the signed issue time). Null = submission is
 * old enough. Gate 0 disables the check.
 */
export function timeGateResponse(env: Env, nowSec: number, expiresAt: number): Response | null {
  const gate = envNumber(env.CHALLENGE_TIME_GATE_SECONDS, DEFAULTS.CHALLENGE_TIME_GATE_SECONDS);
  if (gate <= 0) return null;
  const ttl = envNumber(env.CHALLENGE_TTL_SECONDS, DEFAULTS.CHALLENGE_TTL_SECONDS);
  const issuedAt = expiresAt - ttl;
  if (nowSec - issuedAt < gate) {
    return json({ error: 'submitted too quickly' }, 429);
  }
  return null;
}

/** A plausible fake success used to silently drop honeypot-triggered bots. */
export function fakePendingComment(): Response {
  return json({
    comment: {
      id: crypto.randomUUID(),
      article_path: '',
      nickname: '',
      body: '',
      status: 'pending',
      created_at: Math.floor(Date.now() / 1000),
    },
  });
}
