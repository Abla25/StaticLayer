// Builds the installer as a single self-contained Node ESM bundle.
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/server.js',
  banner: { js: '#!/usr/bin/env node' },
  external: ['esbuild'],
  sourcemap: false,
  logLevel: 'info',
});

// Copy public assets next to the bundle so the server can serve them.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/public', { recursive: true });
cpSync('public', 'dist/public', { recursive: true });
console.log('installer: dist/server.js + dist/public ready');
