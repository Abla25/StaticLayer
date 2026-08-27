import { build } from 'esbuild';

/**
 * Bundle the CLI into a single executable ESM file with a shebang.
 * `esbuild` is kept external (it is a native-binary wrapper the CLI uses at
 * runtime to bundle the worker entry).
 */
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/cli.js',
  banner: { js: '#!/usr/bin/env node' },
  external: ['esbuild'],
  logLevel: 'info',
});

console.log('cli bundle written to dist/cli.js');
