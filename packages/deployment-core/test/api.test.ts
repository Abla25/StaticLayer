import { describe, expect, it } from 'vitest';
import { CloudflareApiClient } from '../src/api.ts';
import { ApiError } from '../src/types.ts';

/**
 * Test the real HTTP client against a stub fetch: multipart deploy, 404
 * handling, the Bulk Secrets API body shape, and — critically — that every
 * failure surfaces as an ApiError with the exact status and detail
 * (never silent).
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(handler: (url: string | Request | URL, init?: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string | Request | URL; init?: RequestInit }> = [];
  const fetchFn = async (url: string | Request | URL, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  const client = new CloudflareApiClient({ accountId: 'acc1', apiToken: 'token', fetchFn });
  return { client, calls };
}

describe('CloudflareApiClient', () => {
  it('getWorker returns exists:false on 404', async () => {
    const { client } = makeClient(async () =>
      jsonResponse(404, { success: false, errors: [{ code: 10007, message: 'script_not_found' }] }),
    );
    await expect(client.getWorker('staticlayer')).resolves.toEqual({ exists: false });
  });

  it('deployWorker builds a multipart request with metadata + main module', async () => {
    let capturedInit: RequestInit | undefined;
    const { client } = makeClient(async (_url, init) => {
      capturedInit = init;
      return jsonResponse(200, { success: true, result: { id: 'staticlayer' } });
    });
    await client.deployWorker('staticlayer', {
      code: 'export default {};',
      mainModule: 'worker.js',
      metadata: {
        main_module: 'worker.js',
        compatibility_date: '2026-08-26',
        bindings: [{ type: 'd1', name: 'DB', id: 'd1-1' }],
        triggers: { crons: ['0 3 * * *'] },
      },
    });

    expect(capturedInit?.method).toBe('PUT');
    const contentType = String(capturedInit?.headers && (capturedInit.headers as Record<string, string>)['content-type']);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    const bodyText = new TextDecoder().decode(capturedInit?.body as Uint8Array);
    expect(bodyText).toContain('Content-Disposition: form-data; name="metadata"');
    expect(bodyText).toContain('"main_module":"worker.js"');
    expect(bodyText).toContain('Content-Disposition: form-data; name="worker.js"; filename="worker.js"');
    expect(bodyText).toContain('application/javascript+module');
  });

  it('setSecretsBulk PATCHes the secrets-bulk endpoint with JSON Merge Patch body', async () => {
    let captured: { url: string | Request | URL; init?: RequestInit } | undefined;
    const { client } = makeClient(async (url, init) => {
      captured = { url, init };
      return jsonResponse(200, { success: true, result: {} });
    });

    await client.setSecretsBulk('staticlayer', {
      ADMIN_SECRET: 'a',
      SESSION_SECRET: 'b',
      POW_SECRET: 'c',
    });

    expect(String(captured?.url)).toContain('/workers/scripts/staticlayer/secrets-bulk');
    expect(captured?.init?.method).toBe('PATCH');
    const body = JSON.parse(String(captured?.init?.body)) as { secrets: Record<string, unknown> };
    expect(Object.keys(body.secrets).sort()).toEqual(['ADMIN_SECRET', 'POW_SECRET', 'SESSION_SECRET']);
    expect(body.secrets['ADMIN_SECRET']).toEqual({ name: 'ADMIN_SECRET', type: 'secret_text', text: 'a' });
  });

  it('propagates non-2xx responses as ApiError with the exact detail', async () => {
    const { client } = makeClient(async () =>
      jsonResponse(500, { success: false, errors: [{ code: 9009, message: 'workers.api.error.script_too_large' }] }),
    );
    await expect(client.createDatabase('staticlayer')).rejects.toThrow(ApiError);
    await expect(client.createDatabase('staticlayer')).rejects.toThrow(/500/);
    await expect(client.createDatabase('staticlayer')).rejects.toThrow(/script_too_large/);
  });

  it('propagates HTTP 200 with success:false as an error (CF convention)', async () => {
    const { client } = makeClient(async () =>
      jsonResponse(200, { success: false, errors: [{ code: 9107, message: 'missing auth' }] }),
    );
    await expect(client.setSecretsBulk('staticlayer', { ADMIN_SECRET: 'x' })).rejects.toThrow(/missing auth/);
  });
});
