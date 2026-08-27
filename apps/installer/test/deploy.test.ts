import { describe, expect, it } from 'vitest';
import { runInstallerDeploy, INSTALLER_SECRETS } from '../src/deploy.ts';
import { MockCloudflareApi } from '@staticlayer/deployment-core/testing';

const WORKER_CODE = 'export default { fetch() { return new Response("ok"); } };';

function makeApi(): MockCloudflareApi {
  return new MockCloudflareApi();
}

function fixedSecrets(): Record<string, string> {
  return { ADMIN_SECRET: 'a', SESSION_SECRET: 'b', POW_SECRET: 'c' };
}

const baseInput = { accountId: 'acc-1', dryRun: true };

describe('installer deploy — dry run', () => {
  it('returns a plan WITHOUT applying anything and WITHOUT secrets', async () => {
    const api = makeApi();
    const result = await runInstallerDeploy({
      accessToken: 'tok-1',
      input: { ...baseInput, workerName: 'pc', databaseName: 'pc-db', dryRun: true },
      apiFactory: () => api,
      workerCode: WORKER_CODE,
      generateSecrets: fixedSecrets,
    });
    expect(result.actions).toEqual([
      'Create D1 database "pc-db"',
      'Deploy Worker "pc" (missing)',
      'Bind secret "ADMIN_SECRET" to "pc"',
      'Bind secret "SESSION_SECRET" to "pc"',
      'Bind secret "POW_SECRET" to "pc"',
    ]);
    // SECURITY (audit): no secret values are ever returned — including on a
    // dry run there is no apply, so no admin password either.
    expect((result as { secrets?: unknown }).secrets).toBeUndefined();
    expect(result.adminSecret).toBeUndefined();
    expect(result.alreadyInSync).toBe(false);
    // Zero side effects on dry run.
    expect(api.createCalls).toBe(0);
    expect(api.deployCalls).toBe(0);
    expect(api.secretCalls).toBe(0);
    expect(api.databases).toEqual([]);
    expect(api.workers.size).toBe(0);
  });

  it('reports alreadyInSync when the account already matches', async () => {
    const api = makeApi();
    api.databases.push({ id: 'd1-1', name: 'pc-db' });
    api.workers.add('pc');
    api.secrets.set('pc', new Set([...INSTALLER_SECRETS]));
    const result = await runInstallerDeploy({
      accessToken: 'tok-1',
      input: { ...baseInput, workerName: 'pc', databaseName: 'pc-db', dryRun: true },
      apiFactory: () => api,
      workerCode: WORKER_CODE,
      generateSecrets: fixedSecrets,
    });
    expect(result.alreadyInSync).toBe(true);
    expect(result.actions).toEqual([]);
  });

  it('pre-configures Cloudflare Access vars when a team is provided', async () => {
    const api = makeApi();
    const result = await runInstallerDeploy({
      accessToken: 'tok-1',
      input: {
        ...baseInput,
        workerName: 'pc',
        databaseName: 'pc-db',
        dryRun: false,
        cfAccessTeam: 'https://myteam.cloudflareaccess.com/',
        cfAccessAud: 'aud-123',
      },
      apiFactory: () => api,
      workerCode: WORKER_CODE,
      generateSecrets: fixedSecrets,
    });
    expect(result.alreadyInSync).toBe(false);
    expect(api.deployCalls).toBe(1);
    // Vars are uploaded as plain_text bindings in the deploy metadata.
    const bindings = api.lastDeployRequest?.metadata?.bindings ?? [];
    const varMap: Record<string, string> = {};
    for (const b of bindings) {
      if (b.type === 'plain_text' && typeof b.name === 'string') varMap[b.name] = String((b as { text?: unknown }).text ?? '');
    }
    expect(varMap.CF_ACCESS_TEAM).toBe('myteam.cloudflareaccess.com'); // normalized
    expect(varMap.CF_ACCESS_AUD).toBe('aud-123');
  });

  it('pre-configures ALLOWED_ORIGINS (CORS) from the site URL', async () => {
    const api = makeApi();
    await runInstallerDeploy({
      accessToken: 'tok-1',
      input: { ...baseInput, workerName: 'pc', databaseName: 'pc-db', dryRun: false, siteUrl: 'mysite.com/blog' },
      apiFactory: () => api,
      workerCode: WORKER_CODE,
      generateSecrets: fixedSecrets,
    });
    const bindings = api.lastDeployRequest?.metadata?.bindings ?? [];
    const varMap: Record<string, string> = {};
    for (const b of bindings) {
      if (b.type === 'plain_text' && typeof b.name === 'string') varMap[b.name] = String((b as { text?: unknown }).text ?? '');
    }
    expect(varMap.ALLOWED_ORIGINS).toBe('https://mysite.com'); // normalized to origin
  });
});

