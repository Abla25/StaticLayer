import type { D1Database } from '@cloudflare/workers-types';

/**
 * Admin-editable settings, stored in the D1 `settings` table and merged with
 * env-var defaults at runtime. The admin panel can change these live without
 * redeploying or editing env vars.
 *
 *   pow_difficulty    number  (clamped to [MIN_DIFFICULTY, MAX_DIFFICULTY])
 *   reaction_options  string  (comma-separated; empty = reactions disabled)
 *   moderation_mode   'open' | 'allowlist'
 *
 *   - 'open' (default): comments go to the moderation queue; allowlisted
 *     nicknames are auto-approved.
 *   - 'allowlist': ONLY allowlisted nicknames can comment at all (others get
 *     a 403 before the comment is stored). Hard privacy/community mode.
 *
 * Telegram alerts (owner-only, GDPR-minimal):
 *   telegram_alerts    'on' | 'off'  (default off)
 *   telegram_bot_token string         (created with @BotFather, private)
 *   telegram_chat_id   string         (your chat id, e.g. 123456789)
 * The alert contains NO comment data — only "a new comment awaits
 * moderation" plus a link to the admin console.
 */
export const SETTING_KEYS = [
  'pow_difficulty',
  'reaction_options',
  'moderation_mode',
  'telegram_alerts',
  'telegram_bot_token',
  'telegram_chat_id',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export const MODERATION_MODES = ['open', 'allowlist'] as const;
export type ModerationMode = (typeof MODERATION_MODES)[number];

export const TELEGRAM_ALERT_STATES = ['on', 'off'] as const;
export type TelegramAlertState = (typeof TELEGRAM_ALERT_STATES)[number];

/** Read all known settings into a Map (one query). Missing keys are absent. */
export async function readSettings(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(`SELECT key, value FROM settings WHERE key IN (${SETTING_KEYS.map(() => '?').join(', ')})`)
    .bind(...SETTING_KEYS)
    .all<{ key: string; value: string }>();
  return new Map(results.map((r) => [r.key, r.value]));
}

export function settingNumber(map: Map<string, string>, key: string, fallback: number): number {
  const raw = map.get(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function settingString(map: Map<string, string>, key: string, fallback: string): string {
  const raw = map.get(key);
  if (raw === undefined) return fallback;
  const s = raw.trim();
  return s.length > 0 ? s : fallback;
}

export function settingModerationMode(map: Map<string, string>, fallback: ModerationMode): ModerationMode {
  const raw = map.get('moderation_mode');
  if (raw === 'allowlist') return 'allowlist';
  if (raw === 'open') return 'open';
  return fallback;
}

/** on/off toggle setting (anything other than 'on' reads as the fallback). */
export function settingOn(map: Map<string, string>, key: string, fallback: boolean): boolean {
  const raw = map.get(key);
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return fallback;
}

/** Upsert a setting row (admin panel). */
export async function putSetting(db: D1Database, key: string, value: string): Promise<void> {
  const updatedAt = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, updatedAt)
    .run();
}
