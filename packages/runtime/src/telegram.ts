import type { Env } from './env.ts';
import { readSettings, settingOn, telegramEventsEnabled, type TelegramEventType } from './settings.ts';

/**
 * Owner-only Telegram alerts — GDPR-minimal by design.
 *
 * When enabled, the worker sends ONE message per accepted activity event:
 *   - a comment entering the moderation queue ('comment');
 *   - a new poll vote ('poll');
 *   - a new reaction ('reaction').
 *
 * The owner chooses which events trigger an alert via the `telegram_events`
 * setting (comment,poll,reaction — default 'comment').
 *
 * PRIVACY INVARIANT: a message NEVER contains user content. No comment text,
 * no nickname, no poll option, no reaction label, no personal data — only
 * "what happened" (which page, i.e. the site's own article path) plus the
 * admin-console link. Comment text in particular is never sent to Telegram.
 *
 * Best-effort: a notification failure NEVER fails or blocks the submit.
 */

export interface NotifyActivityOptions {
  event: TelegramEventType;
  /** Full URL of the admin console, e.g. https://host/admin.html */
  adminUrl: string;
  /** Site hostname where the activity happened (the owner's own site). */
  hostContext?: string;
  /** Page path on that site (the owner's own article). */
  articlePath?: string;
}

const EVENT_EMOJI: Record<TelegramEventType, string> = {
  comment: '📝',
  poll: '🗳️',
  reaction: '❤️',
};

const EVENT_LINE: Record<TelegramEventType, string> = {
  comment: 'Nuovo commento in attesa di moderazione',
  poll: 'Nuovo voto in un sondaggio',
  reaction: 'Nuova reazione',
};

/** Strip control characters/newlines and cap the length (single-line safety). */
function singleLine(value: string | undefined, max: number): string {
  if (!value) return '';
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code < 32 || code === 127) continue; // no newlines/control chars
    out += ch;
    if (out.length >= max) break;
  }
  return out.trim();
}

/**
 * Build the page label shown in the alert: `host + path` (plain text). This is
 * the OWNER's own site/pages — no user content. Never a clickable URL.
 */
function pageLabel(hostContext: string | undefined, articlePath: string | undefined): string {
  const host = singleLine(hostContext, 120).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const path = singleLine(articlePath, 300);
  if (!host && !path) return '';
  const joined = host ? (path ? `${host}${path.startsWith('/') ? path : `/${path}`}` : host) : path;
  return joined.slice(0, 400);
}

async function sendTelegramMessage(
  env: Env,
  token: string,
  chatId: string,
  text: string,
  timeoutMs: number,
): Promise<Response> {
  // The bot token is safe in the path (Telegram format: <digits>:<alphanumerics>);
  // do NOT percent-encode it (encodeURIComponent would turn ':' into %3A).
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Core notifier: fires only when alerts are 'on' AND the event is enabled. */
export async function notifyActivity(env: Env, opts: NotifyActivityOptions): Promise<void> {
  try {
    const map = await readSettings(env.DB);
    if (!settingOn(map, 'telegram_alerts', false)) return;
    if (!telegramEventsEnabled(map, opts.event)) return;
    const token = map.get('telegram_bot_token');
    const chatId = map.get('telegram_chat_id');
    if (!token || !chatId) return;

    const lines = [`${EVENT_EMOJI[opts.event]} StaticLayer`, EVENT_LINE[opts.event]];
    const page = pageLabel(opts.hostContext, opts.articlePath);
    if (page) lines.push(`📄 ${page}`);
    lines.push(`🔐 Console: ${opts.adminUrl}`);

    await sendTelegramMessage(env, token, chatId, lines.join('\n'), 5000);
  } catch {
    // Never propagate: notifications are best-effort.
  }
}

/** New comment entered the moderation queue (event: 'comment'). */
export function notifyPendingComment(
  env: Env,
  adminUrl: string,
  ctx?: { hostContext?: string; articlePath?: string },
): Promise<void> {
  return notifyActivity(env, { event: 'comment', adminUrl, ...ctx });
}

/** A new poll vote was accepted (event: 'poll'). */
export function notifyPollVote(
  env: Env,
  adminUrl: string,
  ctx?: { hostContext?: string; articlePath?: string },
): Promise<void> {
  return notifyActivity(env, { event: 'poll', adminUrl, ...ctx });
}

/** A new reaction was accepted (event: 'reaction'). */
export function notifyReaction(
  env: Env,
  adminUrl: string,
  ctx?: { hostContext?: string; articlePath?: string },
): Promise<void> {
  return notifyActivity(env, { event: 'reaction', adminUrl, ...ctx });
}

/**
 * Send a live test message using the CURRENT saved settings and return the
 * outcome (ok / the exact error) instead of swallowing it. Used by the admin
 * "Send test" button so the owner can verify the token + chat id instantly.
 */
export async function testTelegramAlert(env: Env, adminUrl: string): Promise<{ ok: boolean; error?: string }> {
  const map = await readSettings(env.DB);
  const token = map.get('telegram_bot_token');
  const chatId = map.get('telegram_chat_id');
  if (!token || !chatId) {
    return { ok: false, error: 'Bot token and Chat ID must both be set before testing.' };
  }
  const text = ['📝 StaticLayer', '✅ Test riuscito! Le notifiche Telegram funzionano.', `🔐 Console: ${adminUrl}`].join('\n');
  try {
    const res = await sendTelegramMessage(env, token, chatId, text, 8000);
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      return { ok: false, error: `Telegram responded ${res.status}: ${raw.slice(0, 300)}` };
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!body?.ok) {
      return { ok: false, error: body?.description ?? 'Telegram returned an unexpected response.' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
