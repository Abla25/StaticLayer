import { describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchAccounts,
  INSTALLER_OAUTH_SCOPES,
  OAUTH_ENDPOINTS,
  OAuthError,
  revokeToken,
} from '../src/oauth.ts';

describe('installer OAuth — least privilege', () => {
  it('requests EXACTLY the minimal scope set, never broad/account-edit/user/zone scopes', () => {
    const url = new URL(
      buildAuthorizeUrl({ clientId: 'client-123', redirectUri: 'https://app.example/cb', state: 'st-1' }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(OAUTH_ENDPOINTS.authorize);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/cb');
    expect(url.searchParams.get('state')).toBe('st-1');

    const scopes = (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean);
    expect([...scopes].sort()).toEqual([...INSTALLER_OAUTH_SCOPES].sort());
    expect(scopes.length).toBe(INSTALLER_OAUTH_SCOPES.length);

    // Never any broad or unrelated scope.
    for (const s of scopes) {
      expect(s).not.toMatch(/account.*(edit|write|all|admin)/i);
      expect(s).not.toMatch(/user:/i);
      expect(s).not.toMatch(/zone/i);
      expect(s).not.toMatch(/access|all|full/i);
    }
    expect(scopes).not.toContain('account:edit');
    expect(scopes).not.toContain('user:read');
  });

  it('keeps the scope set exactly as defined in INSTALLER_OAUTH_SCOPES', () => {
    // Guards against accidental scope creep in future edits.
    expect(INSTALLER_OAUTH_SCOPES).toEqual(['workers-platform.write', 'd1.write', 'account.read']);
  });
});

describe('installer OAuth — token exchange', () => {
  it('exchanges a code using client_secret_post and returns the access token', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchFn = async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { accessToken, expiresIn } = await exchangeCodeForToken(
      { clientId: 'c', clientSecret: 's', redirectUri: 'https://app.example/cb', code: 'code-9' },
      fetchFn as never,
    );
    expect(accessToken).toBe('tok-1');
    expect(expiresIn).toBe(3600);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(OAUTH_ENDPOINTS.token);
    const params = new URLSearchParams(calls[0]!.body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('client_id')).toBe('c');
    expect(params.get('client_secret')).toBe('s');
    expect(params.get('code')).toBe('code-9');
    expect(params.get('redirect_uri')).toBe('https://app.example/cb');
  });

  it('throws OAuthError on non-2xx response', async () => {
    const fetchFn = async () => new Response('invalid_client', { status: 400 });
    await expect(
      exchangeCodeForToken({ clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'x' }, fetchFn as never),
    ).rejects.toThrow(OAuthError);
  });

  it('throws OAuthError when access_token is missing', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ token_type: 'Bearer' }), { status: 200 });
    await expect(
      exchangeCodeForToken({ clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'x' }, fetchFn as never),
    ).rejects.toThrow(/no access_token/);
  });
});

describe('installer OAuth — revoke + accounts', () => {
  it('revokes the token (RFC 7009, client_secret_post)', async () => {
    const calls: string[] = [];
    const fetchFn = async (url: string, init: { body: string }) => {
      calls.push(url);
      expect(new URLSearchParams(init.body).get('token')).toBe('tok-1');
      return new Response('', { status: 200 });
    };
    await revokeToken({ clientId: 'c', clientSecret: 's', accessToken: 'tok-1' }, fetchFn as never);
    expect(calls).toEqual([OAUTH_ENDPOINTS.revoke]);
  });

  it('throws OAuthError on 5xx during revoke but tolerates 4xx (invalid/unknown token)', async () => {
    await expect(
      revokeToken({ clientId: 'c', clientSecret: 's', accessToken: 'x' }, (async () => new Response('', { status: 503 })) as never),
    ).rejects.toThrow(OAuthError);
    await expect(
      revokeToken({ clientId: 'c', clientSecret: 's', accessToken: 'x' }, (async () => new Response('', { status: 400 })) as never),
    ).resolves.toBeUndefined();
  });

  it('lists accounts the token can access', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ success: true, result: [{ id: 'a1', name: 'Acme' }, { id: 'a2', name: 'Beta' }] }), {
        status: 200,
      });
    const accounts = await fetchAccounts('tok-1', fetchFn as never);
    expect(accounts).toEqual([
      { id: 'a1', name: 'Acme' },
      { id: 'a2', name: 'Beta' },
    ]);
  });

  it('throws OAuthError when listing accounts fails (success:false)', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'nope' }] }), { status: 403 });
    await expect(fetchAccounts('tok-1', fetchFn as never)).rejects.toThrow(OAuthError);
  });
});
