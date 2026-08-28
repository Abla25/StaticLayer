import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { spawnWorker } from './worker.ts';

/**
 * GitHub OAuth admin sign-in (v1.7.0).
 *
 * The Worker's outbound calls to GitHub are stubbed with a second "github-mock"
 * Worker exposed through the GITHUB_OAUTH_SERVICE service binding (see
 * worker.ts mockGithub option), so the FULL flow is exercised with no network:
 *   /api/admin/github/start  -> 302 + signed state cookie
 *   /api/admin/github/callback?code&state -> token exchange (mocked) ->
 *        user fetch (mocked) -> allowlist check -> admin session cookie.
 *
 * Redirects are NOT followed (a manual-mode Request is sent through the direct
 * HTTP proxy), so the 302 responses are observed directly.
 */

const BASE = 'http://localhost';
const GITHUB_ENV = {
  GITHUB_CLIENT_ID: 'client-abc123',
  GITHUB_CLIENT_SECRET: 'secret-xyz789',
  GITHUB_ADMIN_IDS: '108115781',
};

let mf: Miniflare | undefined;

afterEach(async () => {
  await mf?.dispose();
  mf = undefined;
});

/** Spawn a worker whose GitHub outbound calls hit the in-Miniflare mock. */
async function spawnWithMock(opts: {
  tokenJson?: unknown;
  userJson?: unknown;
  tokenStatus?: number;
  userStatus?: number;
  expectCode?: string;
  env?: Record<string, string>;
}) {
  mf = await spawnWorker(
    {
      mockGithub: {
        tokenJson: opts.tokenJson,
        userJson: opts.userJson,
        tokenStatus: opts.tokenStatus,
        userStatus: opts.userStatus,
        expectCode: opts.expectCode,
      },
    },
    { ...GITHUB_ENV, ...opts.env },
  );
  return mf;
}

/** Start the OAuth dance and return the redirect location + signed state cookie. */
async function startAndExtract(
  worker: Miniflare,
): Promise<{ origin: string; location: string; state: string; stateCookie: string }> {
  // Use the direct HTTP proxy (undici) with redirect:'manual' — workerd's
  // dispatchFetch always follows redirects, undici respects manual mode.
  const base = (await worker.ready).href.replace(/\/$/, '');
  const res = await fetch(`${base}/api/admin/github/start`, { redirect: 'manual' });
  if (res.status !== 302) {
    const text = await res.text();
    throw new Error(`expected 302, got ${res.status} with body: ${text.slice(0, 300)}`);
  }
  const location = res.headers.get('location') ?? '';
  const parsed = new URL(location);
  expect(parsed.origin).toBe('https://github.com');
  expect(parsed.pathname).toBe('/login/oauth/authorize');
  const state = parsed.searchParams.get('state') ?? '';
  expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
  const cookie = res.headers.get('set-cookie') ?? '';
  expect(cookie).toContain('__Host-SL-OAuth=');
  const stateCookie = cookie.split(';')[0]?.replace('__Host-SL-OAuth=', '') ?? '';
  expect(stateCookie).toContain(`${state}.`);
  return { origin: base, location, state, stateCookie };
}

describe('github oauth status', () => {
  it('reports not configured when env vars are missing', async () => {
    mf = await spawnWorker();
    const res = await mf.dispatchFetch(`${BASE}/api/admin/github`);
    const body = (await res.json()) as { configured: boolean };
    expect(res.status).toBe(200);
    expect(body.configured).toBe(false);
  });

  it('reports configured when client id/secret + allowlist are set', async () => {
    mf = await spawnWorker({}, GITHUB_ENV);
    const res = await mf.dispatchFetch(`${BASE}/api/admin/github`);
    const body = (await res.json()) as { configured: boolean };
    expect(body.configured).toBe(true);
  });
});

