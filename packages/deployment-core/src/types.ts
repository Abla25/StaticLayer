/**
 * @staticlayer/deployment-core — shared types for the Desired State Engine.
 *
 * Library-first (Phase 4 audit): no process.exit, no prompts, no console
 * side effects. Consumed by both @staticlayer/cli and @staticlayer/installer.
 */

export interface D1Desired {
  binding: string;
  databaseName: string;
}

export interface RateLimitDesired {
  binding: string;
  namespaceId: string;
  simple: { limit: number; period: 10 | 60 };
}

/** The DESIRED STATE, minus secret values (values are never stored on disk). */
export interface CliConfig {
  accountId: string;
  /** Optional; the CLOUDFLARE_API_TOKEN env var takes precedence. */
  apiToken?: string;
  workerName: string;
  compatibilityDate: string;
  crons: string[];
  vars: Record<string, unknown>;
  d1: D1Desired;
  ratelimit?: RateLimitDesired;
  /** Secret NAMES that must be bound to the worker. Values never stored on disk. */
  secrets: string[];
  /** TS/JS entry point to bundle (relative to cwd) — or workerBundle instead. */
  workerEntry?: string;
  /** Path to an already-bundled single-file ESM worker — or workerEntry instead. */
  workerBundle?: string;
}

/** Full desired state fed to the engine (config + resolved code + secret values). */
export interface DesiredState extends CliConfig {
  workerCode: string;
  secretValues: Record<string, string>;
}

export interface D1Info {
  id: string;
  name: string;
}

export interface ObservedState {
  databases: D1Info[];
  workerExists: boolean;
  secrets: string[];
}

export type Action =
  | { kind: 'create-d1'; databaseName: string }
  | { kind: 'deploy-worker'; workerName: string; reason: 'missing' | 'forced' }
  | { kind: 'set-secret'; workerName: string; secretName: string };

export interface WorkerBinding {
  type: string;
  name: string;
  [key: string]: unknown;
}

export interface WorkerMetadata {
  main_module: string;
  compatibility_date: string;
  bindings: WorkerBinding[];
  triggers?: { crons: string[] };
  /** Expose the worker on its *.workers.dev URL (default true). */
  workers_dev?: boolean;
}

export interface DeployWorkerRequest {
  code: string;
  mainModule: string;
  metadata: WorkerMetadata;
}

/**
 * Minimal Cloudflare API surface used by the engine. Implemented by
 * `CloudflareApiClient` (real fetch) and `MockCloudflareApi` (tests).
 *
 * Secret values are pushed via the **Workers Bulk Secrets API**
 * (`PATCH /workers/scripts/{name}/secrets-bulk`, JSON Merge Patch, RFC 7396 —
 * verified 2026-08-26, see docs/cloudflare-assumptions.md §10). Values are
 * never returned by the engine and never logged.
 */
export interface CloudflareApi {
  listDatabases(): Promise<D1Info[]>;
  createDatabase(name: string): Promise<D1Info>;
  getWorker(name: string): Promise<{ exists: boolean }>;
  listSecrets(workerName: string): Promise<Array<{ name: string }>>;
  setSecretsBulk(workerName: string, values: Record<string, string>): Promise<void>;
  deployWorker(workerName: string, request: DeployWorkerRequest): Promise<void>;
}

/** A Cloudflare API call failed (HTTP/network/success:false). Never silent. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The desired state is not (or cannot be) reached. Never silent. */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}
