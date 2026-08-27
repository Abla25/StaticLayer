/**
 * StaticLayer hosted Web Installer — Cloudflare Worker.
 *
 * Zero-terminal installs: a public URL serves the same guided wizard as the
 * node installer. The OAuth consent screen (or a pasted API token) is the
 * identity gate — no email required. Sessions live in a KV namespace (TTL).
 * The runtime worker code is PRE-BUNDLED at build time — no esbuild at runtime.
 *
 * Security invariants (same as the node installer):
 *  - client secret stays server-side; tokens live only in KV sessions (TTL),
 *    never in a cookie, never logged;
 *  - a deploy generates the 3 secrets in-memory and pushes them straight to
 *    Cloudflare via the Bulk Secrets API — never returned to the browser,
 *    except the operator's ADMIN_SECRET, returned exactly once after a real
 *    deploy so they can sign in to /admin.html;
 *  - OAuth tokens are revoked after a successful apply; API-token sessions are
 *    simply deleted.
 */
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchAccounts,
  revokeToken,
  type CloudflareAccount,
} from '../../installer/src/oauth.ts';
import {
  newSessionId,
  SESSION_COOKIE,
  sessionCookieHeader,
  verifySessionValue,
} from './auth.ts';
import { runInstallerDeployWorker } from './deploy-worker.ts';
import { INDEX_HTML, APP_JS, NAV_JS } from './static-assets.ts';
import type { ExportedHandler } from '@cloudflare/workers-types';

const SESSION_TTL_MS = 30 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface Session {
  accessToken: string;
  tokenKind: 'oauth' | 'token' | '';
  email: string;
  expiresAt: number;
}

interface Env {
  SESSIONS: KVNamespace;
  STATICLAYER_SESSION_SECRET: string;
  STATICLAYER_CLIENT_ID: string;
  STATICLAYER_CLIENT_SECRET: string;
  STATICLAYER_REDIRECT_URI: string;
  STATICLAYER_SITE_BASE: string;
  STATICLAYER_REPO_URL: string;
}

type StringEnv = Omit<Env, 'SESSIONS'>;

function requireEnv(env: Env, name: keyof StringEnv): string {
  const value = env[name] as string;
  if (!value) throw new Error(`Missing required env var: ${String(name)}`);
  return value;
}

/* ------------------------------------------------------------------ */
/* KV session store                                                    */
/* ------------------------------------------------------------------ */

async function getSessionRecord(kv: KVNamespace, id: string): Promise<Session | null> {
  const raw = await kv.get(`s:${id}`);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    if (!s || s.expiresAt <= Date.now()) {
      await kv.delete(`s:${id}`);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

async function putSessionRecord(kv: KVNamespace, id: string, s: Session): Promise<void> {
  const ttl = Math.max(60, Math.ceil((s.expiresAt - Date.now()) / 1000));
  await kv.put(`s:${id}`, JSON.stringify(s), { expirationTtl: ttl });
}

async function getSession(request: Request, env: Env): Promise<{ id: string; session: Session } | null> {
  const cookie = (request.headers.get('cookie') ?? '').split(';').map((c) => c.trim());
  const raw = cookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  const token = raw.slice(SESSION_COOKIE.length + 1);
  const sessionId = await verifySessionValue(token, requireEnv(env, 'STATICLAYER_SESSION_SECRET'));
  if (!sessionId) return null;
  const session = await getSessionRecord(env.SESSIONS, sessionId);
  if (!session) return null;
  return { id: sessionId, session };
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve the deployed worker's public endpoint:
 * `https://{workerName}.{account workers.dev subdomain}.workers.dev`.
 * Falls back to `fallback` (with a warning) when the account subdomain cannot
 * be read (e.g. token without the right scope).
 */
async function resolveWorkerEndpoint(
  accessToken: string,
  accountId: string,
  workerName: string,
  fallback: string,
): Promise<{ endpoint: string; warning: string | null }> {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    const body = (await res.json()) as { success?: boolean; result?: { subdomain?: string } };
    if (res.ok && body.success === true && typeof body.result?.subdomain === 'string' && body.result.subdomain) {
      return { endpoint: `https://${workerName}.${body.result.subdomain}.workers.dev`, warning: null };
    }
  } catch {
    /* fall through */
  }
  return {
    endpoint: fallback,
    warning: 'could not detect your workers.dev address automatically — open your Worker in the Cloudflare dashboard to find its URL',
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...extraHeaders } });
}