describe('github oauth start', () => {
  it('returns 501 when not configured', async () => {
    mf = await spawnWorker();
    const res = await mf.dispatchFetch(`${BASE}/api/admin/github/start`);
    expect(res.status).toBe(501);
  });

  it('redirects to github.com with a signed state cookie', async () => {
    mf = await spawnWorker({}, GITHUB_ENV);
    const { origin, location, stateCookie } = await startAndExtract(mf);
    expect(location).toContain('client_id=client-abc123');
    expect(location).toContain('redirect_uri=' + encodeURIComponent(`${origin}/api/admin/github/callback`));
    expect(location).toContain('scope=read%3Auser');
    expect(location).toContain('allow_signup=false');
    expect(stateCookie.split('.').length).toBe(2);
  });
});

describe('github oauth callback', () => {
  it('rejects missing code/state', async () => {
    mf = await spawnWorker({}, GITHUB_ENV);
    const res = await mf.dispatchFetch(`${BASE}/api/admin/github/callback`);
    expect(res.status).toBe(400);
  });

  it('rejects a missing or invalid state cookie', async () => {
    mf = await spawnWorker({}, GITHUB_ENV);
    const res = await mf.dispatchFetch(`${BASE}/api/admin/github/callback?code=x&state=y`);
    expect(res.status).toBe(401);
  });

  it('issues an admin session for an allowlisted user (full happy path)', async () => {
    const worker = await spawnWithMock({ expectCode: 'abc' });
    const { origin, state, stateCookie } = await startAndExtract(worker);

    const callback = await fetch(`${origin}/api/admin/github/callback?code=abc&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: `__Host-SL-OAuth=${stateCookie}` },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${origin}/admin.html?github=signed-in`);

    // The mock enforced that the token exchange carried our code — so the
    // client_id/client_secret/code were really sent to (mock) GitHub.
    // Two cookies are set: the OAuth state cookie cleared + the session.
    const setCookies = callback.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith('__Host-SL-OAuth=;'))).toBe(true);
    expect(setCookies.some((c) => c.startsWith('__Host-StaticLayerSession='))).toBe(true);

    // The issued session cookie must pass the real requireAdmin gate.
    const sessionCookie = setCookies.find((c) => c.startsWith('__Host-StaticLayerSession='));
    const sessionValue = sessionCookie?.split(';')[0]?.replace('__Host-StaticLayerSession=', '') ?? '';
    const restore = await fetch(`${origin}/api/admin/session`, {
      headers: { cookie: `__Host-StaticLayerSession=${sessionValue}` },
    });
    expect(restore.status).toBe(200);
    const body = (await restore.json()) as { authed: boolean; method?: string };
    expect(body.authed).toBe(true);
    expect(body.method).toBe('github');
  });

  it('redirects back with github=denied when the id is not in the allowlist', async () => {
    const worker = await spawnWithMock({ userJson: { id: 999999, login: 'someone-else' } });
    const { origin, state, stateCookie } = await startAndExtract(worker);

    const callback = await fetch(`${origin}/api/admin/github/callback?code=abc&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: `__Host-SL-OAuth=${stateCookie}` },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${origin}/admin.html?github=denied`);
    const setCookies = callback.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith('__Host-StaticLayerSession='))).toBe(false);
  });

  it('allows sign-in via GITHUB_ADMIN_LOGINS (case-insensitive)', async () => {
    const worker = await spawnWithMock({
      userJson: { id: 123, login: 'Abla25' },
      env: { GITHUB_ADMIN_IDS: '', GITHUB_ADMIN_LOGINS: 'abla25' },
    });
    const { origin, state, stateCookie } = await startAndExtract(worker);
    const callback = await fetch(`${origin}/api/admin/github/callback?code=abc&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: `__Host-SL-OAuth=${stateCookie}` },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${origin}/admin.html?github=signed-in`);
  });

  it('returns 401 when GitHub rejects the code', async () => {
    const worker = await spawnWithMock({
      tokenJson: { error: 'bad_verification_code', error_description: 'The code passed is incorrect' },
    });
    const { origin, state, stateCookie } = await startAndExtract(worker);
    const callback = await fetch(`${origin}/api/admin/github/callback?code=bad&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: `__Host-SL-OAuth=${stateCookie}` },
    });
    expect(callback.status).toBe(401);
  });
});
