import type { D1Database } from '@cloudflare/workers-types';

/**
 * Blocked terms (word/term blacklist): comments whose body contains any
 * blocked term (case-insensitive substring) are rejected at submit time and
 * never stored — effectively auto-removed before they reach the queue.
 */
export async function readBlockedTerms(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT term FROM blocked_terms').all<{ term: string }>();
  return results.map((r) => r.term);
}

/** Returns the first blocked term found in `text` (lowercased match), or null. */
export function findBlockedTerm(text: string, terms: string[]): string | null {
  if (terms.length === 0) return null;
  const lower = text.toLowerCase();
  for (const term of terms) {
    if (term.length > 0 && lower.includes(term)) return term;
  }
  return null;
}

export function normalizeTerm(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 100);
}
