import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { spawnWorker } from './worker.ts';

/**
 * Round 21.11 — D1 schema bootstrap.
 *
 * The installers create the D1 database and bind it as `DB` but cannot run
 * `wrangler d1 migrations apply` on the customer account. Regression test:
 * with a completely EMPTY database (no tables — exactly what a fresh
 * installer deploy produces), DB-backed API endpoints must lazily apply the
 * schema and answer JSON, NOT crash with the Cloudflare HTML 500 page that
 * the admin UI used to render as "Unexpected token '<'".
 */

describe('D1 schema bootstrap (installer gap)', () => {
  let mf: Miniflare | undefined;
  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it('auto-migrates an empty database before serving a DB-backed API call', async () => {
    mf = await spawnWorker({ skipMigrations: true });
    const db = await mf.getD1Database('DB');

    // Prove the database really is empty before any API call.
    const before = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='comments'")
      .first();
    expect(before).toBeNull();

    // First DB-backed call triggers the lazy bootstrap and answers JSON
    // (401: no admin session), never an HTML error page.
    const res = await mf.dispatchFetch('https://staticlayer.test/api/admin/comments?status=pending');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'unauthorized' });

    // The tables now exist (spot-check the ones the queue queries hit).
    for (const table of ['comments', 'reactions', 'settings', 'moderation_lists', 'blocked_terms', 'used_challenges', 'polls', 'poll_votes']) {
      const row = await db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .bind(table)
        .first();
      expect(row, `table ${table} should exist after bootstrap`).toBeTruthy();
    }
  });

  it('health stays JSON even on an empty database (no DB dependency)', async () => {
    mf = await spawnWorker({ skipMigrations: true });
    const res = await mf.dispatchFetch('https://staticlayer.test/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { schemaVersion: number };
    expect(body.schemaVersion).toBe(7);
  });

  it('bootstrap is idempotent across repeated calls', async () => {
    mf = await spawnWorker({ skipMigrations: true });
    const db = await mf.getD1Database('DB');

    for (let i = 0; i < 3; i += 1) {
      const res = await mf.dispatchFetch('https://staticlayer.test/api/admin/comments?status=pending');
      expect(res.status).toBe(401);
    }
    // Re-applying must not have duplicated anything or failed.
    const count = await db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='comments'")
      .first<{ c: number }>();
    expect(count?.c).toBe(1);
  });
});
