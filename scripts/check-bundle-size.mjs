#!/usr/bin/env node
/**
 * StaticLayer bundle-size validation (PUBLIC_RELEASE_AUDIT.md §5).
 *
 * Reads the built site assets and fails the build if any exceeds its budget.
 * Run after `npm run build:site`.
 *
 * Run:  node scripts/check-bundle-size.mjs
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'apps/site/dist/assets');

// bytes per file (soft budgets; adjust consciously, not casually)
// 2026-08-28: raised for the v1.8 polish — the hero widget grew into a
// carousel (comments/reactions/poll), the simulator gained modes + likes +
// a live poll, and global.css gained skeleton + poll bars + carousel styles.
const BUDGETS = {
  'main.js': 6 * 1024,
  'hero-widget.js': 20 * 1024,
  'simulator.js': 32 * 1024,
  'global.css': 72 * 1024,
};

let failed = false;

for (const [file, budget] of Object.entries(BUDGETS)) {
  const path = join(ASSETS, file);
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    console.error(`✗ ${file}: MISSING (expected in ${ASSETS})`);
    failed = true;
    continue;
  }
  const kb = (size / 1024).toFixed(1);
  if (size > budget) {
    console.error(`✗ ${file}: ${kb} KB exceeds budget ${(budget / 1024).toFixed(1)} KB`);
    failed = true;
  } else {
    console.log(`✓ ${file}: ${kb} KB (budget ${(budget / 1024).toFixed(1)} KB)`);
  }
}

// also list any unexpected extra bundles (keeps the manifest honest)
for (const f of readdirSync(ASSETS)) {
  if (!(f in BUDGETS) && (f.endsWith('.js') || f.endsWith('.css'))) {
    const kb = (statSync(join(ASSETS, f)).size / 1024).toFixed(1);
    console.log(`  (untracked asset: ${f} — ${kb} KB)`);
  }
}

if (failed) {
  console.error('\nBundle-size check FAILED.');
  process.exit(1);
}
console.log('\nBundle-size check passed.');
