/**
 * StaticLayer Web Installer — Cloudflare OAuth integration.
 *
 * Verified against official Cloudflare docs (2026-08-20/2026-08-25):
 *  - Endpoints: https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/
 *    Authorization: https://dash.cloudflare.com/oauth2/auth
 *    Token:        https://dash.cloudflare.com/oauth2/token
 *    Revoke:       https://dash.cloudflare.com/oauth2/revoke
 *  - "OAuth scope names correspond to Cloudflare API token permission names"
 *    (https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/).
 *    Exact scope IDs are enumerated via GET /oauth/scopes; permission names
 *    verified in fundamentals/api/reference/permissions (page 2026-08-25):
 *    "Workers Scripts: Edit" (account) and "Cloudflare D1: Edit" (account).
 *
 * SECURITY: the installer requests the MINIMUM scopes needed to deploy a
 * StaticLayer worker. It NEVER requests account-level edit/all or zone/user
 * scopes. See docs/oauth-scopes.md.
 */

export const OAUTH_ENDPOINTS = {
  authorize: 'https://dash.cloudflare.com/oauth2/auth',
  token: 'https://dash.cloudflare.com/oauth2/token',
  revoke: 'https://dash.cloudflare.com/oauth2/revoke',
} as const;

export const API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Minimal scope set for the installer (least privilege).
 * Format follows Cloudflare's OAuth scope naming (<group>.<level>) which
 * corresponds to API token permission names. Confirm the exact IDs against
 * GET /oauth/scopes at client registration time (docs/oauth-scopes.md).
 */
export const INSTALLER_OAUTH_SCOPES = [
  'workers-platform.write', // Workers Scripts: Edit — deploy worker + bind secrets
  'd1.write', // Cloudflare D1: Edit — create / list databases
  'account.read', // Account Settings: Read — list accounts for account selection
] as const;

export class OAuthError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}

/** Build the OAuth authorize URL. Pure function — trivially testable. */
export function buildAuthorizeUrl(params: AuthorizeParams): string {
  const url = new URL(OAUTH_ENDPOINTS.authorize);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('scope', (params.scopes ?? INSTALLER_OAUTH_SCOPES).join(' '));
  return url.toString();
}

export interface TokenExchangeParams {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}

export type FetchFn = typeof fetch;

/** Exchange an authorization code for an access token (client_secret_post). */
export async function exchangeCodeForToken(
  params: TokenExchangeParams,
  fetchFn: FetchFn = fetch,
): Promise<{ accessToken: string; expiresIn?: number }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    code: params.code,
  });
  let res: Response;
  try {
    res = await fetchFn(OAUTH_ENDPOINTS.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new OAuthError(`token exchange network error: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new OAuthError(`token exchange failed (${res.status})`, res.status);
  }
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new OAuthError('token exchange returned invalid JSON');
  }
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new OAuthError('token exchange returned no access_token');
  }
  return {
    accessToken: data.access_token,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
  };
}

/** Revoke an access token (RFC 7009). The client secret stays server-side. */
export async function revokeToken(
  params: { clientId: string; clientSecret: string; accessToken: string },
  fetchFn: FetchFn = fetch,
): Promise<void> {
  const body = new URLSearchParams({
    token: params.accessToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });
  let res: Response;
  try {
    res = await fetchFn(OAUTH_ENDPOINTS.revoke, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new OAuthError(`token revoke network error: ${(err as Error).message}`);
  }
  // RFC 7009: 200 means revoked; 400 on invalid token. We only hard-fail on 5xx.
  if (res.status >= 500) {
    throw new OAuthError(`token revoke failed (${res.status})`, res.status);
  }
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

/** List the accounts the (user-authorized) token can access. */
export async function fetchAccounts(
  accessToken: string,
  fetchFn: FetchFn = fetch,
): Promise<CloudflareAccount[]> {
  let res: Response;
  try {
    res = await fetchFn(`${API_BASE}/accounts`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    throw new OAuthError(`list accounts network error: ${(err as Error).message}`);
  }
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new OAuthError('list accounts returned invalid JSON');
  }
  if (!res.ok || data.success === false) {
    throw new OAuthError(`list accounts failed (${res.status})`, res.status);
  }
  const result = Array.isArray(data.result) ? (data.result as Array<{ id?: string; name?: string }>) : [];
  return result
    .filter((r) => typeof r.id === 'string' && typeof r.name === 'string')
    .map((r) => ({ id: r.id as string, name: r.name as string }));
}
