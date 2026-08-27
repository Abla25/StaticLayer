#!/usr/bin/env node
/**
 * StaticLayer PoW benchmark.
 *
 * Measures how long the canonical Proof-of-Work takes on THIS machine across
 * a range of difficulties (expected solving time doubles every +1 bit).
 * Uses the real @staticlayer/protocol implementation.
 *
 * Run:  node scripts/pow-benchmark.mjs
 */
import { mineNonce, PROTOCOL_VERSION, randomBytes } from '@staticlayer/protocol';

const DIFFICULTIES = [10, 12, 14, 16, 18];
const ROUNDS = 3;

function base() {
  return {
    version: PROTOCOL_VERSION,
    hostContext: 'bench.local',
    articlePath: '/bench',
    nickname: 'bench',
    body: 'benchmark comment',
    challengeId: randomBytes(32),
  };
}

async function bench(difficulty) {
  const times = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const t0 = performance.now();
    await mineNonce(base(), difficulty);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    difficulty,
    medianMs: Math.round(times[Math.floor(times.length / 2)]),
    minMs: Math.round(times[0]),
    maxMs: Math.round(times[times.length - 1]),
  };
}

console.log('StaticLayer PoW benchmark');
console.log('Machine:', `${process.platform}/${process.arch}`);
console.log(`Node: ${process.version}`);
console.log(`Rounds per difficulty: ${ROUNDS}`);
console.log('---');
console.log('diff | median ms | min ms | max ms');
console.log('-----|-----------|--------|--------');

const rows = [];
for (const d of DIFFICULTIES) {
  const r = await bench(d);
  rows.push(r);
  console.log(
    String(r.difficulty).padStart(4),
    '|',
    String(r.medianMs).padStart(9),
    '|',
    String(r.minMs).padStart(6),
    '|',
    String(r.maxMs).padStart(6),
  );
}
console.log('---');
console.log(
  'Rule of thumb: +1 bit of difficulty ≈ doubles the expected solving time.',
);