async function readJson(request: Request, capBytes: number): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > capBytes) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* static assets (site links injected from env) */
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const body = INDEX_HTML.replaceAll('https://staticlayer.github.io/staticlayer/', env.STATICLAYER_SITE_BASE)
        .replaceAll('https://github.com/staticlayer/staticlayer', env.STATICLAYER_REPO_URL);
      return new Response(body, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (url.pathname === '/app.js') {
      return new Response(APP_JS, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/nav.js') {
      return new Response(NAV_JS, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' } });
    }

    /* meta */
    if (url.pathname === '/api/meta' && request.method === 'GET') {
      return json({ dev: false, oauthConfigured: !env.STATICLAYER_CLIENT_ID.startsWith('local-') });
    }

    /* start: anonymous session (no email — the OAuth consent is the identity gate) */
    if ((url.pathname === '/api/start' || url.pathname === '/api/auth/local') && request.method === 'GET') {
      const secret = requireEnv(env, 'STATICLAYER_SESSION_SECRET');
      const sessionId = newSessionId();
      await putSessionRecord(env.SESSIONS, sessionId, {
        accessToken: '',
        tokenKind: '',
        email: 'guest',
        expiresAt: Date.now() + SESSION_TTL_MS,
      });
      return redirect('/', { 'set-cookie': await sessionCookieHeader(sessionId, secret) });
    }

    /* OAuth */
    if (url.pathname === '/api/oauth/start' && request.method === 'GET') {
      const got = await getSession(request, env);
      if (!got) return json({ error: 'unauthorized — start the installer first' }, 401);
      const state = newSessionId();
      await env.SESSIONS.put(`o:${state}`, String(Date.now() + OAUTH_STATE_TTL_MS), {
        expirationTtl: Math.ceil(OAUTH_STATE_TTL_MS / 1000),
      });
      const authorizeUrl = buildAuthorizeUrl({
        clientId: requireEnv(env, 'STATICLAYER_CLIENT_ID'),
        redirectUri: requireEnv(env, 'STATICLAYER_REDIRECT_URI'),
        state,
      });
      return redirect(authorizeUrl);
    }
    if (url.pathname === '/oauth/callback' && request.method === 'GET') {
      const state = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code') ?? '';
      const error = url.searchParams.get('error');
      const stateExpRaw = await env.SESSIONS.get(`o:${state}`);
      await env.SESSIONS.delete(`o:${state}`);
      if (error) return html(400, `<h1>Autorizzazione rifiutata</h1><p>${error}</p>`);
      const stateExp = stateExpRaw ? Number(stateExpRaw) : 0;
      if (!stateExp || stateExp <= Date.now() || !code) {
        return html(400, '<h1>Stato OAuth non valido o scaduto</h1><p>Riprova.</p>');
      }
      let exchanged: { accessToken: string; expiresIn?: number };
      try {
        exchanged = await exchangeCodeForToken({
          clientId: requireEnv(env, 'STATICLAYER_CLIENT_ID'),
          clientSecret: requireEnv(env, 'STATICLAYER_CLIENT_SECRET'),
          redirectUri: requireEnv(env, 'STATICLAYER_REDIRECT_URI'),
          code,
        });
      } catch (err) {
        return html(502, `<h1>Token exchange fallito</h1><p>${(err as Error).message}</p>`);
      }
      const got = await getSession(request, env);
      if (!got) return html(401, '<h1>Sessione scaduta</h1><p>Riavvia il flusso.</p>');
      got.session.accessToken = exchanged.accessToken;
      got.session.tokenKind = 'oauth';
      got.session.expiresAt = Math.min(Date.now() + SESSION_TTL_MS, Date.now() + (exchanged.expiresIn ?? SESSION_TTL_MS) * 1000);
      await putSessionRecord(env.SESSIONS, got.id, got.session);
      return redirect('/');
    }

    /* me */
    if (url.pathname === '/api/me' && request.method === 'GET') {
      const got = await getSession(request, env);
      if (!got) return json({ error: 'unauthorized' }, 401);
      if (!got.session.accessToken) return json({ email: got.session.email, connected: false, accounts: [] });
      try {
        const accounts: CloudflareAccount[] = await fetchAccounts(got.session.accessToken);
        return json({ email: got.session.email, connected: true, accounts });
      } catch (err) {
        return json({ error: (err as Error).message, email: got.session.email, connected: true, accounts: [] }, 502);
      }
    }

    /* API token connect (no OAuth needed) */
    if (url.pathname === '/api/token/connect' && request.method === 'POST') {
      const got = await getSession(request, env);
      if (!got) return json({ error: 'unauthorized — start the installer first' }, 401);
      const body = await readJson(request, 8192);
      const apiToken = body && typeof body.apiToken === 'string' ? body.apiToken.trim() : '';
      if (!apiToken || apiToken.length > 512) return json({ error: 'apiToken required' }, 400);
      try {
        const accounts: CloudflareAccount[] = await fetchAccounts(apiToken);
        got.session.accessToken = apiToken;
        got.session.tokenKind = 'token';
        await putSessionRecord(env.SESSIONS, got.id, got.session);
        return json({ ok: true, accounts });
      } catch (err) {
        return json({ error: `Invalid API token: ${(err as Error).message}` }, 401);
      }
    }

    /* list Cloudflare domains (site URL picker) */
    if (url.pathname === '/api/domains' && request.method === 'GET') {
      const got = await getSession(request, env);
      if (!got || !got.session.accessToken) return json({ error: 'unauthorized' }, 401);
      try {
        const res = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=50', {
          headers: { authorization: `Bearer ${got.session.accessToken}` },
        });
        const body = (await res.json()) as { success?: boolean; result?: Array<{ name?: string }> };
        if (!res.ok || body.success !== true || !Array.isArray(body.result)) {
          return json({ error: 'cannot list domains — token needs Zone:Read, or type the URL manually' }, 403);
        }
        const domains = body.result.map((z) => z.name).filter((n): n is string => typeof n === 'string');
        return json({ domains });
      } catch (err) {
        return json({ error: `could not list domains: ${(err as Error).message}` }, 502);
      }
    }

    /* deploy */
    if (url.pathname === '/api/deploy' && request.method === 'POST') {
      const got = await getSession(request, env);
      if (!got || !got.session.accessToken) {
        return json({ error: 'unauthorized — connect your Cloudflare account first' }, 401);
      }
      const body = await readJson(request, 4096);
      const accountId = body && typeof body.accountId === 'string' ? body.accountId.trim() : '';
      if (!accountId) return json({ error: 'accountId required' }, 400);
      const dryRun = body?.dryRun !== false;
      const input = {
        accountId,
        workerName:
          body && typeof body.workerName === 'string' && body.workerName.trim() ? body.workerName.trim() : undefined,
        databaseName:
          body && typeof body.databaseName === 'string' && body.databaseName.trim()
            ? body.databaseName.trim()
            : undefined,
        ratelimitNamespaceId:
          body && typeof body.ratelimitNamespaceId === 'string' && body.ratelimitNamespaceId.trim()
            ? body.ratelimitNamespaceId.trim()
            : undefined,
        cfAccessTeam:
          body && typeof body.cfAccessTeam === 'string' && body.cfAccessTeam.trim() ? body.cfAccessTeam.trim() : undefined,
        cfAccessAud:
          body && typeof body.cfAccessAud === 'string' && body.cfAccessAud.trim() ? body.cfAccessAud.trim() : undefined,
        siteUrl:
          body && typeof body.siteUrl === 'string' && body.siteUrl.trim() ? body.siteUrl.trim() : undefined,
        dryRun,
      };

      try {
        const result = await runInstallerDeployWorker({ accessToken: got.session.accessToken, input });
        const deployedWorkerName = input.workerName?.trim() || 'staticlayer';
        const { endpoint, warning } = await resolveWorkerEndpoint(
          got.session.accessToken,
          input.accountId,
          deployedWorkerName,
          url.origin,
        );

        if (!dryRun) {
          if (got.session.tokenKind === 'oauth') {
            try {
              await revokeToken({
                clientId: requireEnv(env, 'STATICLAYER_CLIENT_ID'),
                clientSecret: requireEnv(env, 'STATICLAYER_CLIENT_SECRET'),
                accessToken: got.session.accessToken,
              });
            } catch (err) {
              console.error(`[installer] token revoke failed: ${(err as Error).message}`);
            }
          }
          await env.SESSIONS.delete(`s:${got.id}`);
        }

        return json({ ...result, endpoint, endpointWarning: warning });
      } catch (err) {
        return json({ error: (err as Error).message }, 500);
      }
    }

    return json({ error: 'not found' }, 404);
  },
};

export default worker;
