import type { RateLimit } from '@cloudflare/workers-types';
import { json } from './http.ts';

/**
 * Edge-local rate limiting (see docs/cloudflare-assumptions.md §5).
 *
 * The Rate Limit binding is per-Cloudflare-location, eventually consistent and
 * permissive — it is a backstop, NOT a security boundary. The primary defenses
 * are PoW + anti-replay. Keys are route-scoped (never raw IPs, per Cloudflare
 * guidance).
 *
 * If the binding is absent (tests, local without the binding), we skip the
 * check and continue — rate limiting is a mitigation, not a gate.
 */
export async function applyRateLimit(
  limiter: RateLimit | undefined,
  key: string,
): Promise<Response | null> {
  if (!limiter) return null;
  const { success } = await limiter.limit({ key });
  return success ? null : json({ error: 'rate limit exceeded' }, 429);
}
