import { describe, expect, it } from 'vitest';
import {
  newSessionId,
  sessionCookieHeader,
  signSessionValue,
  verifySessionValue,
} from '../src/auth.ts';

const SECRET = 'installer-test-session-secret-0123456789';

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
