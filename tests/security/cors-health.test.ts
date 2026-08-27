/**
 * CORS allowlist (THREAT_MODEL T15/T16) + health endpoint (Phase F).
 *
 * The Worker is fail-closed: with an empty ALLOWED_ORIGINS there are NO
 * cross-origin headers. Only explicitly listed origins are echoed back
 * (never `*`), and admin routes share the same policy.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnWorker, type WorkerOptions } from './worker.ts';

let mf: Awaited<ReturnType<typeof spawnWorker>> | undefined;

async function start(options: WorkerOptions = {}) {
  mf = await spawnWorker(options);
  return mf;
}

afterEach(async () => {
  if (mf) {
    await mf.dispose();
    mf = undefined;
  }
});

describe('CORS — explicit allowlist, fail-closed', () => {
  it('emits NO access-control headers when ALLOWED_ORIGINS is empty', async () => {
    const w = await start(); // no allowedOrigins
    const res = await w.dispatchFetch('http://localhost/api/comments?article_path=/a', {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.status).toBe(200); // same-origin semantics still work
  });

  it('echoes an allowlisted origin + Vary on public API', async () => {
    const w = await start({ allowedOrigins: 'https://blog.example,https://www.example.com' });
    const res = await w.dispatchFetch('http://localhost/api/comments?article_path=/a', {
      headers: { origin: 'https://blog.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://blog.example');
    expect(res.headers.get('vary')).toBe('origin');
  });

  it('rejects a non-allowlisted origin (no ACAO header)', async () => {
    const w = await start({ allowedOrigins: 'https://blog.example' });
    const res = await w.dispatchFetch('http://localhost/api/comments?article_path=/a', {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves OPTIONS preflight only for allowlisted origins', async () => {
    const w = await start({ allowedOrigins: 'https://blog.example' });
    const ok = await w.dispatchFetch('http://localhost/api/comments', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://blog.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://blog.example');
    expect(ok.headers.get('access-control-allow-methods')).toContain('POST');
    expect(ok.headers.get('access-control-allow-headers')).toContain('x-csrf-token');

    const denied = await w.dispatchFetch('http://localhost/api/comments', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('applies the same policy to admin routes (never wildcard)', async () => {
    const w = await start({ allowedOrigins: 'https://admin.example' });
    const res = await w.dispatchFetch('http://localhost/api/admin/comments', {
      headers: { origin: 'https://admin.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://admin.example');
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('does not set ACAO when no Origin header is present (same-origin)', async () => {
    const w = await start({ allowedOrigins: 'https://blog.example' });
    const res = await w.dispatchFetch('http://localhost/api/comments?article_path=/a');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.status).toBe(200);
  });
});

describe('Health endpoint', () => {
  it('GET /api/health reports runtime + schema version', async () => {
    const w = await start();
    const res = await w.dispatchFetch('http://localhost/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      status: string;
      version: string;
      schemaVersion: number;
    };
    expect(body.name).toBe('staticlayer');
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(body.schemaVersion).toBeGreaterThanOrEqual(2);
  });

  it('GET / returns the same health payload', async () => {
    const w = await start();
    const res = await w.dispatchFetch('http://localhost/');
    const body = (await res.json()) as { name: string; version: string };
    expect(body.name).toBe('staticlayer');
    expect(body.version).toBeTruthy();
  });
});
