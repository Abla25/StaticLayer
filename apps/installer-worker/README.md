# StaticLayer hosted Web Installer (`@staticlayer/installer-worker`)

Zero-terminal installs: a **Cloudflare Worker** that serves the same guided
wizard as the local installer. Anyone opens the URL, connects **their**
Cloudflare (OAuth or pasted API token) and StaticLayer is deployed into
**their** account — no terminal, nothing installed locally.

## Why a Worker?

- The deploy calls `api.cloudflare.com` **server-side** (browser CORS does not
  apply here).
- The OAuth `client_secret_post` exchange runs server-side — the secret never
  reaches the browser.
- The runtime worker code is **pre-bundled at build time** — no esbuild at
  runtime.

## Build

```sh
npm run build                          # repo root: builds protocol first
npm run build:installer-worker         # -> apps/installer-worker/dist/worker.js
```

`build.mjs`:
1. embeds `../installer/public/*` into `src/static-assets.ts` (generated);
2. pre-bundles `packages/runtime` into `src/runtime-bundle.ts` (generated);
3. bundles `src/worker.ts` → `dist/worker.js`.

## Deploy (one-time, by the project owner)

1. **OAuth client (once, public)** — Cloudflare dashboard → Manage Account →
   OAuth clients → Create client, then make it **public** (any Cloudflare user
   can authorize):
   - response type `code` · grant `authorization_code` · token auth `client_secret_post`
   - redirect `https://<your-installer>.workers.dev/oauth/callback`
   - scopes `workers-platform.write` · `d1.write` · `account.read`
2. **KV namespace**: `npx wrangler kv namespace create SESSIONS` → paste the id
   into `apps/installer-worker/wrangler.jsonc`.
3. **Secrets**:
   ```sh
   npx wrangler secret put STATICLAYER_SESSION_SECRET
   npx wrangler secret put STATICLAYER_CLIENT_ID
   npx wrangler secret put STATICLAYER_CLIENT_SECRET
   npx wrangler secret put STATICLAYER_REDIRECT_URI
   ```
4. **Deploy**: `npx wrangler deploy -c apps/installer-worker/wrangler.jsonc`

The wizard is live at `https://staticlayer-installer.<account>.workers.dev`.
Point the site's Install page at it.

## Local dev

```sh
npm run dev:installer:worker   # → http://localhost:8789 (local KV)
```

## Security

Same invariants as the node installer: client secret server-side; tokens only
in KV sessions (TTL), never in cookies/logs; deploy secrets generated in-memory
and pushed via the Bulk Secrets API (SESSION/POW never returned; the operator's
ADMIN_SECRET is returned exactly once after a real deploy, to sign in to
/admin.html); OAuth tokens revoked after a successful apply; API-token sessions
deleted.
