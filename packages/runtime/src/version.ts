/**
 * Runtime + schema versions, surfaced by the health endpoint (`GET /api/health`
 * and `GET /`). `SCHEMA_VERSION` MUST match the number of applied
 * migrations/*.sql files (see migrations/README.md).
 */

/** Keep in sync with the npm release version (CHANGELOG.md). */
export const RUNTIME_VERSION = '1.4.0';

/** Number of applied migrations (001..008). */
export const SCHEMA_VERSION = 8;

/** Single source of truth for health payloads. */
export function healthPayload(): { name: string; status: string; version: string; schemaVersion: number } {
  return {
    name: 'staticlayer',
    status: 'ok',
    version: RUNTIME_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };
}
