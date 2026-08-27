# migrations/

D1 SQL migrations for StaticLayer.

- `001_initial.sql` — `comments` + `used_challenges` tables.
- `002_admin_queue.sql` — indexes + admin query support on `comments`.
- `003_reactions.sql` — anonymous `reactions` table (PoW-protected).

Apply locally: `wrangler d1 migrations apply staticlayer --local`
(see `docs/cloudflare-assumptions.md` §7 for the verified workflow).
`SCHEMA_VERSION` in `packages/runtime/src/version.ts` must equal the number of
migrations.
