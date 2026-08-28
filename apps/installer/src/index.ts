/**
 * StaticLayer Web Installer — HTTP server (no framework).
 *
 * Env config:
 *   STATICLAYER_CLIENT_ID        OAuth client id
 *   STATICLAYER_CLIENT_SECRET    OAuth client secret (server-side only)
 *   STATICLAYER_REDIRECT_URI     OAuth redirect (e.g. http://localhost:8788/oauth/callback)
 *   STATICLAYER_SESSION_SECRET   HMAC secret for session cookies
 *   STATICLAYER_INSTALLER_URL    public base URL (default http://localhost:8788)
 *   PORT                          default 8788
 *
 * Security invariants (docs/oauth-scopes.md + SECURITY_AUDIT_REPORT.md):
 *   - OAuth flow uses the Authorization Code grant; the client secret never
 *     leaves the server.
 *   - The access token is kept ONLY in an in-memory session (never in a cookie,
 *     never persisted).
 *   - After a successful deploy, the OAuth token is revoked and the session
 *     cleared. The generated worker secrets (SESSION_SECRET/POW_SECRET) are
 *     pushed server-side via the Workers Bulk Secrets API and are NEVER
 *     returned to the browser. The one exception: the operator's ADMIN_SECRET
 *     is returned exactly once, after a real deploy, so they can sign in to
 *     /admin.html (Phase 4 audit).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchAccounts,
  revokeToken,
  type CloudflareAccount,
} from './oauth.ts';
import {
  clearSessionCookieHeader,
  newSessionId,
  SESSION_COOKIE,
  sessionCookieHeader,
  verifySessionValue,
} from './auth.ts';
import { runInstallerDeploy } from './deploy.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve the public dir from either the built bundle (dist/public) or the
// source tree (public), so tests and `node src/index.ts` work too.
const PUBLIC_DIR = (() => {
  for (const dir of [join(__dirname, 'public'), join(__dirname, '..', 'public')]) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return join(__dirname, 'public');
})();

// Site links injected into the wizard at serve time — override at deploy with
// the real site/repo URLs (e.g. STATICLAYER_SITE_BASE=https://example.com).
const SITE_BASE = process.env.STATICLAYER_SITE_BASE || 'https://Abla25.github.io/StaticLayer/';
const REPO_URL = process.env.STATICLAYER_REPO_URL || 'https://github.com/Abla25/StaticLayer';

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

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

interface Session {
  accessToken: string;
  /** Where the access token came from: OAuth consent, pasted API token, or none yet. */
  tokenKind: 'oauth' | 'token' | '';
  email: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();
const oauthStates = new Map<string, number>(); // state -> expiresAt

const SESSION_TTL_MS = 30 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function readBody(req: IncomingMessage, capBytes = 65536): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > capBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(302, { location, ...extraHeaders });
  res.end();
}

function getSession(req: IncomingMessage): { id: string; session: Session } | null {
  const cookie = (req.headers.cookie ?? '').split(';').map((c) => c.trim());
  const raw = cookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  const token = raw.slice(SESSION_COOKIE.length + 1);
  const sessionId = verifySessionValue(token, requireEnv('STATICLAYER_SESSION_SECRET'));
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return { id: sessionId, session };
}

function requireJsonObject(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('invalid JSON body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON body must be an object');
  }
  return parsed as Record<string, unknown>;
}

