import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import worker from '../../packages/runtime/src/index.ts';
import { USED_CHALLENGES_RETENTION_MS } from '../../packages/runtime/src/retention.ts';
import { SECRETS, spawnWorker } from './worker.ts';

/**
 * Retention (Phase 3): the real `scheduled` handler purges used_challenges
 * older than 24h. The handler is invoked directly against the Miniflare D1
 * (Miniflare does not dispatch cron events).
 */

const HOUR_MS = 60 * 60 * 1000;

async function seed(db: Awaited<ReturnType<Miniflare['getD1Database']>>, nowMs: number) {
  const nowSec = Math.floor(nowMs / 1000);
  const rows: Array<[string, number]> = [
    ['old-48h', Math.floor((nowMs - 48 * HOUR_MS) / 1000)],
    ['old-25h', Math.floor((nowMs - 25 * HOUR_MS) / 1000)],
    ['fresh-1h', Math.floor((nowMs - 1 * HOUR_MS) / 1000)],
  ];
  for (const [id, usedAt] of rows) {
    await db.prepare('INSERT INTO used_challenges (challenge_id, used_at) VALUES (?, ?)').bind(id, usedAt).run();
  }
  void nowSec;
}

describe('used_challenges retention (Phase 3)', () => {
  let mf: Miniflare | undefined;
  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it('the scheduled handler deletes rows older than 24h and keeps fresh ones', async () => {
    mf = await spawnWorker();
    const db = await mf.getD1Database('DB');
    const nowMs = Date.now();
    await seed(db, nowMs);

    // Invoke the REAL scheduled handler from the runtime bundle.
    const scheduled = worker.scheduled;
    expect(typeof scheduled).toBe('function');
    await scheduled!(
      {} as never,
      { ...SECRETS, DB: db } as never,
      {} as never,
    );

    const rows = await db.prepare('SELECT challenge_id FROM used_challenges ORDER BY challenge_id').all();
    expect(rows.results.map((r) => (r as { challenge_id: string }).challenge_id)).toEqual([
      'fresh-1h',
    ]);
  });

  it('USED_CHALLENGES_RETENTION_MS is exactly 24h', () => {
    expect(USED_CHALLENGES_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });
});
