import { MAX_DIFFICULTY, MIN_DIFFICULTY } from '@staticlayer/protocol';
import type { D1Database } from '@cloudflare/workers-types';
import { requireAdmin, requireCsrf } from './auth.ts';
import { DEFAULTS, envNumber, type Env } from './env.ts';
import { json, readJsonBody } from './http.ts';
import {
  MODERATION_MODES,
  putSetting,
  readSettings,
  settingModerationMode,
  settingNumber,
  settingString,
  type ModerationMode,
} from './settings.ts';
import { normalizeListValue, type ListKind } from './moderation-lists.ts';
import { normalizeTerm } from './blocked-terms.ts';

/**
 * Admin configuration API (session + CSRF protected):
 *
 *   GET    /api/admin/lists            allow + block lists (with ids)
 *   POST   /api/admin/lists            { kind, value }   (+ X-CSRF-Token)
 *   DELETE /api/admin/lists/:id                          (+ X-CSRF-Token)
 *   GET    /api/admin/terms            blocked terms
 *   POST   /api/admin/terms            { term }          (+ X-CSRF-Token)
 *   DELETE /api/admin/terms/:id                          (+ X-CSRF-Token)
 *   GET    /api/admin/settings         effective settings (table merged w/ env)
 *   PUT    /api/admin/settings         { settings }      (+ X-CSRF-Token)
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleAdminGetLists(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;

  const { results } = await env.DB.prepare(
    'SELECT id, kind, value, created_at FROM moderation_lists ORDER BY kind ASC, value ASC',
  ).all<{ id: number; kind: string; value: string; created_at: number }>();

  const allow: { id: number; value: string; created_at: number }[] = [];
  const block: { id: number; value: string; created_at: number }[] = [];
  for (const row of results) {
    const item = { id: row.id, value: row.value, created_at: row.created_at };
    if (row.kind === 'allow') allow.push(item);
    else if (row.kind === 'block') block.push(item);
  }
  return json({ allow, block });
}

export async function handleAdminAddList(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  if (!(await requireCsrf(request, auth.payload))) return json({ error: 'invalid csrf token' }, 403);

  const read = await readJsonBody(request, 2048);
  if (!read.ok || typeof read.value !== 'object' || read.value === null) {
    return json({ error: 'invalid body' }, 400);
  }
  const kind = (read.value as Record<string, unknown>).kind;
  const rawValue = (read.value as Record<string, unknown>).value;
  if (kind !== 'allow' && kind !== 'block') return json({ error: 'kind must be allow or block' }, 400);
  if (typeof rawValue !== 'string') return json({ error: 'value is required' }, 400);

  const value = normalizeListValue(rawValue);
  if (!value) return json({ error: 'value is empty' }, 400);
  if (value.length > 100) return json({ error: 'value too long' }, 400);

  const createdAt = Math.floor(Date.now() / 1000);
  const result = await env.DB
    .prepare('INSERT OR IGNORE INTO moderation_lists (kind, value, created_at) VALUES (?, ?, ?)')
    .bind(kind, value, createdAt)
    .run();
  if (result.meta.changes === 0) return json({ error: 'already in list' }, 409);

  const row = await env.DB
    .prepare('SELECT id, kind, value, created_at FROM moderation_lists WHERE kind = ? AND value = ?')
    .bind(kind, value)
    .first<{ id: number; kind: string; value: string; created_at: number }>();
  return json({ list: row }, 201);
}

export async function handleAdminDeleteList(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  if (!(await requireCsrf(request, auth.payload))) return json({ error: 'invalid csrf token' }, 403);
  if (!/^\d+$/.test(id)) return json({ error: 'invalid list id' }, 400);

  const result = await env.DB.prepare('DELETE FROM moderation_lists WHERE id = ?').bind(Number(id)).run();
  if (result.meta.changes === 0) return json({ error: 'list entry not found' }, 404);
  return json({ ok: true });
}

export async function handleAdminGetTerms(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const { results } = await env.DB.prepare(
    'SELECT id, term, created_at FROM blocked_terms ORDER BY term ASC',
  ).all<{ id: number; term: string; created_at: number }>();
  return json({ terms: results });
}

export async function handleAdminAddTerm(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  if (!(await requireCsrf(request, auth.payload))) return json({ error: 'invalid csrf token' }, 403);

  const read = await readJsonBody(request, 2048);
  if (!read.ok || typeof read.value !== 'object' || read.value === null) {
    return json({ error: 'invalid body' }, 400);
  }
  const rawTerm = (read.value as Record<string, unknown>).term;
  if (typeof rawTerm !== 'string') return json({ error: 'term is required' }, 400);
  const term = normalizeTerm(rawTerm);
  if (!term) return json({ error: 'term is empty' }, 400);

  const createdAt = Math.floor(Date.now() / 1000);
  const result = await env.DB
    .prepare('INSERT OR IGNORE INTO blocked_terms (term, created_at) VALUES (?, ?)')
    .bind(term, createdAt)
    .run();
  if (result.meta.changes === 0) return json({ error: 'term already blocked' }, 409);
  const row = await env.DB
    .prepare('SELECT id, term, created_at FROM blocked_terms WHERE term = ?')
    .bind(term)
    .first<{ id: number; term: string; created_at: number }>();
  return json({ term: row }, 201);
}

export async function handleAdminDeleteTerm(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  if (!(await requireCsrf(request, auth.payload))) return json({ error: 'invalid csrf token' }, 403);
  if (!/^\d+$/.test(id)) return json({ error: 'invalid term id' }, 400);

  const result = await env.DB.prepare('DELETE FROM blocked_terms WHERE id = ?').bind(Number(id)).run();
  if (result.meta.changes === 0) return json({ error: 'term not found' }, 404);
  return json({ ok: true });
}

interface EffectiveSettings {
  pow_difficulty: number;
  reaction_options: string;
  moderation_mode: ModerationMode;
}

async function effectiveSettings(db: D1Database, env: Env): Promise<EffectiveSettings> {
  const map = await readSettings(db);
  return {
    pow_difficulty: settingNumber(map, 'pow_difficulty', envNumber(env.POW_DIFFICULTY, DEFAULTS.POW_DIFFICULTY)),
    reaction_options: settingString(map, 'reaction_options', env.REACTION_OPTIONS ?? DEFAULTS.REACTION_OPTIONS),
    moderation_mode: settingModerationMode(map, 'open'),
  };
}

export async function handleAdminGetSettings(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  return json({ settings: await effectiveSettings(env.DB, env) });
}

export async function handleAdminPutSettings(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  if (!(await requireCsrf(request, auth.payload))) return json({ error: 'invalid csrf token' }, 403);

  const read = await readJsonBody(request, 4096);
  if (!read.ok || typeof read.value !== 'object' || read.value === null) {
    return json({ error: 'invalid body' }, 400);
  }
  const body = read.value as Record<string, unknown>;
  const settings = body.settings;
  if (typeof settings !== 'object' || settings === null) return json({ error: 'settings is required' }, 400);
  const s = settings as Record<string, unknown>;

  if (s.pow_difficulty !== undefined) {
    if (typeof s.pow_difficulty !== 'number' || !Number.isInteger(s.pow_difficulty)) {
      return json({ error: 'pow_difficulty must be an integer' }, 400);
    }
    if (s.pow_difficulty < MIN_DIFFICULTY || s.pow_difficulty > MAX_DIFFICULTY) {
      return json({ error: `pow_difficulty must be between ${MIN_DIFFICULTY} and ${MAX_DIFFICULTY}` }, 400);
    }
    await putSetting(env.DB, 'pow_difficulty', String(s.pow_difficulty));
  }

  if (s.reaction_options !== undefined) {
    if (typeof s.reaction_options !== 'string' || s.reaction_options.length > 500) {
      return json({ error: 'reaction_options must be a short string' }, 400);
    }
    const options = s.reaction_options.split(',').map((o) => o.trim()).filter(Boolean);
    if (options.some((o) => o.length > 16)) return json({ error: 'each reaction must be <= 16 chars' }, 400);
    await putSetting(env.DB, 'reaction_options', options.join(','));
  }

  if (s.moderation_mode !== undefined) {
    if (typeof s.moderation_mode !== 'string' || !MODERATION_MODES.includes(s.moderation_mode as ModerationMode)) {
      return json({ error: 'moderation_mode must be open or allowlist' }, 400);
    }
    await putSetting(env.DB, 'moderation_mode', s.moderation_mode);
  }

  return json({ settings: await effectiveSettings(env.DB, env) });
}
