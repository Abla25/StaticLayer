import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, validateConfig, CONFIG_FILE } from '../src/config.ts';
import type { CliConfig } from '@staticlayer/deployment-core/types';

function freshCfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    accountId: 'acc-1',
    apiToken: 'super-secret-token-123', // must NEVER be persisted
    workerName: 'staticlayer',
    compatibilityDate: '2026-08-26',
    crons: ['0 3 * * *'],
    vars: { POW_DIFFICULTY: 16 },
    d1: { binding: 'DB', databaseName: 'staticlayer' },
    secrets: ['ADMIN_SECRET', 'SESSION_SECRET', 'POW_SECRET'],
    workerEntry: 'packages/runtime/src/index.ts',
    ...overrides,
  };
}

describe('config persistence — SECURITY (apiToken never on disk)', () => {
  it('saveConfig writes the config WITHOUT the apiToken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-config-'));
    try {
      const path = saveConfig(freshCfg(), dir);
      const raw = readFileSync(path, 'utf8');
      expect(raw).not.toContain('super-secret-token-123');
      expect(raw).not.toContain('apiToken');
      expect(raw).toContain('"accountId": "acc-1"');
      expect(raw).toContain('"workerName": "staticlayer"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadConfig round-trips a config saved without the token (token via env only)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-config-'));
    try {
      saveConfig(freshCfg(), dir);
      const loaded = loadConfig(dir);
      expect(loaded.accountId).toBe('acc-1');
      expect(loaded.apiToken).toBeUndefined();
      expect(loaded.secrets).toEqual(['ADMIN_SECRET', 'SESSION_SECRET', 'POW_SECRET']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validateConfig keeps an apiToken only in memory (not part of the persisted contract)', () => {
    const cfg = validateConfig({ ...freshCfg() });
    expect(cfg.apiToken).toBe('super-secret-token-123'); // in-memory use is fine
    const dir = mkdtempSync(join(tmpdir(), 'pc-config-'));
    try {
      const path = saveConfig(cfg, dir);
      expect(readFileSync(path, 'utf8')).not.toContain('super-secret-token-123');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CONFIG_FILE is the documented filename', () => {
    expect(CONFIG_FILE).toBe('staticlayer.config.json');
  });
});
