import {
  base64UrlToBytes,
  bytesToBase64Url,
  hmacSha256,
  randomBytes,
  utf8EncodeStrict,
  verifyHmacSha256,
} from '@staticlayer/protocol';
import { DEFAULTS, envNumber, type Env } from './env.ts';
import { json } from './http.ts';
import { applyRateLimit } from './ratelimit.ts';
import { signSession } from './session.ts';

/**
 * "Sign in with GitHub" for the admin console.
 *
 * Password-less admin sign-in WITHOUT Cloudflare Access (which needs a Zero
 * Trust plan + credit card) and without ever storing a password on later
 * visits. The operator creates a free GitHub OAuth App, we keep the
 * client_id + client_secret as Worker vars/secrets plus an admin allowlist
 * (numeric GitHub user ids and/or logins), and the login flow is a standard
 * OAuth "Authorization Code" exchange.
 *
 * Privacy: the GitHub access token is used ONCE to read the operator's id /
 * login, then discarded — never stored, never logged, never sent anywhere.
 * GitHub sees only the OWNER performing a login (an identity provider the
 * operator chose); visitor data (comments, reactions, polls, IPs) is never
 * involved in any request to GitHub. The resulting session cookie is the
 * SAME stateless { sub, iat, exp, csrf } used by password login.
 *
 * Env (all optional — without them the console falls back to the password):
 *   GITHUB_CLIENT_ID       OAuth App Client ID.
 *   GITHUB_CLIENT_SECRET   OAuth App Client Secret (store as a secret).
 *   GITHUB_ADMIN_IDS       comma-separated GitHub user IDs allowed to sign in.
 *   GITHUB_ADMIN_LOGINS    comma-separated GitHub logins (case-insensitive).
 *
 * Flow:
 *   GET /api/admin/github/start    -> 302 to github.com (state in a signed
 *                                      HttpOnly cookie, 10 min TTL).
 *   GET /api/admin/github/callback -> verify state, exchange code, check the
 *                                      allowlist, issue the admin session.
 *   GET /api/admin/github          -> { configured } for the login screen.
 */

const OAUTH_COOKIE = '__Host-SL-OAuth';
const OAUTH_TTL_SECONDS = 600;

/** GitHub endpoints (overridable for tests, defaults to production). */
function githubTokenUrl(env: Env): string {
  return env.GITHUB_TOKEN_URL?.trim() || 'https://github.com/login/oauth/access_token';
}
function githubUserUrl(env: Env): string {
  return env.GITHUB_USER_URL?.trim() || 'https://api.github.com/user';
}

/**
 * Fetch GitHub (or a test stub via GITHUB_OAUTH_SERVICE when present).
 * The service binding lets integration tests stub GitHub without any network.
 */
async function githubFetch(env: Env, url: string, init?: RequestInit): Promise<Response> {
  if (env.GITHUB_OAUTH_SERVICE) return env.GITHUB_OAUTH_SERVICE.fetch(url, init);
  return fetch(url, init);
}

/** Whether a full GitHub sign-in configuration is present. */
export function githubConfigured(env: Env): boolean {
  const id = env.GITHUB_CLIENT_ID?.trim();
  const secret = env.GITHUB_CLIENT_SECRET?.trim();
  const ids = env.GITHUB_ADMIN_IDS?.trim();
  const logins = env.GITHUB_ADMIN_LOGINS?.trim();
  return !!id && !!secret && (!!ids || !!logins);
}

