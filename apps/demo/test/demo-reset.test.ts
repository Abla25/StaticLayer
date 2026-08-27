import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { D1Database } from '@cloudflare/workers-types';
import { DEMO_WELCOME, demoDailyReset } from '../src/demo-reset.ts';

// No `new URL(...)` here: in this project `URL` is the workers-types global,
// not node:url.URL — so build the path from plain strings instead.
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

/** Self-contained: applies the repo's real migrations/*.sql (same logic as tests/security/worker.ts). */
async function applyMigrations(db: D1Database): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .replace(/\s+/g, ' ')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const statement of statements) {
      await db.exec(statement);
    }
  }
}

let mf: Miniflare;
let db: D1Database;

beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'demo-test',
          modules: true,
          script: 'export default { fetch() { return new Response("ok"); } };',
          d1Databases: { DB: 'demo-db' },
        },
      ],
    }),
  );
  db = await mf.getD1Database('DB');
  await applyMigrations(db);
});

afterEach(async () => {
  await mf.dispose();
});

async function seedComment(id: string, status: string, articlePath = '/demo', createdAt = 1): Promise<void> {
  await db
    .prepare(
      'INSERT INTO comments (id, article_path, nickname, body, status, created_at, challenge_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, articlePath, 'nick', 'body-' + id, status, createdAt, 'ch-' + id)
    .run();
}

describe('demo daily purge', () => {
  it('deletes ALL comments (any status) except the welcome one', async () => {
    await seedComment('c1', 'approved');
    await seedComment('c2', 'pending');
    await seedComment('c3', 'approved', '/other', 5);
    await seedComment(DEMO_WELCOME.id, DEMO_WELCOME.status);

    const { deleted, welcomePresent } = await demoDailyReset(db);
    expect(deleted).toBe(3);
    expect(welcomePresent).toBe(true);

    const rows = await db.prepare('SELECT id FROM comments ORDER BY id').all();
    expect(rows.results.map((r) => r.id)).toEqual([DEMO_WELCOME.id]);
  });

  it('re-inserts the welcome comment when it was deleted', async () => {
    await seedComment('c1', 'approved');
    const { deleted, welcomePresent } = await demoDailyReset(db);
    expect(deleted).toBe(1);
    expect(welcomePresent).toBe(true);

    const welcome = await db.prepare('SELECT * FROM comments WHERE id = ?').bind(DEMO_WELCOME.id).first();
    expect(welcome).toMatchObject({
      id: DEMO_WELCOME.id,
      article_path: DEMO_WELCOME.articlePath,
      nickname: DEMO_WELCOME.nickname,
      body: DEMO_WELCOME.body,
      status: 'approved',
    });
  });

  it('is idempotent: running twice keeps only the welcome comment', async () => {
    await seedComment('c1', 'approved');
    await demoDailyReset(db);
    await demoDailyReset(db);
    const rows = await db.prepare('SELECT id FROM comments').all();
    expect(rows.results.map((r) => r.id)).toEqual([DEMO_WELCOME.id]);
  });

  it('welcome comment is visible via the public read path (approved + /demo)', async () => {
    await demoDailyReset(db);
    const rows = await db
      .prepare("SELECT id, status FROM comments WHERE article_path = '/demo' AND status = 'approved'")
      .all();
    expect(rows.results.map((r) => r.id)).toContain(DEMO_WELCOME.id);
  });
});
