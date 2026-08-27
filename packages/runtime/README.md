# @staticlayer/runtime

Cloudflare Worker + D1 runtime for StaticLayer.

**Phase 2 (implemented):**

- `GET  /api/comments` — public read, only `approved` comments,
  `Cache-Control: public, max-age=60`, no cookies.
- `GET  /api/comments/challenge` — issues a stateless signed PoW challenge.
- `POST /api/comments` — verifies signature → expiry → difficulty → PoW, then
  the ATOMIC anti-replay store (one `D1 batch()`, conditional comment insert
  `WHERE changes() = 1`, `changes === 0` ⇒ `409`). New comments are `pending`.
- `POST /api/admin/login` — timing-safe `ADMIN_SECRET` comparison; sets
  `__Host-StaticLayerSession` (Secure; HttpOnly; SameSite=Strict; Path=/; NO
  `Domain`); returns a 32-byte session-bound CSRF token.
- `GET/PATCH/DELETE /api/admin/comments[/:id]` — moderation queue (401 without
  session; PATCH/DELETE additionally require `X-CSRF-Token`, 403 on mismatch).
- Static assets: `/widget.js`, `/pow-worker.js` (public, max-age=3600),
  `/admin.html` (+CSP), `/admin.js` — inlined at build time.

**Running locally**

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in strong random secrets
wrangler d1 create staticlayer   # copy the returned database_id into wrangler.jsonc
wrangler d1 migrations apply staticlayer --local
npm run dev                      # = npm run build && wrangler dev
```

Secrets are declared in `wrangler.jsonc` (`secrets.required`) and must be set
with `wrangler secret put` for remote deploys. Rate limiting is edge-local
(route-scoped keys, never raw IPs) — see `docs/cloudflare-assumptions.md` §5.

**Tests** (integration, Miniflare + local D1 + jsdom):

```sh
npm run test:security   # anti-replay, CSRF, XSS, public GET, static assets
```