/** Pure allowlist check against the configured admin ids/logins. */
export function isGithubAdmin(env: Env, id: number, login: string): boolean {
  const ids = (env.GITHUB_ADMIN_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.includes(String(id))) return true;
  const logins = (env.GITHUB_ADMIN_LOGINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return logins.includes(login.toLowerCase());
}

/** Build the github.com authorize URL (pure, unit-testable). */
export function githubAuthorizeUrl(env: Env, origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID!.trim(),
    redirect_uri: `${origin}/api/admin/github/callback`,
    scope: 'read:user',
    state,
    allow_signup: 'false',
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/** `<state>.<base64url(HMAC-SESSION_SECRET(state))>` — tamper-proof state. */
async function signOAuthState(state: string, env: Env): Promise<string> {
  const sig = await hmacSha256(utf8EncodeStrict(env.SESSION_SECRET), utf8EncodeStrict(state));
  return `${state}.${bytesToBase64Url(sig)}`;
}

async function verifyOAuthState(token: string, state: string, env: Env): Promise<boolean> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const statePart = token.slice(0, dot);
  let sig: Uint8Array;
  try {
    sig = base64UrlToBytes(token.slice(dot + 1));
  } catch {
    return false;
  }
  const ok = await verifyHmacSha256(utf8EncodeStrict(env.SESSION_SECRET), utf8EncodeStrict(statePart), sig);
  if (!ok) return false;
  return statePart === state;
}

function getOAuthCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === OAUTH_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** GET /api/admin/github — is "Sign in with GitHub" configured? */
export function handleGithubStatus(_request: Request, env: Env): Response {
  return json({
    configured: githubConfigured(env),
    allowlistIds: !!env.GITHUB_ADMIN_IDS?.trim(),
    allowlistLogins: !!env.GITHUB_ADMIN_LOGINS?.trim(),
  });
}

/** GET /api/admin/github/start — begin the OAuth dance (302 to GitHub). */
export async function handleGithubStart(request: Request, env: Env): Promise<Response> {
  const limited = await applyRateLimit(env.RATE_LIMITER, 'login');
  if (limited) return limited;

  if (!githubConfigured(env)) {
    return json({ error: 'github sign-in is not configured' }, 501);
  }

  const origin = new URL(request.url).origin;
  const state = bytesToBase64Url(randomBytes(16));
  const signed = await signOAuthState(state, env);
  const url = githubAuthorizeUrl(env, origin, state);
  const cookie = `${OAUTH_COOKIE}=${signed}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${OAUTH_TTL_SECONDS}`;

  return new Response(null, {
    status: 302,
    headers: { location: url, 'set-cookie': cookie, 'cache-control': 'no-store' },
  });
}

/** GET /api/admin/github/callback — exchange code, check allowlist, sign in. */
export async function handleGithubCallback(request: Request, env: Env): Promise<Response> {
  const limited = await applyRateLimit(env.RATE_LIMITER, 'login');
  if (limited) return limited;

  if (!githubConfigured(env)) {
    return json({ error: 'github sign-in is not configured' }, 501);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  if (!code || !state) return json({ error: 'missing code or state' }, 400);

  const cookie = getOAuthCookie(request);
  const clearCookie = `${OAUTH_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  if (!cookie) return json({ error: 'missing oauth state cookie' }, 401);
  const stateOk = await verifyOAuthState(cookie, state, env);
  if (!stateOk) return json({ error: 'invalid oauth state' }, 401);

  const origin = url.origin;
  const redirectUri = `${origin}/api/admin/github/callback`;

  // 1) Exchange the authorization code for an access token (GitHub).
  let exchange: Response;
  try {
    exchange = await githubFetch(env, githubTokenUrl(env), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'staticlayer-admin',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID!.trim(),
        client_secret: env.GITHUB_CLIENT_SECRET!.trim(),
        code,
        redirect_uri: redirectUri,
      }),
    });
  } catch (err) {
    return json({ error: `github token exchange failed: ${(err as Error).message}` }, 502);
  }
  if (!exchange.ok) return json({ error: 'github token exchange failed' }, 502);

  const tok = (await exchange.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tok.access_token) {
    return json({ error: `github rejected the code: ${tok.error_description ?? tok.error ?? 'unknown'}` }, 401);
  }

  // 2) Fetch the operator's identity — token used once, then discarded.
  let userRes: Response;
  try {
    userRes = await githubFetch(env, githubUserUrl(env), {
      headers: {
        authorization: `Bearer ${tok.access_token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'staticlayer-admin',
      },
    });
  } catch (err) {
    return json({ error: `github user fetch failed: ${(err as Error).message}` }, 502);
  }
  if (!userRes.ok) return json({ error: 'github user fetch failed' }, 502);

  const user = (await userRes.json()) as { id?: number; login?: string };
  const id = typeof user.id === 'number' ? user.id : Number.NaN;
  const login = typeof user.login === 'string' ? user.login : '';
  if (!isGithubAdmin(env, id, login)) {
    // Deny, redirect back so the human gets a readable screen.
    return new Response(null, {
      status: 302,
      headers: { location: `${origin}/admin.html?github=denied`, 'set-cookie': clearCookie, 'cache-control': 'no-store' },
    });
  }

  // 3) Issue the SAME stateless admin session as password login.
  const ttl = envNumber(env.SESSION_TTL_SECONDS, DEFAULTS.SESSION_TTL_SECONDS);
  const nowSec = Math.floor(Date.now() / 1000);
  const csrf = bytesToBase64Url(randomBytes(32));
  const session = await signSession(
    { sub: 'admin', iat: nowSec, exp: nowSec + ttl, csrf, method: 'github' },
    env.SESSION_SECRET,
  );
  const sessionCookie = `__Host-StaticLayerSession=${session}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttl}`;

  const headers = new Headers();
  headers.set('location', `${origin}/admin.html?github=signed-in`);
  headers.set('cache-control', 'no-store');
  headers.append('set-cookie', clearCookie);
  headers.append('set-cookie', sessionCookie);
  return new Response(null, { status: 302, headers });
}
