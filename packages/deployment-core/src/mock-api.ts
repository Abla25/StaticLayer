import { ApiError, type CloudflareApi, type DeployWorkerRequest, type D1Info } from './types.ts';

/**
 * In-memory fake Cloudflare API for engine tests (@staticlayer/deployment-core
 * /testing), with fault injection:
 *   - failCreateDatabase / failDeploy: the API call throws (real error).
 *   - lieCreateDatabase / lieDeploy: the API returns SUCCESS but does not
 *     persist anything — the verify step must detect the discrepancy.
 *
 * `setSecretsBulk` is LENIENT on purpose: in the "API lies about success"
 * scenarios the mock must keep returning success so the VERIFY step is the
 * one that catches the discrepancy (mandatory test #3b). The real client
 * (api.test.ts) exercises strict error propagation. `secretCalls` counts
 * BULK calls (one per apply), not per-secret calls.
 */
export class MockCloudflareApi implements CloudflareApi {
  databases: D1Info[] = [];
  workers = new Set<string>();
  secrets = new Map<string, Set<string>>();

  createCalls = 0;
  deployCalls = 0;
  secretCalls = 0;

  /** Last deploy request (code + metadata) — recorded for assertions. */
  lastDeployRequest: DeployWorkerRequest | null = null;

  failCreateDatabase = false;
  lieCreateDatabase = false;
  failDeploy = false;
  lieDeploy = false;

  async listDatabases(): Promise<D1Info[]> {
    return [...this.databases];
  }

  async createDatabase(name: string): Promise<D1Info> {
    this.createCalls += 1;
    if (this.failCreateDatabase) {
      throw new ApiError(500, `create database ${name} failed`, '/d1/database');
    }
    if (this.lieCreateDatabase) {
      return { id: `fake-${name}`, name }; // "success" without persisting
    }
    const id = `d1-${this.databases.length + 1}`;
    this.databases.push({ id, name });
    return { id, name };
  }

  async getWorker(name: string): Promise<{ exists: boolean }> {
    return { exists: this.workers.has(name) };
  }

  async listSecrets(workerName: string): Promise<Array<{ name: string }>> {
    return [...(this.secrets.get(workerName) ?? [])].map((name) => ({ name }));
  }

  async setSecretsBulk(workerName: string, values: Record<string, string>): Promise<void> {
    this.secretCalls += 1;
    const set = this.secrets.get(workerName) ?? new Set<string>();
    for (const name of Object.keys(values)) set.add(name);
    this.secrets.set(workerName, set);
  }

  async deployWorker(workerName: string, request: DeployWorkerRequest): Promise<void> {
    this.deployCalls += 1;
    this.lastDeployRequest = request;
    if (this.failDeploy) {
      throw new ApiError(500, `deploy ${workerName} failed`, `/workers/scripts/${workerName}`);
    }
    if (this.lieDeploy) {
      return; // "success" without creating the worker
    }
    this.workers.add(workerName);
  }
}
