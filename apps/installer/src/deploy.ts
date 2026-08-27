/**
 * StaticLayer Web Installer — deploy orchestration.
 *
 * Reuses the Desired State Engine from @staticlayer/deployment-core verbatim
 * (Observe → Diff → Plan → Apply → Verify, idempotent, never silent).
 * The only installer-specific logic is:
 *   - it builds the desired config from the wizard's inputs;
 *   - on a REAL apply it generates the 3 secrets server-side (CSPRNG, 32 bytes,
 *     base64url) and hands them ONLY to the engine, which pushes them straight
 *     to Cloudflare's **Workers Bulk Secrets API** (`PATCH /secrets-bulk`,
 *     verified 2026-08-26 — docs/cloudflare-assumptions.md §10);
 *   - the secret VALUES are NEVER returned to the caller, never logged and
 *     never shown to the user: the user only sees "Deploy Successful";
 *   - a dry-run returns the plan without secrets and without side effects.
 *
 * SECURITY (Phase 4 audit): this module has no `process.exit`, no prompts, no
 * console output of secret material. The only consumers of the generated
 * secrets are the in-memory DesiredState and the Cloudflare API request.
 */

import { randomBytes } from 'node:crypto';
import { CloudflareApiClient } from '@staticlayer/deployment-core/api';
import { loadWorkerCode } from '@staticlayer/deployment-core/build-worker';
import { describeActions, runEngine } from '@staticlayer/deployment-core/engine';
import type { CloudflareApi, CliConfig, DesiredState } from '@staticlayer/deployment-core/types';

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
  /** Optional Cloudflare Access team — enables "Sign in with Cloudflare" in the admin. */
  cfAccessTeam?: string;
  /** Optional Access Application AUID enforced in the JWT `aud` claim. */
  cfAccessAud?: string;
  /** Optional site URL — pre-configures ALLOWED_ORIGINS (CORS) for the widget. */
  siteUrl?: string;
  dryRun: boolean;
}

export interface InstallerDeployOptions {
  accessToken: string;
  input: InstallerInput;
  /** Injectable for tests. Defaults to the real CloudflareApiClient. */
  apiFactory?: (token: string) => CloudflareApi;
  /** Injectable for tests (avoids bundling the runtime). */
  workerCode?: string;
  /** Injectable for tests (deterministic secrets). */
  generateSecrets?: () => Record<string, string>;
  /** Injectable for tests. Defaults to repo-root runtime entry. */
  workerEntry?: string;
}

/**
 * Result of an installer deploy. SESSION_SECRET/POW_SECRET values are never
 * included: the secrets are generated server-side and pushed to Cloudflare.
 * The one exception is `adminSecret` — the operator's own admin password,
 * returned exactly once after a real (non-dry-run) apply so they can sign in
 * to /admin.html. It is never stored or logged.
 */
export interface InstallerDeployResult {
  actions: string[];
  alreadyInSync: boolean;
  adminSecret?: string;
}

export function generateSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of INSTALLER_SECRETS) {
    out[name] = randomBytes(32).toString('base64url');
  }
  return out;
}

/** Normalize a site URL to an origin for the CORS allowlist (e.g. https://x.com). */
export function normalizeSiteUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/\/$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export async function runInstallerDeploy(
  options: InstallerDeployOptions,
): Promise<InstallerDeployResult> {
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
    workerEntry: options.workerEntry ?? 'packages/runtime/src/index.ts',
  };
  // Guided Cloudflare Access: when the operator provides a team, pre-configure
  // the worker var so the admin login shows "Sign in with Cloudflare".
  const team = options.input.cfAccessTeam?.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (team) config.vars.CF_ACCESS_TEAM = team;
  const aud = options.input.cfAccessAud?.trim();
  if (aud) config.vars.CF_ACCESS_AUD = aud;
  // Site URL -> CORS allowlist so the widget can call this Worker from the site.
  const siteUrl = normalizeSiteUrl(options.input.siteUrl);
  if (siteUrl) config.vars.ALLOWED_ORIGINS = siteUrl;
  if (options.input.ratelimitNamespaceId) {
    config.ratelimit = {
      binding: 'RATE_LIMITER',
      namespaceId: options.input.ratelimitNamespaceId,
      simple: { limit: 60, period: 60 },
    };
  }

  const workerCode = options.workerCode ?? (await loadWorkerCode(config));
  // Secret values are created in server memory only. On a dry-run we pass an
  // empty map (the engine never applies). On a real apply the values flow
  // exclusively into the Bulk Secrets API request — never to the caller.
  const secretValues = options.input.dryRun ? {} : (options.generateSecrets ?? generateSecrets)();
  const desired: DesiredState = { ...config, workerCode, secretValues };

  const api =
    options.apiFactory?.(options.accessToken) ??
    new CloudflareApiClient({ accountId: config.accountId, apiToken: options.accessToken });

  const result = await runEngine(api, desired, {
    dryRun: options.input.dryRun,
    // On a real apply, force a worker re-deploy so code + vars + metadata
    // (e.g. workers_dev, ALLOWED_ORIGINS, CF_ACCESS_*) always match the latest
    // desired state. Secrets are preserved (the engine only sets missing ones).
    force: !options.input.dryRun,
  });

  // Only return the admin password when it was ACTUALLY applied (i.e. a
  // set-secret action ran). On an update/re-run the worker already has the
  // secrets, the engine skips them, and the newly generated value must NOT be
  // shown — the operator's existing password stays valid.
  const secretActuallyApplied = result.actions.some((a) => a.kind === 'set-secret');

  return {
    actions: describeActions(result.actions),
    alreadyInSync: result.actions.length === 0,
    // The operator's own admin password: returned exactly once, after a real
    // (non-dry-run) deploy, so they can sign in to /admin.html and moderate.
    // It is never stored, never logged, and never sent anywhere except this
    // one response to the browser that ran the deploy. All other secrets stay
    // server-side and flow exclusively into the Bulk Secrets API.
    adminSecret: options.input.dryRun || !secretActuallyApplied ? undefined : secretValues.ADMIN_SECRET,
  };
}
