import { build } from 'esbuild';

/**
 * Build the widget bundles for the browser.
 *   - dist/widget.js      : public widget (IIFE, classic script, auto-init)
 *   - dist/pow-worker.js  : PoW Web Worker (IIFE classic worker)
 *
 * Both bundle @staticlayer/protocol (Web Crypto only — no Node APIs), so the
 * exact same canonical encoding runs in the Worker, the browser and the tests.
 */
const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/widget.js'], outfile: 'dist/widget.js' });
await build({ ...common, entryPoints: ['src/pow-worker.js'], outfile: 'dist/pow-worker.js' });

console.log('widget bundles written to dist/');