function getStaticFile(pathname: string): { contentType: string; body: string | Buffer } | null {
  if (pathname === '/' || pathname === '/index.html') {
    let body = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
    // Rewrite the placeholder site/repo links with the real (env) values.
    body = body.replaceAll('https://staticlayer.github.io/staticlayer/', SITE_BASE);
    body = body.replaceAll('https://github.com/staticlayer/staticlayer', REPO_URL);
    return { contentType: 'text/html; charset=utf-8', body };
  }
  if (pathname === '/app.js') {
    return { contentType: 'application/javascript; charset=utf-8', body: readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf8') };
  }
  if (pathname === '/nav.js') {
    return { contentType: 'application/javascript; charset=utf-8', body: readFileSync(join(PUBLIC_DIR, 'nav.js'), 'utf8') };
  }
  if (pathname === '/icon.png') {
    return { contentType: 'image/png', body: readFileSync(join(PUBLIC_DIR, 'icon.png')) };
  }
  return null;
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  /* ---------- static ---------- */
  const file = getStaticFile(url.pathname);
  if (file) {
    res.writeHead(200, { 'content-type': file.contentType, 'cache-control': 'no-store' });
    res.end(file.body);
    return;
  }

  /* ---------- meta + local session (dev) ---------- */
  if (url.pathname === '/api/meta' && req.method === 'GET') {
    json(res, 200, {
      dev: process.env.STATICLAYER_DEV_MODE === '1',
      oauthConfigured: !env('STATICLAYER_CLIENT_ID', '').startsWith('local-'),
    });
    return;
  }

  if (url.pathname === '/api/auth/local' && req.method === 'GET') {
    // Dev/self-hosted only: the operator IS the owner, so no email proof is
    // needed. A local session is created directly.
    if (process.env.STATICLAYER_DEV_MODE !== '1') {
      json(res, 403, { error: 'local session is only available in dev mode' });
      return;
    }
    const sessionId = newSessionId();
    sessions.set(sessionId, {
      accessToken: '',
      tokenKind: '',
      email: 'local@dev',
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    redirect(res, '/', {
      'set-cookie': sessionCookieHeader(sessionId, requireEnv('STATICLAYER_SESSION_SECRET')),
    });
    return;
  }

  if (url.pathname === '/api/start' && req.method === 'GET') {
    // Self-hosted: the operator IS the owner — create a local session directly
    // (same as the hosted installer worker's /api/start).
    const sessionId = newSessionId();
    sessions.set(sessionId, {
      accessToken: '',
      tokenKind: '',
      email: 'local@dev',
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    redirect(res, '/', {
      'set-cookie': sessionCookieHeader(sessionId, requireEnv('STATICLAYER_SESSION_SECRET')),
    });
    return;
  }

  /* ---------- OAuth ---------- */
  if (url.pathname === '/api/oauth/start' && req.method === 'GET') {
    const got = getSession(req);
    if (!got) {
      json(res, 401, { error: 'unauthorized — start the installer first' });
      return;
    }
    const session = got.session;
    const state = newSessionId();
    oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
    const authorizeUrl = buildAuthorizeUrl({
      clientId: requireEnv('STATICLAYER_CLIENT_ID'),
      redirectUri: requireEnv('STATICLAYER_REDIRECT_URI'),
      state,
    });
    redirect(res, authorizeUrl);
    return;
  }

  if (url.pathname === '/oauth/callback' && req.method === 'GET') {
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const error = url.searchParams.get('error');
    const stateExp = oauthStates.get(state);
    oauthStates.delete(state);
    if (error) {
      html(res, 400, `<h1>Autorizzazione rifiutata</h1><p>${error}</p>`);
      return;
    }
    if (!stateExp || stateExp <= Date.now() || !code) {
      html(res, 400, '<h1>Stato OAuth non valido o scaduto</h1><p>Riprova.</p>');
      return;
    }
    let exchanged: { accessToken: string; expiresIn?: number };
    try {
      exchanged = await exchangeCodeForToken({
        clientId: requireEnv('STATICLAYER_CLIENT_ID'),
        clientSecret: requireEnv('STATICLAYER_CLIENT_SECRET'),
        redirectUri: requireEnv('STATICLAYER_REDIRECT_URI'),
        code,
      });
    } catch (err) {
      html(res, 502, `<h1>Token exchange fallito</h1><p>${(err as Error).message}</p>`);
      return;
    }
    const got = getSession(req);
    if (!got) {
      html(res, 401, '<h1>Sessione scaduta</h1><p>Accedi di nuovo.</p>');
      return;
    }
    const session = got.session;
    session.accessToken = exchanged.accessToken;
    session.tokenKind = 'oauth';
    session.expiresAt = Math.min(Date.now() + SESSION_TTL_MS, Date.now() + (exchanged.expiresIn ?? SESSION_TTL_MS) * 1000);
    redirect(res, '/');
    return;
  }

  /* ---------- accounts ---------- */
  if (url.pathname === '/api/me' && req.method === 'GET') {
    const got = getSession(req);
    if (!got) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    const session = got.session;
    if (!session.accessToken) {
      json(res, 200, { email: session.email, connected: false, accounts: [] });
      return;
    }
    let accounts: CloudflareAccount[];
    try {
      accounts = await fetchAccounts(session.accessToken);
    } catch (err) {
      json(res, 502, { error: (err as Error).message, email: session.email, connected: true, accounts: [] });
      return;
    }
    json(res, 200, { email: session.email, connected: true, accounts });
    return;
  }

  /* ---------- API token connect (no OAuth needed) ---------- */
  if (url.pathname === '/api/token/connect' && req.method === 'POST') {
    const got = getSession(req);
    if (!got) {
      json(res, 401, { error: 'unauthorized — start the installer first' });
      return;
    }
    const session = got.session;
    const body = requireJsonObject(await readBody(req, 8192));
    const apiToken = typeof body.apiToken === 'string' ? body.apiToken.trim() : '';
    if (!apiToken || apiToken.length > 512) {
      json(res, 400, { error: 'apiToken required' });
      return;
    }
    // Validate by listing accounts. On success the token lives ONLY in this
    // in-memory session (never in a cookie, never logged) and is cleared after
    // the deploy.
    let accounts: CloudflareAccount[];
    try {
      accounts = await fetchAccounts(apiToken);
    } catch (err) {
      json(res, 401, { error: `Invalid API token: ${(err as Error).message}` });
      return;
    }
    session.accessToken = apiToken;
    session.tokenKind = 'token';
    json(res, 200, { ok: true, accounts });
    return;
  }

  /* ---------- list Cloudflare domains (site URL picker) ---------- */
  if (url.pathname === '/api/domains' && req.method === 'GET') {
    const got = getSession(req);
    if (!got || !got.session.accessToken) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    try {
      const dr = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=50', {
        headers: { authorization: `Bearer ${got.session.accessToken}` },
      });
      const body = (await dr.json()) as { success?: boolean; result?: Array<{ name?: string }> };
      if (!dr.ok || body.success !== true || !Array.isArray(body.result)) {
        json(res, 403, { error: 'cannot list domains — token needs Zone:Read, or type the URL manually' });
        return;
      }
      const domains = body.result.map((z) => z.name).filter((n): n is string => typeof n === 'string');
      json(res, 200, { domains });
    } catch (err) {
      json(res, 502, { error: `could not list domains: ${(err as Error).message}` });
    }
    return;
  }

  /* ---------- deploy ---------- */
  if (url.pathname === '/api/deploy' && req.method === 'POST') {
    const got = getSession(req);
    if (!got || !got.session.accessToken) {
      json(res, 401, { error: 'unauthorized — connect your Cloudflare account first' });
      return;
    }
    const session = got.session;
    const body = requireJsonObject(await readBody(req, 4096));
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    if (!accountId) {
      json(res, 400, { error: 'accountId required' });
      return;
    }
    const dryRun = body.dryRun !== false;
    const input = {
      accountId,
      workerName: typeof body.workerName === 'string' && body.workerName.trim() ? body.workerName.trim() : undefined,
      databaseName: typeof body.databaseName === 'string' && body.databaseName.trim() ? body.databaseName.trim() : undefined,
      ratelimitNamespaceId:
        typeof body.ratelimitNamespaceId === 'string' && body.ratelimitNamespaceId.trim()
          ? body.ratelimitNamespaceId.trim()
          : undefined,
      cfAccessTeam: typeof body.cfAccessTeam === 'string' && body.cfAccessTeam.trim() ? body.cfAccessTeam.trim() : undefined,
      cfAccessAud: typeof body.cfAccessAud === 'string' && body.cfAccessAud.trim() ? body.cfAccessAud.trim() : undefined,
      githubClientId:
        typeof body.githubClientId === 'string' && body.githubClientId.trim() ? body.githubClientId.trim() : undefined,
      githubClientSecret:
        typeof body.githubClientSecret === 'string' && body.githubClientSecret.trim()
          ? body.githubClientSecret.trim()
          : undefined,
      githubAdminIds:
        typeof body.githubAdminIds === 'string' && body.githubAdminIds.trim() ? body.githubAdminIds.trim() : undefined,
      githubAdminLogins:
        typeof body.githubAdminLogins === 'string' && body.githubAdminLogins.trim()
          ? body.githubAdminLogins.trim()
          : undefined,
      siteUrl: typeof body.siteUrl === 'string' && body.siteUrl.trim() ? body.siteUrl.trim() : undefined,
      dryRun,
    };

    try {
      const result = await runInstallerDeploy({ accessToken: session.accessToken, input });
      // Resolve the deployed worker's endpoint BEFORE the session is cleared
      // (the API token is needed to read the account's workers.dev subdomain).
      const deployedWorkerName = input.workerName?.trim() || 'staticlayer';
      const { endpoint, warning } = await resolveWorkerEndpoint(
        session.accessToken,
        input.accountId,
        deployedWorkerName,
        env('STATICLAYER_INSTALLER_URL', 'http://localhost:8788'),
      );
      let endpointWarning = warning;
      if (!dryRun && result.workersDevEnabled === false) {
        endpointWarning =
          'your Worker is deployed but not published on *.workers.dev — enable the workers.dev route in the Cloudflare dashboard (Workers & Pages → your Worker → Settings → Domains & Routes), then refresh this page.' +
          (result.workersDevError ? ` Detail: ${result.workersDevError}` : '');
      }

      if (!dryRun) {
        // Apply succeeded. Revoke the OAuth token (only when it came from the
        // OAuth consent screen — pasted API tokens are user-managed) and drop
        // the session. SESSION_SECRET/POW_SECRET were pushed to Cloudflare
        // server-side and never appear in this response; ADMIN_SECRET is
        // returned exactly once so the operator can log in to /admin.html.
        if (session.tokenKind === 'oauth') {
          try {
            await revokeToken({
              clientId: requireEnv('STATICLAYER_CLIENT_ID'),
              clientSecret: requireEnv('STATICLAYER_CLIENT_SECRET'),
              accessToken: session.accessToken,
            });
          } catch (err) {
            console.error(`[installer] token revoke failed: ${(err as Error).message}`);
          }
        }
        sessions.delete(got.id);
        session.accessToken = '';
        session.expiresAt = 0;
      }

      // `result` contains { actions, alreadyInSync } plus `adminSecret` (the
      // operator's own admin password, shown exactly once after a real deploy).
      json(res, 200, {
        ...result,
        endpoint,
        endpointWarning,
      });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
    return;
  }

  json(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  route(req, res, url).catch((err: Error) => {
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  });
});

const port = Number(env('PORT', '8788'));
server.listen(port, () => {
  console.log(`[installer] StaticLayer Web Installer on http://localhost:${port}`);
  console.log(`[installer] dev mode: ${process.env.STATICLAYER_DEV_MODE === '1' ? 'ON' : 'OFF'}`);
});

export { server, sessions, oauthStates };
