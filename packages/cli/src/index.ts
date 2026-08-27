import { CloudflareApiClient } from '@staticlayer/deployment-core/api';
import { loadWorkerCode } from '@staticlayer/deployment-core/build-worker';
import { describeActions, diff, observe, runEngine } from '@staticlayer/deployment-core/engine';
import type { CliConfig, CloudflareApi, DesiredState } from '@staticlayer/deployment-core/types';
import {
  CONFIG_FILE,
  gatherSecretValuesFromEnv,
  loadConfig,
  saveConfig,
} from './config.ts';
import { confirm, promptHidden, promptText } from './prompts.ts';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * StaticLayer CLI — `staticlayer init|status|repair`.
 *
 * The Desired State Engine (observe/diff/plan/apply/verify) never fails
 * silently: any Cloudflare API error is reported with its exact status and
 * stops the run.
 */

const DEFAULT_SECRETS = ['ADMIN_SECRET', 'SESSION_SECRET', 'POW_SECRET'];
const DEFAULT_VARS = {
  POW_DIFFICULTY: 16,
  CHALLENGE_TTL_SECONDS: 300,
  SESSION_TTL_SECONDS: 7200,
  MAX_REQUEST_BYTES: 65536,
  // Comma-separated list of origins allowed to call the API cross-origin.
  // Empty = same-origin only (fail-closed). Example: "https://mysite.example".
  ALLOWED_ORIGINS: '',
};

function log(message: string): void {
  console.log(`[staticlayer] ${message}`);
}

function apiFromConfig(cfg: CliConfig): CloudflareApi {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? cfg.apiToken;
  if (!token) {
    throw new Error(
      'missing Cloudflare API token: set the CLOUDFLARE_API_TOKEN env var (or config.apiToken)',
    );
  }
  return new CloudflareApiClient({ accountId: cfg.accountId, apiToken: token });
}

async function gatherSecretValues(cfg: CliConfig): Promise<Record<string, string>> {
  const values = gatherSecretValuesFromEnv(cfg);
  for (const name of cfg.secrets) {
    if (!values[name]) {
      values[name] = await promptHidden(`Value for secret ${name} (STATICLAYER_${name} env also works)`);
    }
  }
  return values;
}

async function desiredState(cfg: CliConfig): Promise<DesiredState> {
  const workerCode = await loadWorkerCode(cfg);
  const secretValues = await gatherSecretValues(cfg);
  return { ...cfg, workerCode, secretValues };
}

async function cmdInit(): Promise<void> {
  let cfg: CliConfig;
  const configPath = resolve(CONFIG_FILE);
  if (existsSync(configPath)) {
    cfg = loadConfig();
    log(`Reusing existing ${CONFIG_FILE}.`);
  } else {
    const accountId = await promptText('Cloudflare account ID', '');
    const apiToken = await promptHidden('Cloudflare API token (kept in memory, not written to disk)');
    const workerName = await promptText('Worker name', 'staticlayer');
    const databaseName = await promptText('D1 database name', 'staticlayer');
    const useSecrets = await confirm(
      `Bind the 3 secrets (${DEFAULT_SECRETS.join(', ')})? Values will be prompted or read from env STATICLAYER_*`,
      true,
    );
    cfg = {
      accountId,
      apiToken: apiToken.length > 0 ? apiToken : undefined,
      workerName,
      compatibilityDate: '2026-08-26',
      crons: ['0 3 * * *'],
      vars: { ...DEFAULT_VARS },
      d1: { binding: 'DB', databaseName },
      ratelimit: { binding: 'RATE_LIMITER', namespaceId: '1001', simple: { limit: 60, period: 60 } },
      secrets: useSecrets ? [...DEFAULT_SECRETS] : [],
      workerEntry: 'packages/runtime/src/index.ts',
    };
    const written = saveConfig(cfg);
    log(`Wrote ${written}. Edit it, then re-run "staticlayer status".`);
  }

  const api = apiFromConfig(cfg);
  const state = await desiredState(cfg);

  log('Observing current state…');
  const result = await runEngine(api, state, {});
  if (result.actions.length === 0) {
    log('Already in sync — nothing to do.');
  } else {
    for (const line of describeActions(result.actions)) log(`→ ${line}`);
  }
  log('✔ init complete — desired state verified.');
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  const api = apiFromConfig(cfg);

  log('Observing current state…');
  const observed = await observe(api, cfg);
  const actions = diff(cfg, observed, false);

  const dbFound = observed.databases.find((d) => d.name === cfg.d1.databaseName);
  log(`D1 database "${cfg.d1.databaseName}": ${dbFound ? 'present' : 'MISSING'}`);
  log(`Worker "${cfg.workerName}": ${observed.workerExists ? 'present' : 'MISSING'}`);
  for (const name of cfg.secrets) {
    log(`Secret "${name}": ${observed.secrets.includes(name) ? 'present' : 'MISSING'}`);
  }
  if (actions.length > 0) {
    log('Drift detected — plan:');
    for (const line of describeActions(actions)) log(`  - ${line}`);
    log('Run "staticlayer repair" to converge.');
    process.exitCode = 1;
  } else {
    log('✔ State matches the desired state.');
  }
}

async function cmdRepair(): Promise<void> {
  const cfg = loadConfig();
  const api = apiFromConfig(cfg);
  const state = await desiredState(cfg);

  log('Repairing: forcing apply + verify…');
  const result = await runEngine(api, state, { force: true });
  for (const line of describeActions(result.actions)) log(`→ ${line}`);
  log('✔ repair complete — desired state verified.');
}

async function cmdHelp(): Promise<void> {
  console.log(
    [
      'StaticLayer CLI — Desired State Engine for Cloudflare Worker + D1.',
      '',
      'Usage:',
      '  staticlayer init     Observe → Diff → Plan → Apply → Verify a new install.',
      '  staticlayer status   Show current vs desired state (exit 1 on drift).',
      '  staticlayer repair   Force apply + verify to fix configuration drift.',
      '  staticlayer help     Show this help.',
      '',
      'Config: staticlayer.config.json (secrets values via env STATICLAYER_* or prompts).',
      'API token: CLOUDFLARE_API_TOKEN env var or config.apiToken.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  switch (command) {
    case 'init':
      await cmdInit();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'repair':
      await cmdRepair();
      break;
    case 'help':
    case '--help':
    case '-h':
      await cmdHelp();
      break;
    default:
      throw new Error(`unknown command "${command}" — use init, status, repair or help`);
  }
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
