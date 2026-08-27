import { describe, expect, it } from 'vitest';
import {
  createMagicToken,
  newSessionId,
  sessionCookieHeader,
  signSessionValue,
  verifyMagicToken,
  verifySessionValue,
} from '../src/auth.ts';

const SECRET = 'installer-test-session-secret-0123456789';

describe('magic link', () => {
  it('creates and verifies a valid token for the right email', () => {
    const now = 1_700_000_000_000;
    const { token, link, expiresAt } = createMagicToken('dev@example.com', SECRET, {
      baseUrl: 'http://localhost:8788',
      nowMs: now,
    });
    expect(expiresAt).toBe(now + 15 * 60 * 1000);
    expect(link).toContain('/api/auth/verify?token=');
    expect(link.startsWith('http://localhost:8788')).toBe(true);
    expect(verifyMagicToken(token, SECRET, now)).toBe('dev@example.com');
  });

  it('rejects a tampered token', () => {
    const now = 1_700_000_000_000;
    const { token } = createMagicToken('dev@example.com', SECRET, { nowMs: now });
    const tampered = token.slice(0, -4) + (token.endsWith('0000') ? '1111' : '0000');
    expect(verifyMagicToken(tampered, SECRET, now)).toBeNull();
  });

  it('rejects an expired token', () => {
    const now = 1_700_000_000_000;
    const { token } = createMagicToken('dev@example.com', SECRET, { nowMs: now });
    expect(verifyMagicToken(token, SECRET, now + 16 * 60 * 1000)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const now = 1_700_000_000_000;
    const { token } = createMagicToken('dev@example.com', SECRET, { nowMs: now });
    expect(verifyMagicToken(token, 'other-secret', now)).toBeNull();
  });

  it('rejects garbage input without throwing', () => {
    expect(verifyMagicToken('', SECRET)).toBeNull();
    expect(verifyMagicToken('no-dot', SECRET)).toBeNull();
    expect(verifyMagicToken('a.b.c', SECRET)).toBeNull();
  });
});

describe('session cookie', () => {
  it('signs and verifies a session value', () => {
    const id = newSessionId();
    const token = signSessionValue(id, SECRET);
    expect(token).not.toBe(id);
    expect(verifySessionValue(token, SECRET)).toBe(id);
    expect(verifySessionValue(id + '.bad', SECRET)).toBeNull();
  });

  it('builds a cookie header with HttpOnly/SameSite/Path and no Domain', () => {
    const header = sessionCookieHeader('abc', SECRET, 30 * 60 * 1000);
    expect(header).toMatch(/^SLSession=/);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=1800');
    expect(header).not.toContain('Domain=');
    expect(header).not.toContain('Secure'); // installer runs behind TLS in prod; Secure is set by the reverse proxy
  });
});
