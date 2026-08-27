import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Resolve the worker CODE for a deploy (@staticlayer/deployment-core):
 *   - config.workerBundle: read an already-bundled single-file ESM worker;
 *   - config.workerEntry:  bundle a TS/JS entry with esbuild (same settings as
 *                          the test harness / wrangler bundling).
 * Library-first: pure function of its input, no process.exit, no prompts.
 */
export async function loadWorkerCode(config: {
  workerEntry?: string;
  workerBundle?: string;
}): Promise<string> {
  if (config.workerBundle) {
    const path = resolve(config.workerBundle);
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(`cannot read workerBundle "${path}": ${(err as Error).message}`);
    }
  }
  if (config.workerEntry) {
    const entry = resolve(config.workerEntry);
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
    });
    const text = result.outputFiles?.[0]?.text;
    if (!text) throw new Error(`esbuild produced no output for worker entry "${entry}"`);
    return text;
  }
  throw new Error('config must set either "workerEntry" or "workerBundle"');
}
