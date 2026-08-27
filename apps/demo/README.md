# StaticLayer Demo (`@staticlayer/demo`)

Public sandbox of the comment system. **All data is deleted every night**
(cron): only the fixed `demo-welcome` comment survives. No personal data
accumulates (invariant I14, tested).

## Structure

- `src/index.ts` — runtime wrapper: demo page at `/` (PUBLIC DEMO banner, widget
  pointing at itself, `data-article-path="/demo"`) + delegation to the runtime
  for APIs/static assets; cron = demo purge + runtime retention.
- `src/demo-reset.ts` — `demoDailyReset`: `DELETE FROM comments WHERE id !=
  'demo-welcome'` + `INSERT OR IGNORE` of the welcome comment.
- `wrangler.jsonc` — worker `staticlayer-demo`, dedicated D1, aggressive rate
  limit (`limit 3 / 60s`), `POW_DIFFICULTY=18`, daily cron (production).
- `wrangler.local.jsonc` — **local** config (validation): `POW_DIFFICULTY=16`,
  local D1 `staticlayer-demo-local`, relaxed rate limit (`60/60s`).
- `.dev.vars.example` — dev secrets to copy into `.dev.vars` (git-ignored) for
  `wrangler dev`.

## Local start (manual validation)

```sh
npm run dev:demo    # from the root: build + .dev.vars + local migrations + wrangler dev
# → http://localhost:8787  (checklist: HOW_TO_TEST_MANUALLY.md)
```

Individually: `npx wrangler d1 migrations apply staticlayer-demo-local --local
-c apps/demo/wrangler.local.jsonc`, then `npx wrangler dev -c
apps/demo/wrangler.local.jsonc --port 8787`.

## Deploy

```sh
# 1. create the D1 database and the rate-limit namespace, then fill in
#    database_id / namespace_id in wrangler.jsonc
# 2. set the 3 secrets
wrangler secret put ADMIN_SECRET -c apps/demo/wrangler.jsonc
wrangler secret put SESSION_SECRET -c apps/demo/wrangler.jsonc
wrangler secret put POW_SECRET -c apps/demo/wrangler.jsonc
# 3. apply the migrations
wrangler d1 migrations apply staticlayer-demo -c apps/demo/wrangler.jsonc
# 4. deploy
npm run deploy --workspace @staticlayer/demo
```

## Tests

```sh
npm run test:demo   # daily purge on Miniflare D1 (delete-all, re-insert, idempotent)
```
