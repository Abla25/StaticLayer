import type { D1Database } from '@cloudflare/workers-types';

/**
 * Allow/block moderation lists (nickname bans = 'block' entries).
 *
 *   - block  : the nickname cannot comment at all (rejected at submit time).
 *   - allow  : in 'open' mode the nickname is auto-approved; in 'allowlist'
 *              mode ONLY allowlisted nicknames can comment.
 *
 * Values are stored lowercased and matched case-insensitively. Anonymous
 * comments (empty nickname) are never affected by lists.
 */
export type ListKind = 'allow' | 'block';

export interface ModerationLists {
  allow: Set<string>;
  block: Set<string>;
}

export function normalizeListValue(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 100);
}

export async function readLists(db: D1Database): Promise<ModerationLists> {
  const { results } = await db
    .prepare('SELECT kind, value FROM moderation_lists')
    .all<{ kind: string; value: string }>();
  const lists: ModerationLists = { allow: new Set(), block: new Set() };
  for (const row of results) {
    if (row.kind === 'allow') lists.allow.add(row.value);
    else if (row.kind === 'block') lists.block.add(row.value);
  }
  return lists;
}

export type ListDecision =
  | { verdict: 'blocked' }
  | { verdict: 'allowlisted' }
  | { verdict: 'regular' };

/** Decide the moderation outcome for a nickname against the lists. */
export function decide(nickname: string, lists: ModerationLists): ListDecision {
  const key = normalizeListValue(nickname);
  if (!key) return { verdict: 'regular' };
  if (lists.block.has(key)) return { verdict: 'blocked' };
  if (lists.allow.has(key)) return { verdict: 'allowlisted' };
  return { verdict: 'regular' };
}
