/**
 * StaticLayer demo — daily data purge.
 *
 * The demo is a PUBLIC sandbox: every night (cron) ALL comments are deleted
 * except the fixed welcome comment, which is re-inserted if missing.
 * This guarantees the demo can never accumulate user data (privacy).
 */
import type { D1Database } from '@cloudflare/workers-types';

export const DEMO_WELCOME = {
  id: 'demo-welcome',
  articlePath: '/demo',
  nickname: 'StaticLayer',
  body: 'Welcome to the demo! 👋 This is a public sandbox — data is purged every night. ' +
    'Comments are plain text (no HTML/Markdown), but emoji work fine — try replying with 🎉 ✨. ' +
    'Your comment passes an anti-spam proof-of-work in the browser and enters the moderation queue. ' +
    'No personal data is collected.',
  status: 'approved',
} as const;

export interface DemoResetResult {
  deleted: number;
  welcomePresent: boolean;
}

export async function demoDailyReset(
  db: D1Database,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<DemoResetResult> {
  const del = await db
    .prepare('DELETE FROM comments WHERE id != ?')
    .bind(DEMO_WELCOME.id)
    .run();
  const ins = await db
    .prepare(
      'INSERT OR IGNORE INTO comments (id, article_path, nickname, body, status, created_at, challenge_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      DEMO_WELCOME.id,
      DEMO_WELCOME.articlePath,
      DEMO_WELCOME.nickname,
      DEMO_WELCOME.body,
      DEMO_WELCOME.status,
      0,
      'demo',
    )
    .run();
  return {
    deleted: del.meta.changes ?? 0,
    welcomePresent: (ins.meta.changes ?? 0) <= 1,
  };
}
