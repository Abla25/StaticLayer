import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';

/**
 * Runs the real CloudflareApiClient inside workerd (Miniflare) with a mocked
 * outbound API, proving the "Illegal invocation: incorrect `this`" bug stays
 * fixed (see packages/deployment-core/src/api.ts constructor).
 */

const ENTRY = fileURLToPath(new URL('./api-client-workerd-entry.ts', import.meta.url));

async function buildBundle(): Promise<string> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const text = result.outputFiles?.[0]?.text;
  if (!text) throw new Error('no bundle output');
  return text;
}

describe('CloudflareApiClient inside workerd', () => {
  it('calls fetch with the correct receiver (no Illegal invocation)', async () => {
    const script = await buildBundle();
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            name: 'api-client',
            modules: true,
            script,
            compatibilityDate: '2026-08-26',
            outboundService: () =>
              new Response(JSON.stringify({ success: true, result: [{ uuid: 'd1-1', name: 'test' }] }), {
                headers: { 'content-type': 'application/json' },
              }),
          },
        ],
      }),
    );
    try {
      const res = await mf.dispatchFetch('http://x/');
      const data = (await res.json()) as { ok: boolean; dbs?: { id: string; name: string }[]; error?: string };
      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.dbs).toEqual([{ id: 'd1-1', name: 'test' }]);
    } finally {
      await mf.dispose();
    }
  });
});
