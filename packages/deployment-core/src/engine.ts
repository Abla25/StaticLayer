import {
  EngineError,
  type Action,
  type CliConfig,
  type CloudflareApi,
  type DesiredState,
  type ObservedState,
  type WorkerBinding,
  type WorkerMetadata,
} from './types.ts';

/**
 * Desired State Engine (@staticlayer/deployment-core).
 *
 * Strictly follows Observe → Diff → Plan → Apply → Verify:
 *   1. Observe: read the CURRENT state from the Cloudflare API (D1 databases,
 *      worker existence, bound secrets).
 *   2. Diff: compare against the DESIRED state (config + resolved worker code
 *      + secret values) and produce an action plan.
 *   3. Plan: the action list is the plan (printed before applying).
 *   4. Apply: executes the plan in dependency order (D1 → worker → secrets),
 *      exactly once per action (idempotent by construction). All secret values
 *      are pushed in a SINGLE Bulk Secrets API call — values never leave
 *      server memory except inside the PATCH body.
 *   5. Verify: re-observes and re-diffs; if ANY action is still pending, it
 *      THROWS — the engine never fails silently.
 *
 * Library-first (Phase 4 audit): no process.exit, no prompts, no console.
 */

export async function observe(api: CloudflareApi, desired: CliConfig): Promise<ObservedState> {
  const databases = await api.listDatabases();
  const { exists } = await api.getWorker(desired.workerName);
  const secrets = exists ? (await api.listSecrets(desired.workerName)).map((s) => s.name) : [];
  return { databases, workerExists: exists, secrets };
}

export function diff(desired: CliConfig, observed: ObservedState, force = false): Action[] {
  const actions: Action[] = [];
  if (desired.d1 && !observed.databases.some((d) => d.name === desired.d1!.databaseName)) {
    actions.push({ kind: 'create-d1', databaseName: desired.d1.databaseName });
  }
  if (!observed.workerExists) {
    actions.push({ kind: 'deploy-worker', workerName: desired.workerName, reason: 'missing' });
  } else if (force) {
    actions.push({ kind: 'deploy-worker', workerName: desired.workerName, reason: 'forced' });
  }
  for (const secretName of desired.secrets) {
    if (!observed.secrets.includes(secretName)) {
      actions.push({ kind: 'set-secret', workerName: desired.workerName, secretName });
    }
  }
  return actions;
}

export function describeActions(actions: Action[]): string[] {
  return actions.map((a) => {
    switch (a.kind) {
      case 'create-d1':
        return `Create D1 database "${a.databaseName}"`;
      case 'deploy-worker':
        return `Deploy Worker "${a.workerName}" (${a.reason === 'forced' ? 'forced re-deploy' : 'missing'})`;
      case 'set-secret':
        return `Bind secret "${a.secretName}" to "${a.workerName}"`;
    }
  });
}

export function buildMetadata(desired: CliConfig, d1Id: string | undefined): WorkerMetadata {
  const bindings: WorkerBinding[] = [];
  if (desired.d1) {
    if (!d1Id) {
      throw new EngineError(
        `cannot build metadata: D1 binding "${desired.d1.binding}" needs database "${desired.d1.databaseName}" but no id is available`,
      );
    }
    bindings.push({ type: 'd1', name: desired.d1.binding, id: d1Id });
  }
  if (desired.ratelimit) {
    bindings.push({
      type: 'ratelimit',
      name: desired.ratelimit.binding,
      namespace_id: desired.ratelimit.namespaceId,
      simple: desired.ratelimit.simple,
    });
  }
  for (const [name, value] of Object.entries(desired.vars)) {
    if (typeof value === 'string') bindings.push({ type: 'plain_text', name, text: value });
    else bindings.push({ type: 'json', name, value });
  }
  return {
    main_module: 'worker.js',
    compatibility_date: desired.compatibilityDate,
    bindings,
    triggers: { crons: desired.crons },
    // Publish on *.workers.dev — without this flag, API-deployed workers are
    // not reachable on their workers.dev URL (they return "nothing here").
    workers_dev: true,
  };
}

export async function apply(
  api: CloudflareApi,
  desired: DesiredState,
  observed: ObservedState,
  actions: Action[],
): Promise<void> {
  let d1Id: string | undefined;
  if (desired.d1) {
    d1Id = observed.databases.find((d) => d.name === desired.d1!.databaseName)?.id;
  }

  // Collect secret values to push in ONE Bulk Secrets API call after the
  // worker exists (dependencies: D1 → worker → secrets).
  const secretValues: Record<string, string> = {};

  for (const action of actions) {
    switch (action.kind) {
      case 'create-d1': {
        const created = await api.createDatabase(action.databaseName);
        d1Id = created.id;
        break;
      }
      case 'deploy-worker': {
        await api.deployWorker(action.workerName, {
          code: desired.workerCode,
          mainModule: 'worker.js',
          metadata: buildMetadata(desired, d1Id),
        });
        break;
      }
      case 'set-secret': {
        secretValues[action.secretName] = desired.secretValues[action.secretName]!;
        break;
      }
    }
  }

  const secretNames = Object.keys(secretValues);
  if (secretNames.length > 0) {
    await api.setSecretsBulk(desired.workerName, secretValues);
  }
}

/**
 * Verify: re-observe and re-diff. Throws when any action is still pending —
 * this is the check that catches "the API said success but nothing happened".
 */
export async function verify(
  api: CloudflareApi,
  desired: CliConfig,
): Promise<{ observed: ObservedState; actions: Action[] }> {
  const observed = await observe(api, desired);
  const actions = diff(desired, observed, false);
  if (actions.length > 0) {
    throw new EngineError(
      `verify failed: desired state not reached — ${describeActions(actions).join('; ')}`,
    );
  }
  return { observed, actions };
}

export interface RunOptions {
  /** Force a worker re-deploy even if the worker already exists (repair). */
  force?: boolean;
  /** Observe + diff + print plan only; never apply. */
  dryRun?: boolean;
}

export interface RunResult {
  observed: ObservedState;
  actions: Action[];
}

export async function runEngine(
  api: CloudflareApi,
  desired: DesiredState,
  options: RunOptions = {},
): Promise<RunResult> {
  const observed = await observe(api, desired);
  const actions = diff(desired, observed, options.force ?? false);

  if (options.dryRun) {
    return { observed, actions };
  }

  if (actions.length > 0) {
    // Validate everything BEFORE touching the API: a missing secret value or
    // missing worker code must abort with zero side effects (no partial apply).
    const missingSecrets = actions.filter(
      (a): a is Extract<Action, { kind: 'set-secret' }> =>
        a.kind === 'set-secret' && desired.secretValues[a.secretName] === undefined,
    );
    if (missingSecrets.length > 0) {
      const names = missingSecrets.map((a) => a.secretName).join(', ');
      throw new EngineError(
        `missing value for secret(s): ${names} — set env STATICLAYER_${names.split(', ').join(' / STATICLAYER_')} or provide a value; aborting before any apply`,
      );
    }
    if (!desired.workerCode || desired.workerCode.length === 0) {
      throw new EngineError('workerCode is empty — set config.workerEntry or config.workerBundle; aborting before any apply');
    }
    await apply(api, desired, observed, actions);
  }

  // Never fail silently: after apply, the state must match the desired state.
  await verify(api, desired);

  return { observed, actions };
}
