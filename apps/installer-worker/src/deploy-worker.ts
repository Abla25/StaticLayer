/**
 * Hosted installer deploy — same Desired State Engine as the node installer,
 * but with the runtime worker code PRE-BUNDLED (no esbuild at runtime) and
 * secrets generated with the Web Crypto API. Library-first: no process.exit,
 * no prompts, no console output of secret material.
 */

import { CloudflareApiClient } from '@staticlayer/deployment-core/api';
import { describeActions, runEngine } from '@staticlayer/deployment-core/engine';
import type { CliConfig, DesiredState } from '@staticlayer/deployment-core/types';
import { RUNTIME_WORKER_CODE } from './runtime-bundle.ts';

export const INSTALLER_COMPATIBILITY_DATE = '2026-08-26';
export const INSTALLER_CRONS = ['0 3 * * *'];
export const INSTALLER_VARS = {
  POW_DIFFICULTY: 16,
  CHALLENGE_TTL_SECONDS: 300,
  SESSION_TTL_SECONDS: 7200,
  MAX_REQUEST_BYTES: 65536,
  // Comma-separated list of origins allowed to call the API cross-origin.
  // Empty = same-origin only (fail-closed). Set after install in the config.
  ALLOWED_ORIGINS: '',
} as const;
export const INSTALLER_SECRETS = ['ADMIN_SECRET', 'SESSION_SECRET', 'POW_SECRET'] as const;

export interface InstallerInput {
  accountId: string;
  workerName?: string;
  databaseName?: string;
  ratelimitNamespaceId?: string;
  dryRun: boolean;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function generateSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of INSTALLER_SECRETS) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    out[name] = bytesToBase64Url(bytes);
  }
  return out;
}

export interface InstallerDeployResult {
  actions: string[];
  alreadyInSync: boolean;
  /** The operator's admin password, returned exactly once after a real apply. */
  adminSecret?: string;
}

export async function runInstallerDeployWorker(options: {
  accessToken: string;
  input: InstallerInput;
}): Promise<InstallerDeployResult> {
  const workerName = options.input.workerName ?? 'staticlayer';
  const databaseName = options.input.databaseName ?? 'staticlayer';

  const config: CliConfig = {
    accountId: options.input.accountId,
    workerName,
    compatibilityDate: INSTALLER_COMPATIBILITY_DATE,
    crons: INSTALLER_CRONS,
    vars: { ...INSTALLER_VARS },
    d1: { binding: 'DB', databaseName },
    secrets: [...INSTALLER_SECRETS],
    workerEntry: 'packages/runtime/src/index.ts',
  };
  if (options.input.ratelimitNamespaceId) {
    config.ratelimit = {
      binding: 'RATE_LIMITER',
      namespaceId: options.input.ratelimitNamespaceId,
      simple: { limit: 60, period: 60 },
    };
  }

  // Secret values exist only in memory; on a dry-run we pass an empty map and
  // the engine never applies. They flow exclusively into the Bulk Secrets API.
  const secretValues = options.input.dryRun ? {} : generateSecrets();
  const desired: DesiredState = { ...config, workerCode: RUNTIME_WORKER_CODE, secretValues };

  const api = new CloudflareApiClient({ accountId: config.accountId, apiToken: options.accessToken });
  const result = await runEngine(api, desired, { dryRun: options.input.dryRun });

  return {
    actions: describeActions(result.actions),
    alreadyInSync: result.actions.length === 0,
    // The operator's own admin password: returned exactly once, after a real
    // (non-dry-run) deploy, so they can sign in to /admin.html and moderate.
    // It is never stored, never logged, and never sent anywhere except this
    // one response to the browser that ran the deploy. All other secrets stay
    // server-side and flow exclusively into the Bulk Secrets API.
    adminSecret: options.input.dryRun ? undefined : secretValues.ADMIN_SECRET,
  };
}
