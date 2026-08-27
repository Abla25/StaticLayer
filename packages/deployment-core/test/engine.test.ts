import { describe, expect, it } from 'vitest';
import { MockCloudflareApi } from '../src/mock-api.ts';
import { observe, diff, runEngine, verify } from '../src/engine.ts';
import type { DesiredState } from '../src/types.ts';

/**
 * Mandatory engine tests (SECURITY_REVIEW.md §13):
 *   1. Idempotency — running init twice creates no duplicates and never fails.
 *   2. Repair — a missing D1/worker is detected and recreated.
 *   3. Verify failure — if a create API returns success but nothing persists,
 *      verify detects the discrepancy and raises.
 * Plus: API failures are never silent; missing secret values abort with zero
 * side effects. Secrets are pushed in ONE bulk call (`secretCalls`).
 */

const DUMMY_CODE = 'export default { async fetch() { return new Response("ok"); } };';

function freshDesired(): DesiredState {
  return {
    accountId: 'acc1',
    workerName: 'staticlayer',
    compatibilityDate: '2026-08-26',
    crons: ['0 3 * * *'],
    vars: { POW_DIFFICULTY: 16, CHALLENGE_TTL_SECONDS: 300 },
    d1: { binding: 'DB', databaseName: 'staticlayer' },
    ratelimit: { binding: 'RATE_LIMITER', namespaceId: '1001', simple: { limit: 60, period: 60 } },
    secrets: ['ADMIN_SECRET', 'SESSION_SECRET', 'POW_SECRET'],
    workerCode: DUMMY_CODE,
    secretValues: { ADMIN_SECRET: 'a-secret', SESSION_SECRET: 'b-secret', POW_SECRET: 'c-secret' },
  };
}

describe('Desired State Engine', () => {
  it('1) init is idempotent: running twice creates no duplicates and does not fail', async () => {
    const api = new MockCloudflareApi();

    const first = await runEngine(api, freshDesired(), {});
    expect(first.actions.map((a) => a.kind)).toEqual([
      'create-d1',
      'deploy-worker',
      'set-secret',
      'set-secret',
      'set-secret',
    ]);
    expect(api.createCalls).toBe(1);
    expect(api.deployCalls).toBe(1);
    expect(api.secretCalls).toBe(1); // ONE bulk call for all 3 secrets

    // Second run: everything already in sync.
    const second = await runEngine(api, freshDesired(), {});
    expect(second.actions).toHaveLength(0);
    expect(api.createCalls).toBe(1); // no duplicate D1
    expect(api.deployCalls).toBe(1); // no duplicate worker
    expect(api.secretCalls).toBe(1);
    expect(api.databases.filter((d) => d.name === 'staticlayer')).toHaveLength(1);
    expect(api.workers.has('staticlayer')).toBe(true);
    expect(api.secrets.get('staticlayer')).toEqual(new Set(['ADMIN_SECRET', 'SESSION_SECRET', 'POW_SECRET']));
  });

  it('2) repair detects a missing D1 and recreates it', async () => {
    const api = new MockCloudflareApi();
    api.workers.add('staticlayer');
    api.secrets.set('staticlayer', new Set(['ADMIN_SECRET', 'SESSION_SECRET', 'POW_SECRET']));

    // status-like check first: D1 is missing
    const observed = await observe(api, freshDesired());
    const before = diff(freshDesired(), observed, false);
    expect(before.map((a) => a.kind)).toContain('create-d1');

    await runEngine(api, freshDesired(), { force: true }); // repair
    expect(api.databases.some((d) => d.name === 'staticlayer')).toBe(true);
  });

  it('2b) repair recreates a missing worker', async () => {
    const api = new MockCloudflareApi();
    api.databases.push({ id: 'd1-1', name: 'staticlayer' });
    api.secrets.set('staticlayer', new Set(['ADMIN_SECRET', 'SESSION_SECRET', 'POW_SECRET']));

    await runEngine(api, freshDesired(), { force: true });
    expect(api.workers.has('staticlayer')).toBe(true);
  });

  it('3) verify catches an API that returns success for create-d1 but persists nothing', async () => {
    const api = new MockCloudflareApi();
    api.lieCreateDatabase = true;

    await expect(runEngine(api, freshDesired(), {})).rejects.toThrow(/verify failed.*Create D1 database "staticlayer"/);
  });

  it('3b) verify catches an API that returns success for deploy but creates no worker', async () => {
    const api = new MockCloudflareApi();
    api.lieDeploy = true;

    await expect(runEngine(api, freshDesired(), {})).rejects.toThrow(/verify failed.*Deploy Worker "staticlayer"/);
  });

  it('4) API failures are never silent: exact error propagates and aborts', async () => {
    const api = new MockCloudflareApi();
    api.failCreateDatabase = true;

    await expect(runEngine(api, freshDesired(), {})).rejects.toThrow(/create database staticlayer failed/);
  });

  it('5) a missing secret value aborts BEFORE any apply (zero side effects)', async () => {
    const api = new MockCloudflareApi();
    const desired = freshDesired();
    delete desired.secretValues['POW_SECRET'];

    await expect(runEngine(api, desired, {})).rejects.toThrow(/missing value for secret\(s\): POW_SECRET/);
    expect(api.createCalls).toBe(0);
    expect(api.deployCalls).toBe(0);
    expect(api.secretCalls).toBe(0);
  });

  it('6) dryRun only observes and plans, never applies', async () => {
    const api = new MockCloudflareApi();
    const result = await runEngine(api, freshDesired(), { dryRun: true });
    expect(result.actions.length).toBeGreaterThan(0);
    expect(api.createCalls).toBe(0);
    expect(api.deployCalls).toBe(0);
    expect(api.secretCalls).toBe(0);
  });

  it('7) verify returns cleanly when in sync', async () => {
    const api = new MockCloudflareApi();
    await runEngine(api, freshDesired(), {});
    const { actions } = await verify(api, freshDesired());
    expect(actions).toHaveLength(0);
  });
});
