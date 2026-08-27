import type { D1Database } from '@cloudflare/workers-types';

/**
 * Retention is set to 24h. Although challenge TTL is 5m, a 24h window
 * provides a safety buffer for clock skew, legitimate client retries, and
 * basic auditability, while keeping the `used_challenges` table minimal. It
 * does not weaken the anti-replay guarantee.
 */
export const USED_CHALLENGES_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Retention of `used_challenges` (Phase 3).
 *
 * Challenges have a 5-minute TTL; any row older than 24h can never be reused
 * by a valid proof, so it is pure storage overhead. Deleting it is safe and
 * does NOT weaken the anti-replay invariant (SECURITY_REVIEW.md §12):
 *   - the consumed `challenge_id` is the replay gate; deleting a consumed
 *     challenge can only make a REPLAY *more* likely to be accepted, never a
 *     legitimate first use — but replays are additionally gated by PoW and
 *     the 5-minute challenge expiry, which is far shorter than 24h;
 *   - `challenge_id` is CSPRNG-32-byte; a re-issued challenge can never
 *     collide with an old one (birthday-bound negligible).
 * So 24h retention is a safe upper bound: old rows are gone before they could
 * ever matter, and the table stays bounded.
 */

/**
 * Delete consumed challenges older than 24h. Returns the number of rows
 * deleted. `used_at` is stored in unix SECONDS (see comments.ts).
 */
export async function purgeUsedChallenges(db: D1Database, nowMs: number): Promise<number> {
  const thresholdSec = Math.floor((nowMs - USED_CHALLENGES_RETENTION_MS) / 1000);
  const result = await db
    .prepare('DELETE FROM used_challenges WHERE used_at < ?')
    .bind(thresholdSec)
    .run();
  return result.meta.changes;
}