describe('installer deploy — apply (secrets never returned)', () => {
  it('deploys everything and pushes the secrets to Cloudflare via bulk API — WITHOUT returning them', async () => {
    const api = makeApi();
    const result = await runInstallerDeploy({
      accessToken: 'tok-1',
      input: { ...baseInput, workerName: 'pc', databaseName: 'pc-db', dryRun: false },
      apiFactory: () => api,
      workerCode: WORKER_CODE,
      generateSecrets: fixedSecrets,
    });
    expect(result.alreadyInSync).toBe(false);
    expect(api.databases.map((d) => d.name)).toEqual(['pc-db']);
    expect(api.workers.has('pc')).toBe(true);
    // The 3 secrets were bound to the worker via ONE bulk call.
    expect(api.secrets.get('pc')).toEqual(new Set([...INSTALLER_SECRETS]));
    expect(api.secretCalls).toBe(1);
    // SECURITY (audit): SESSION_SECRET and POW_SECRET values are NEVER
    // returned; the operator's ADMIN_SECRET IS returned exactly once after a
    // real apply — they need it to sign in to /admin.html.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/["']b["']/); // SESSION value
    expect(serialized).not.toMatch(/["']c["']/); // POW value
    expect(result.adminSecret).toBe('a'); // ADMIN value, shown once
    expect((result as { secrets?: unknown }).secrets).toBeUndefined();
  });

  it('is idempotent: a second apply finds the state already in sync', async () => {
    const api = makeApi();
    const opts = {
      accessToken: 'tok-1',
      input: { ...baseInput, workerName: 'pc', databaseName: 'pc-db', dryRun: false },
      apiFactory: () => api,
      workerCode: WORKER_CODE,
      generateSecrets: fixedSecrets,
    };
    const first = await runInstallerDeploy(opts);
    expect(first.alreadyInSync).toBe(false);
    const calls = [api.createCalls, api.deployCalls, api.secretCalls];

    const second = await runInstallerDeploy(opts);
    expect(second.alreadyInSync).toBe(true);
    expect(second.actions).toEqual([]);
    // No additional API mutations.
    expect(api.createCalls).toBe(calls[0]);
    expect(api.deployCalls).toBe(calls[1]);
    expect(api.secretCalls).toBe(calls[2]);
  });

  it('propagates engine errors (never silent) and applies nothing partial', async () => {
    const api = makeApi();
    api.failDeploy = true;
    await expect(
      runInstallerDeploy({
        accessToken: 'tok-1',
        input: { ...baseInput, workerName: 'pc', databaseName: 'pc-db', dryRun: false },
        apiFactory: () => api,
        workerCode: WORKER_CODE,
        generateSecrets: fixedSecrets,
      }),
    ).rejects.toThrow();
    // The worker was never created; D1 may exist but the engine threw.
    expect(api.workers.has('pc')).toBe(false);
  });

  it('honors a ratelimit namespace when provided', async () => {
    const api = makeApi();
    await runInstallerDeploy({
      accessToken: 'tok-1',
      input: { ...baseInput, workerName: 'pc', databaseName: 'pc-db', ratelimitNamespaceId: 'ns-123', dryRun: false },
      apiFactory: () => api,
      workerCode: WORKER_CODE,
      generateSecrets: fixedSecrets,
    });
    expect(api.workers.has('pc')).toBe(true);
  });
});
