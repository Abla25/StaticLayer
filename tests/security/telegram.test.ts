import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Miniflare } from 'miniflare';
import { notifyActivity, notifyPendingComment, notifyPollVote, notifyReaction, testTelegramAlert } from '../../packages/runtime/src/telegram.ts';
import { SECRETS, spawnWorker } from './worker.ts';

const BASE = 'http://localhost';

/** Minimal D1 stand-in that answers readSettings() with a fixed map. */
function fakeDb(map: Map<string, string>) {
  return {
    prepare: () => ({
      bind: () => ({
        all: () =>
          Promise.resolve({
            results: Array.from(map, ([key, value]) => ({ key, value })),
          }),
      }),
    }),
  };
}

type TelegramEnv = Parameters<typeof notifyPendingComment>[0];

describe('Telegram alerts (GDPR-minimal)', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('does not call Telegram when alerts are off', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const env = { DB: fakeDb(new Map([['telegram_alerts', 'off']])) } as unknown as TelegramEnv;
    await notifyPendingComment(env, 'https://x.test/admin.html');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call Telegram when the token or chat id are missing', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const env = { DB: fakeDb(new Map([['telegram_alerts', 'on'], ['telegram_bot_token', 'tok']])) } as unknown as TelegramEnv;
    await notifyPendingComment(env, 'https://x.test/admin.html');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a GDPR-minimal message (no comment data) when enabled', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const env = {
      DB: fakeDb(
        new Map([
          ['telegram_alerts', 'on'],
          ['telegram_bot_token', '123:abc'],
          ['telegram_chat_id', '456'],
        ]),
      ),
    } as unknown as TelegramEnv;

    await notifyPendingComment(env, 'https://x.test/admin.html');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    const body = JSON.parse(String(init.body)) as { chat_id: string; text: string };
    expect(body.chat_id).toBe('456');
    expect(body.text).toContain('in attesa di moderazione');
    expect(body.text).toContain('https://x.test/admin.html');
    // Privacy invariant: no nickname, no body, no article path, no IP.
    expect(body.text).not.toContain('nickname');
    expect(body.text).not.toContain('commento di');
    expect(body.text).not.toContain('/blog/');
  });

  it('never throws when the Telegram API fails (best-effort)', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('network down'))) as unknown as typeof fetch;
    const env = {
      DB: fakeDb(new Map([['telegram_alerts', 'on'], ['telegram_bot_token', 'tok'], ['telegram_chat_id', '1']])),
    } as unknown as TelegramEnv;
    await expect(notifyPendingComment(env, 'https://x.test/admin.html')).resolves.toBeUndefined();
  });

  it('testTelegramAlert returns a clean ok on success', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const env = {
      DB: fakeDb(
        new Map([
          ['telegram_alerts', 'on'],
          ['telegram_bot_token', '123:abc'],
          ['telegram_chat_id', '456'],
        ]),
      ),
    } as unknown as TelegramEnv;

    const result = await testTelegramAlert(env, 'https://x.test/admin.html');
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('testTelegramAlert surfaces the Telegram error (not silent)', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const env = {
      DB: fakeDb(new Map([['telegram_bot_token', '123:abc'], ['telegram_chat_id', '456']])),
    } as unknown as TelegramEnv;

    const result = await testTelegramAlert(env, 'https://x.test/admin.html');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('403');
    expect(result.error).toContain('blocked');
  });

  it('testTelegramAlert reports when token or chat id are missing', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const env = { DB: fakeDb(new Map([['telegram_bot_token', 'tok']])) } as unknown as TelegramEnv;
    const result = await testTelegramAlert(env, 'https://x.test/admin.html');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Bot token and Chat ID/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ---- telegram_events selection ---------------------------------------

  function enabledDb(events?: string) {
    const map = new Map<string, string>([
      ['telegram_alerts', 'on'],
      ['telegram_bot_token', '123:abc'],
      ['telegram_chat_id', '456'],
    ]);
    if (events !== undefined) map.set('telegram_events', events);
    return { DB: fakeDb(map) } as unknown as TelegramEnv;
  }

  function sentText(fetchMock: ReturnType<typeof vi.fn>): string {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    return String((JSON.parse(String(init.body)) as { text: string }).text);
  }

  it('default (events unset): only comments trigger an alert', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const env = enabledDb();
    await notifyPollVote(env, 'https://x.test/admin.html', { articlePath: '/p' });
    await notifyReaction(env, 'https://x.test/admin.html', { articlePath: '/p' });
    expect(fetchMock).not.toHaveBeenCalled();
    await notifyPendingComment(env, 'https://x.test/admin.html', { articlePath: '/p' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentText(fetchMock)).toContain('in attesa di moderazione');
  });

  it('telegram_events=comment,poll fires for comments and polls but not reactions', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const env = enabledDb('comment,poll');
    await notifyPendingComment(env, 'https://x.test/admin.html');
    await notifyPollVote(env, 'https://x.test/admin.html');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await notifyReaction(env, 'https://x.test/admin.html');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('telegram_events=reaction fires only for reactions', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const env = enabledDb('reaction');
    await notifyPendingComment(env, 'https://x.test/admin.html');
    await notifyPollVote(env, 'https://x.test/admin.html');
    expect(fetchMock).not.toHaveBeenCalled();
    await notifyReaction(env, 'https://x.test/admin.html');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentText(fetchMock)).toContain('Nuova reazione');
  });

  it('telegram_events="" (explicitly none) never fires', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const env = enabledDb('');
    await notifyActivity(env, { event: 'comment', adminUrl: 'https://x.test/admin.html' });
    await notifyActivity(env, { event: 'poll', adminUrl: 'https://x.test/admin.html' });
    await notifyActivity(env, { event: 'reaction', adminUrl: 'https://x.test/admin.html' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('message names the page (host + path) but never the content', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const env = enabledDb('comment');

    await notifyPendingComment(env, 'https://x.test/admin.html', {
      hostContext: 'thewrongbus.example',
      articlePath: '/2024/09/hello-world',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const text = sentText(fetchMock);
    // The owner learns WHICH page got the activity…
    expect(text).toContain('📄 thewrongbus.example/2024/09/hello-world');
    expect(text).toContain('🔐 Console: https://x.test/admin.html');
    // …but never any user content.
    expect(text).not.toContain('hello world');
    expect(text).not.toContain('nickname');
    expect(text).not.toContain('ciao');
  });

  it('malicious newlines in host/path are stripped (single-line message)', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const env = enabledDb('comment');

    await notifyPendingComment(env, 'https://x.test/admin.html', {
      hostContext: 'site.example\ntexto_iniettato',
      articlePath: '/a\n/b',
    });

    const text = sentText(fetchMock);
    // No newline injection: the payload cannot forge its own lines in the alert.
    const lines = text.split('\n');
    expect(lines.length).toBe(4); // header, event, page, console
    expect(lines[0]).toBe('📝 StaticLayer');
    expect(lines[1]).toBe('Nuovo commento in attesa di moderazione');
    expect(lines[3]).toBe('🔐 Console: https://x.test/admin.html');
    // The injected payload never starts its own line.
    expect(lines.some((l) => l.startsWith('texto_iniettato'))).toBe(false);
  });
});

describe('admin session restore + telegram settings API', () => {
  let mf: Miniflare | undefined;
  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  async function login(): Promise<{ cookie: string; csrf: string }> {
    const res = await mf!.dispatchFetch(`${BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: SECRETS.ADMIN_SECRET }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const data = (await res.json()) as { csrf?: string };
    return { cookie, csrf: data.csrf as string };
  }

  it('GET /api/admin/session reports authed=false without a session and restores csrf after login', async () => {
    mf = await spawnWorker();

    const anon = await mf.dispatchFetch(`${BASE}/api/admin/session`);
    expect(anon.status).toBe(200);
    expect(await anon.json()).toEqual({ authed: false });

    const { cookie, csrf } = await login();
    const authed = await mf.dispatchFetch(`${BASE}/api/admin/session`, { headers: { cookie } });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ authed: true, csrf, method: 'password' });
  });

  it('persists telegram settings via the admin API (roundtrip)', async () => {
    mf = await spawnWorker();
    const { cookie, csrf } = await login();

    const put = await mf.dispatchFetch(`${BASE}/api/admin/settings`, {
      method: 'PUT',
      headers: { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({
        settings: { telegram_alerts: 'on', telegram_bot_token: '123:abc', telegram_chat_id: '456' },
      }),
    });
    expect(put.status).toBe(200);

    const got = await mf.dispatchFetch(`${BASE}/api/admin/settings`, { headers: { cookie } });
    const data = (await got.json()) as {
      settings: { telegram_alerts: string; telegram_bot_token: string; telegram_chat_id: string };
    };
    expect(data.settings.telegram_alerts).toBe('on');
    expect(data.settings.telegram_bot_token).toBe('123:abc');
    expect(data.settings.telegram_chat_id).toBe('456');
  });

  it('rejects an invalid telegram_alerts value', async () => {
    mf = await spawnWorker();
    const { cookie, csrf } = await login();
    const res = await mf.dispatchFetch(`${BASE}/api/admin/settings`, {
      method: 'PUT',
      headers: { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { telegram_alerts: 'sometimes' } }),
    });
    expect(res.status).toBe(400);
  });
});
