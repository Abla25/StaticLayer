import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Env must be set BEFORE the server module is loaded (it binds on import).
// Use a dynamic import: static imports are hoisted above the env assignments.
process.env.PORT = '0';
process.env.STATICLAYER_DEV_MODE = '1';
process.env.STATICLAYER_SESSION_SECRET = 'installer-flow-test-secret-0123456789';
process.env.STATICLAYER_CLIENT_ID = 'local-test-client';
process.env.STATICLAYER_CLIENT_SECRET = 'local-test-secret';
process.env.STATICLAYER_REDIRECT_URI = 'http://localhost:8788/oauth/callback';

const { server } = await import('../src/index.ts');

const realFetch: typeof fetch = globalThis.fetch;

async function waitForPort(): Promise<number> {
  const addr = server.address();
  if (addr && typeof addr === 'object' && addr.port > 0) return addr.port;
  await new Promise((r) => setTimeout(r, 50));
  return waitForPort();
}

/** Mock only Cloudflare API calls; pass everything else to the real fetch. */
function mockCloudflare(status: number, body: unknown): void {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (String(url).includes('api.cloudflare.com')) {
      return Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

async function localSessionCookie(): Promise<string> {
  const res = await realFetch(`${base}/api/auth/local`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

let base = '';
let serverPort = 0;

describe('installer web flow', () => {
  beforeAll(async () => {
    serverPort = await waitForPort();
    base = `http://localhost:${serverPort}`;
  });

  afterAll(() => {
    restoreFetch();
    server.close();
  });

  it('exposes dev-mode and OAuth-config status via /api/meta', async () => {
    const res = await realFetch(`${base}/api/meta`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dev: true, oauthConfigured: false });
  });

  it('creates a local session WITHOUT email in dev mode (no magic link, no SMTP)', async () => {
    const res = await realFetch(`${base}/api/auth/local`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^SLSession=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    // The session is usable: /api/me now reports a signed-in, not-connected state.
    const me = await realFetch(`${base}/api/me`, { headers: { cookie: cookie.split(';')[0]! } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'local@dev', connected: false });
  });

  it('rejects /api/token/connect without a session', async () => {
    const res = await realFetch(`${base}/api/token/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiToken: 'tok-x' }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts a valid API token, stores it in-memory and lists accounts', async () => {
    mockCloudflare(200, {
      success: true,
      result: [{ id: 'acc-1', name: 'My Account' }],
    });
    const cookie = await localSessionCookie();

    const res = await realFetch(`${base}/api/token/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ apiToken: 'valid-token-123' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accounts: [{ id: 'acc-1', name: 'My Account' }] });

    // /api/me now exposes the connected account through the same session.
    const me = await realFetch(`${base}/api/me`, { headers: { cookie } });
    const body = (await me.json()) as { connected: boolean; accounts: unknown[] };
    expect(body.connected).toBe(true);
    expect(body.accounts).toEqual([{ id: 'acc-1', name: 'My Account' }]);
  });

  it('rejects an invalid API token with 401', async () => {
    mockCloudflare(400, { success: false, errors: [{ code: 9109, message: 'invalid' }] });
    const cookie = await localSessionCookie();

    const res = await realFetch(`${base}/api/token/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ apiToken: 'bad-token' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid API token/);
  });

  it('rejects an oversized token body (cap enforced)', async () => {
    const cookie = await localSessionCookie();
    const res = await realFetch(`${base}/api/token/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ apiToken: 'x'.repeat(600) }),
    });
    expect(res.status).toBe(400);
  });

  it('serves the mobile-nav script and the wizard assets', async () => {
    const nav = await realFetch(`${base}/nav.js`);
    expect(nav.status).toBe(200);
    expect(nav.headers.get('content-type')).toContain('application/javascript');
    const app = await realFetch(`${base}/app.js`);
    expect(app.status).toBe(200);
    const index = await realFetch(`${base}/`);
    const html = await index.text();
    expect(html).toContain('id="continue-local"');
    expect(html).toContain('id="api-token"');
  });
});
