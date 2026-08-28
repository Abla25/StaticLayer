import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Miniflare } from 'miniflare';
import { notifyPendingComment } from '../../packages/runtime/src/telegram.ts';
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
