import type { Env } from './env.ts';
import { json } from './http.ts';
import { requireAdmin } from './auth.ts';
import { RUNTIME_VERSION } from './version.ts';

/**
 * GET /api/admin/updates — check whether a newer StaticLayer release exists.
 *
 * Fetches `UPDATES_URL` (a small JSON manifest on the official site, default
 * `https://abla25.github.io/StaticLayer/updates.json`) and compares its
 * `latest` version with this worker's `RUNTIME_VERSION`. Read-only and safe:
 * it never downloads or applies anything. Applying an update is a re-deploy
 * (the hosted installer preserves existing secrets automatically).
 */

const DEFAULT_UPDATES_URL = 'https://abla25.github.io/StaticLayer/updates.json';

/** Compare two dotted versions ("1.0.0" vs "1.2.3-beta" → -2). */
export function compareVersion(a: string, b: string): number {
  const parse = (s: string): number[] => s.split('.').map((p) => {
    const m = p.match(/^\d+/);
    return m ? Number(m[0]) : 0;
  });
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

interface UpdatesManifest {
  latest?: string;
  date?: string;
  notes?: string;
  installerUrl?: string;
}

export async function handleAdminCheckUpdates(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;

  const url = env.UPDATES_URL?.trim() || DEFAULT_UPDATES_URL;
  let manifest: UpdatesManifest | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`http ${res.status}`);
    manifest = (await res.json()) as UpdatesManifest;
    if (typeof manifest.latest !== 'string') throw new Error('manifest has no latest version');
  } catch (err) {
    error = (err as Error).message;
  }

  const latest = manifest?.latest ?? '';
  const updateAvailable = latest !== '' && compareVersion(latest, RUNTIME_VERSION) > 0;

  return json({
    current: RUNTIME_VERSION,
    latest,
    updateAvailable,
    date: manifest?.date ?? null,
    notes: manifest?.notes ?? null,
    installerUrl: manifest?.installerUrl ?? null,
    error,
  });
}
