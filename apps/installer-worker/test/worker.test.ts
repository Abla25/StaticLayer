import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const ENTRY = join(PKG, 'src', 'worker.ts');

const ENV = {
  STATICLAYER_SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  STATICLAYER_CLIENT_ID: 'local-test-client',
  STATICLAYER_CLIENT_SECRET: 'local-test-secret',
  STATICLAYER_REDIRECT_URI: 'http://localhost:8789/oauth/callback',
  STATICLAYER_SITE_BASE: 'https://abla25.github.io/StaticLayer/',
  STATICLAYER_REPO_URL: 'https://github.com/Abla25/StaticLayer',
};

type Outbound = (request: Request) => Promise<Response> | Response;

function mockCloudflare(outbound: Outbound): Outbound {
  return (request) => {
    const url = new URL(request.url);
    if (url.hostname === 'api.cloudflare.com') return outbound(request);
    return fetch(request);
  };
}

const cloudflareOk = mockCloudflare(() =>
  new Response(JSON.stringify({ success: true, result: [{ id: 'acc-1', name: 'My Account' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }),
);
const cloudflareFail = mockCloudflare(() =>
  new Response(JSON.stringify({ success: false, errors: [{ code: 9109, message: 'invalid' }] }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  }),
);

async function bundleWorker(): Promise<string> {
  execFileSync('node', ['build.mjs'], { cwd: PKG, stdio: 'inherit' });
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const text = result.outputFiles?.[0]?.text;
  if (!text) throw new Error('esbuild produced no output for the installer worker');
  return text;
}

function makeMf(script: string, outbound: Outbound): Miniflare {
  return new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'installer',
          modules: true,
          script,
          compatibilityDate: '2026-08-26',
          bindings: ENV,
          kvNamespaces: { SESSIONS: 'ns-1' },
          outboundService: outbound,
        },
      ],
    }),
  );
}

let script = '';
let mf: Miniflare;

beforeAll(async () => {
  script = await bundleWorker();
  mf = makeMf(script, cloudflareOk);
});

afterAll(async () => {
  await mf?.dispose();
});

describe('hosted installer worker — static + meta', () => {
  it('serves the wizard with site links injected', async () => {
    const res = await mf.dispatchFetch('http://installer.local/');
    expect(res.status).toBe(200);
    const htmlText = await res.text();
    expect(htmlText).toContain('StaticLayer — Web Installer');
    expect(htmlText).toContain('https://abla25.github.io/StaticLayer/');
    expect(htmlText).toContain('id="continue-local"');
  });

  it('serves app.js and nav.js', async () => {
    expect((await mf.dispatchFetch('http://installer.local/app.js')).status).toBe(200);
    expect((await mf.dispatchFetch('http://installer.local/nav.js')).status).toBe(200);
  });

  it('reports hosted mode + OAuth placeholder via /api/meta', async () => {
    const res = await mf.dispatchFetch('http://installer.local/api/meta');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dev: false, oauthConfigured: false });
  });
});

describe('hosted installer worker — sessions + token connect', () => {
  it('starts an anonymous session via /api/start (no email)', async () => {
    const res = await mf.dispatchFetch('http://installer.local/api/start', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^SLSession=.*HttpOnly/);
    expect(cookie).toContain('SameSite=Lax');

    const me = await mf.dispatchFetch('http://installer.local/api/me', {
      headers: { cookie: cookie.split(';')[0]! },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'guest', connected: false });
  });

  it('rejects /api/token/connect without a session', async () => {
    const res = await mf.dispatchFetch('http://installer.local/api/token/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiToken: 'tok-x' }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts a valid pasted API token and lists accounts', async () => {
    const start = await mf.dispatchFetch('http://installer.local/api/start', { redirect: 'manual' });
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0]!;

    const res = await mf.dispatchFetch('http://installer.local/api/token/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ apiToken: 'valid-token-123' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accounts: [{ id: 'acc-1', name: 'My Account' }] });

    const me = await mf.dispatchFetch('http://installer.local/api/me', { headers: { cookie } });
    const meBody = (await me.json()) as { connected: boolean; accounts: unknown[] };
    expect(meBody.connected).toBe(true);
    expect(meBody.accounts).toEqual([{ id: 'acc-1', name: 'My Account' }]);
  });

  it('rejects an invalid API token with 401', async () => {
    const bad = makeMf(script, cloudflareFail);
    try {
      const start = await bad.dispatchFetch('http://installer.local/api/start', { redirect: 'manual' });
      const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0]!;
      const res = await bad.dispatchFetch('http://installer.local/api/token/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ apiToken: 'bad-token' }),
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toMatch(/Invalid API token/);
    } finally {
      await bad.dispose();
    }
  });

  it('rejects an oversized token body', async () => {
    const start = await mf.dispatchFetch('http://installer.local/api/start', { redirect: 'manual' });
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0]!;
    const res = await mf.dispatchFetch('http://installer.local/api/token/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ apiToken: 'x'.repeat(600) }),
    });
    expect(res.status).toBe(400);
  });
});
