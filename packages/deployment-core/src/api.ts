import { ApiError, type CloudflareApi, type DeployWorkerRequest, type D1Info } from './types.ts';

/**
 * Cloudflare REST API client (library-first, @staticlayer/deployment-core).
 *
 * Endpoints (verified against official docs, 2026-08-26 — see
 * docs/cloudflare-assumptions.md §10):
 *   PUT    /accounts/{id}/workers/scripts/{name}        upload worker (multipart metadata)
 *   GET    /accounts/{id}/workers/scripts/{name}        script exists (404 => missing)
 *   PATCH  /accounts/{id}/workers/scripts/{name}/secrets-bulk   bulk set secrets
 *   GET    /accounts/{id}/workers/scripts/{name}/secrets        list secrets
 *   POST   /accounts/{id}/d1/database                   create D1
 *   GET    /accounts/{id}/d1/database                   list D1
 *
 * Every call either succeeds or throws an ApiError with the exact status and
 * response detail — the engine NEVER swallows failures. No console output.
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

export interface ApiOptions {
  accountId: string;
  apiToken: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

function buildMultipart(
  parts: Array<{ name: string; filename?: string; contentType: string; body: string }>,
): { body: Uint8Array; contentType: string } {
  const boundary = `----staticlayer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const part of parts) {
    chunks.push(enc.encode(`--${boundary}\r\n`));
    chunks.push(
      enc.encode(
        `Content-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}\r\n`,
      ),
    );
    chunks.push(enc.encode(`Content-Type: ${part.contentType}\r\n\r\n`));
    chunks.push(enc.encode(part.body));
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function errorDetail(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const errors = (body as { errors?: Array<{ message?: string }> }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.map((e) => e.message ?? 'unknown').join('; ');
    }
    const text = JSON.stringify(body);
    if (text.length > 0) return text.slice(0, 300);
  }
  return fallback;
}

export class CloudflareApiClient implements CloudflareApi {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: ApiOptions) {
    this.base = `${API_BASE}/accounts/${encodeURIComponent(opts.accountId)}`;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.opts.apiToken}`, ...(init.headers ?? {}) },
      });
    } catch (err) {
      throw new ApiError(0, `network error calling ${path}: ${(err as Error).message}`, path);
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    const failed = !res.ok || (body !== null && (body as { success?: boolean }).success === false);
    if (failed) {
      const detail = errorDetail(body, res.statusText);
      throw new ApiError(
        res.status,
        `Cloudflare API ${init.method ?? 'GET'} ${path} failed (${res.status}): ${detail}`,
        path,
      );
    }
    return (body ?? {}) as Record<string, unknown>;
  }

  async listDatabases(): Promise<D1Info[]> {
    const body = await this.request('/d1/database');
    const result = body.result;
    if (!Array.isArray(result)) throw new ApiError(200, 'list D1: unexpected result shape', '/d1/database');
    return result.map((r) => ({ id: (r as { uuid: string }).uuid, name: (r as { name: string }).name }));
  }

  async createDatabase(name: string): Promise<D1Info> {
    const body = await this.request('/d1/database', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const result = body.result as { uuid?: string; name?: string } | undefined;
    if (!result?.uuid) {
      throw new ApiError(200, `create D1 "${name}": API returned success but no uuid`, '/d1/database');
    }
    return { id: result.uuid, name: result.name ?? name };
  }

  async getWorker(name: string): Promise<{ exists: boolean }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/workers/scripts/${encodeURIComponent(name)}`, {
        headers: { authorization: `Bearer ${this.opts.apiToken}` },
      });
    } catch (err) {
      throw new ApiError(0, `network error: ${(err as Error).message}`, `/workers/scripts/${name}`);
    }
    if (res.status === 404) return { exists: false };
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = errorDetail(await res.json(), detail);
      } catch {
        /* keep statusText */
      }
      throw new ApiError(res.status, `Cloudflare API GET /workers/scripts/${name} failed (${res.status}): ${detail}`, `/workers/scripts/${name}`);
    }
    return { exists: true };
  }

  async listSecrets(workerName: string): Promise<Array<{ name: string }>> {
    const body = await this.request(`/workers/scripts/${encodeURIComponent(workerName)}/secrets`);
    const result = body.result;
    if (!Array.isArray(result)) throw new ApiError(200, 'list secrets: unexpected result shape', `/workers/scripts/${workerName}/secrets`);
    return result.map((r) => ({ name: (r as { name: string }).name }));
  }

  /**
   * Workers Bulk Secrets API (verified 2026-08-26):
   *   PATCH /accounts/{id}/workers/scripts/{name}/secrets-bulk
   * JSON Merge Patch (RFC 7396): body `{ secrets: { NAME: { name, type:
   * "secret_text", text } } }`. Values are sent directly from server memory to
   * Cloudflare — never returned, never logged.
   */
  async setSecretsBulk(workerName: string, values: Record<string, string>): Promise<void> {
    const secrets: Record<string, unknown> = {};
    for (const [name, text] of Object.entries(values)) {
      secrets[name] = { name, type: 'secret_text', text };
    }
    await this.request(`/workers/scripts/${encodeURIComponent(workerName)}/secrets-bulk`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secrets }),
    });
  }

  async deployWorker(workerName: string, req: DeployWorkerRequest): Promise<void> {
    const { body, contentType } = buildMultipart([
      { name: 'metadata', contentType: 'application/json', body: JSON.stringify(req.metadata) },
      { name: req.mainModule, filename: req.mainModule, contentType: 'application/javascript+module', body: req.code },
    ]);
    await this.request(`/workers/scripts/${encodeURIComponent(workerName)}`, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body,
    });
  }
}
