import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CliConfig } from '@staticlayer/deployment-core/types';

export const CONFIG_FILE = 'staticlayer.config.json';

/** Load and validate staticlayer.config.json (the desired state). */
export function loadConfig(cwd = process.cwd()): CliConfig {
  const path = resolve(cwd, CONFIG_FILE);
  if (!existsSync(path)) {
    throw new Error(`config not found: ${path} — run "staticlayer init" first`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`invalid ${CONFIG_FILE}: ${(err as Error).message}`);
  }
  return validateConfig(raw);
}

export function validateConfig(raw: unknown): CliConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${CONFIG_FILE} must be a JSON object`);
  const c = raw as Record<string, unknown>;

  if (typeof c.accountId !== 'string' || c.accountId.length === 0) {
    throw new Error(`config.accountId (string) is required`);
  }
  if (typeof c.workerName !== 'string' || c.workerName.length === 0) {
    throw new Error(`config.workerName (string) is required`);
  }
  if (typeof c.compatibilityDate !== 'string' || c.compatibilityDate.length === 0) {
    throw new Error(`config.compatibilityDate (string) is required`);
  }
  if (!Array.isArray(c.crons)) throw new Error('config.crons (array) is required');
  if (typeof c.vars !== 'object' || c.vars === null || Array.isArray(c.vars)) {
    throw new Error('config.vars (object) is required');
  }
  const d1 = c.d1 as Record<string, unknown> | undefined;
  if (!d1 || typeof d1.binding !== 'string' || typeof d1.databaseName !== 'string') {
    throw new Error('config.d1 { binding, databaseName } is required');
  }
  if (!Array.isArray(c.secrets) || c.secrets.some((s) => typeof s !== 'string')) {
    throw new Error('config.secrets (array of string) is required');
  }

  const cfg: CliConfig = {
    accountId: c.accountId,
    apiToken: typeof c.apiToken === 'string' && c.apiToken.length > 0 ? c.apiToken : undefined,
    workerName: c.workerName,
    compatibilityDate: c.compatibilityDate,
    crons: c.crons.map(String),
    vars: { ...(c.vars as Record<string, unknown>) },
    d1: { binding: d1.binding, databaseName: d1.databaseName },
    secrets: c.secrets.map(String),
  };
  if (typeof c.workerEntry === 'string' && c.workerEntry.length > 0) cfg.workerEntry = c.workerEntry;
  if (typeof c.workerBundle === 'string' && c.workerBundle.length > 0) cfg.workerBundle = c.workerBundle;
  if (cfg.workerEntry && cfg.workerBundle) {
    throw new Error('config must set EITHER workerEntry OR workerBundle, not both');
  }

  const rl = c.ratelimit as Record<string, unknown> | undefined;
  if (rl !== undefined) {
    if (typeof rl.binding !== 'string' || typeof rl.namespaceId !== 'string') {
      throw new Error('config.ratelimit { binding, namespaceId, simple } is invalid');
    }
    const simple = rl.simple as Record<string, unknown> | undefined;
    if (!simple || typeof simple.limit !== 'number' || (simple.period !== 10 && simple.period !== 60)) {
      throw new Error('config.ratelimit.simple { limit, period: 10|60 } is invalid');
    }
    cfg.ratelimit = {
      binding: rl.binding,
      namespaceId: rl.namespaceId,
      simple: { limit: simple.limit, period: simple.period as 10 | 60 },
    };
  }
  return cfg;
}

export function saveConfig(cfg: CliConfig, cwd = process.cwd()): string {
  const path = resolve(cwd, CONFIG_FILE);
  // SECURITY (validation fix): NEVER persist the API token. The prompt already
  // says "kept in memory, not written to disk" — the token lives only in memory
  // (this run) or in CLOUDFLARE_API_TOKEN. Config on disk stores names only.
  const { apiToken: _omit, ...safe } = cfg;
  writeFileSync(path, JSON.stringify(safe, null, 2) + '\n', 'utf8');
  return path;
}

/**
 * Secret VALUES are never stored on disk. They come from the environment
 * (STATICLAYER_<SECRET_NAME>) or interactive prompts at apply time.
 */
export function gatherSecretValuesFromEnv(
  cfg: CliConfig,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of cfg.secrets) {
    const value = env[`STATICLAYER_${name}`];
    if (value) values[name] = value;
  }
  return values;
}
