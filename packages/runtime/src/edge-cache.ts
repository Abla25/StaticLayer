/**
 * Edge cache for the PUBLIC anonymous comments list (Issue: edge caching).
 *
 * Why this module exists:
 *   - `Cache-Control: public, max-age=60` on a Worker response does NOT
 *     populate the Cloudflare edge cache by itself — it only helps
 *     browsers/proxies. To take read load off D1 at the edge we store the
 *     anonymous list in the Cache API (`caches.default`) with a short
 *     `s-maxage` TTL, and explicitly DELETE the key when an admin action
 *     changes the visible list (admin-comments.ts).
 *
 * Cache key = article_path ALONE (not the full URL): the list body does not
 *   vary by host_context (validated but not stored/returned), so keying on
 *   article_path maximises hit rate AND makes purge trivial — no origin/host
 *   enumeration needed. The `.invalid` origin is synthetic and never fetched;
 *   it is only a stable cache key namespace.
 *
 * Personalization rule: requests carrying a `voterToken` return per-browser
 * `voted` flags and are NEVER cached (the caller sets `no-store`). Vote
 * counts inside a cached list may lag up to the TTL after a vote — accepted
 * for an anonymous "like" counter.
 *
 * All operations are best-effort and fail-open: a Cache API error must never
 * break a read or an admin mutation.
 */

/** Synthetic, non-resolvable origin used purely as the cache-key namespace. */
const KEY_ORIGIN = 'https://comments-list.invalid';

/** Canonical cache key for an article's public comment list. */
export function commentsListCacheKey(articlePath: string): string {
  return `${KEY_ORIGIN}/api/comments?article_path=${encodeURIComponent(articlePath)}`;
}

/**
 * True when this GET may be cached at the edge: edge caching enabled
 * (ttlSeconds > 0) AND no per-browser voterToken in the query string.
 */
export function isCacheableListRequest(url: URL, ttlSeconds: number): boolean {
  if (ttlSeconds <= 0) return false;
  const voterToken = url.searchParams.get('voterToken');
  return voterToken === null || voterToken.length === 0;
}

/** Look up the cached anonymous list for an article (null on miss/error). */
export async function getCachedCommentsList(articlePath: string): Promise<Response | null> {
  try {
    return (await caches.default.match(commentsListCacheKey(articlePath))) ?? null;
  } catch {
    return null;
  }
}

/** Store the anonymous list response under the article's cache key. */
export async function putCachedCommentsList(articlePath: string, response: Response): Promise<void> {
  try {
    // The stored response keeps its Cache-Control (public, s-maxage=<ttl>),
    // which is what the Cache API honours for freshness.
    await caches.default.put(commentsListCacheKey(articlePath), response.clone());
  } catch {
    // Fail-open: caching is an optimisation.
  }
}

/** Drop the cached anonymous list for an article (call after list-changing mutations). */
export async function purgeCommentsList(articlePath: string): Promise<void> {
  try {
    await caches.default.delete(commentsListCacheKey(articlePath));
  } catch {
    // Best-effort: staleness is bounded by the short TTL anyway.
  }
}
