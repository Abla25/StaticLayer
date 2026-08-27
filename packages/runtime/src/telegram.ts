import type { Env } from './env.ts';
import { readSettings, settingOn } from './settings.ts';

/**
 * Owner-only Telegram alerts — GDPR-minimal by design.
 *
 * When a new comment enters the moderation queue and Telegram alerts are
 * enabled, the worker sends ONE message to the owner's chat. The message
 * contains NO comment data whatsoever (no nickname, no text, no article):
 * only "a new comment awaits moderation" plus a link to the admin console.
 * No third party (Telegram) ever sees comment content.
 *
 * The bot token + chat id are stored in the owner's private D1 database
 * (settings table) and configured from the admin panel — no re-install.
 *
 * Best-effort: a notification failure NEVER fails the comment submit.
 */

export async function notifyPendingComment(env: Env, adminUrl: string): Promise<void> {
  try {
    const map = await readSettings(env.DB);
    if (!settingOn(map, 'telegram_alerts', false)) return;
    const token = map.get('telegram_bot_token');
    const chatId = map.get('telegram_chat_id');
    if (!token || !chatId) return;

    const text = [
      '📝 StaticLayer',
      'Un nuovo commento è in attesa di moderazione.',
      adminUrl,
    ].join('\n');

    // The bot token is safe in the path (Telegram format: <digits>:<alphanumerics>);
    // do NOT percent-encode it (encodeURIComponent would turn ':' into %3A).
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Never propagate: notifications are best-effort.
  }
}
