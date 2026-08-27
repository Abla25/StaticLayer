import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Structural evidence for SECURITY_AUDIT_REPORT.md —
 * "No App-Level IP Persistence":
 *   1. The D1 schema declares NO IP/geo/fingerprint columns.
 *   2. The public widget source uses `textContent` and NEVER `innerHTML`.
 * (Pure static checks — no worker is spawned.)
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const WIDGET_SRC = join(ROOT, 'packages', 'widget', 'src', 'widget.js');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

describe('No application-level IP persistence (structural)', () => {
  it('the D1 schema has no IP / geo / fingerprint / cookie columns', () => {
    const sql = migrationFiles()
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
      .join('\n');

    // Column names in the schema (CREATE TABLE bodies).
    const columnDefs = sql.match(/^\s*[a-z_]+\s+(TEXT|INTEGER|BLOB|REAL)\b/gim) ?? [];
    const forbidden = /(^|[_\s])(ip|ip_address|client_ip|remote_addr|geo|lat|lon|location|country|user_agent|fingerprint|cookie|session_id)([_\s]|$)/i;
    for (const def of columnDefs) {
      expect(def, `unexpected column in schema: ${def.trim()}`).not.toMatch(forbidden);
    }

    // The two tables store exactly the documented fields (comments + used_challenges).
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS used_challenges');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS comments');
    expect(sql).toMatch(/comments \(\s*id\s+TEXT\s+PRIMARY\s+KEY,.*article_path/s);
  });

  it('the widget renders with textContent and never calls innerHTML', () => {
    const src = readFileSync(WIDGET_SRC, 'utf8');
    expect(src).toContain('textContent');
    expect(src).not.toMatch(/\.innerHTML\s*=/);
    expect(src).not.toMatch(/insertAdjacentHTML/);
    expect(src).not.toMatch(/document\.write/);
  });

  it('the runtime never reads the client IP header (no cf-connecting-ip usage)', () => {
    const runtimeFiles = [
      'comments.ts',
      'comments-read.ts',
      'challenge.ts',
      'admin.ts',
      'admin-comments.ts',
      'session.ts',
      'auth.ts',
      'ratelimit.ts',
      'retention.ts',
      'index.ts',
    ];
    for (const f of runtimeFiles) {
      const src = readFileSync(join(ROOT, 'packages', 'runtime', 'src', f), 'utf8');
      expect(src, `${f} must not read the client IP`).not.toMatch(/cf-connecting-ip|request\.headers\.get\(['"]cf/i);
    }
  });
});
