# Clean-room checklist

> **Purpose:** prove that a fresh user can install and publish a first comment
> in under 5 minutes on a machine that has never seen this repository — with a
> fresh Cloudflare account and a fresh static site. Run this BEFORE any
> commercial launch (see `PUBLIC_RELEASE_AUDIT.md` §5).

## Environment

- [ ] Fresh macOS/Linux machine (or disposable VM). No `~/PureComment`, no
      `node_modules`, no Cloudflare CLI state, no `~/.wrangler`.
- [ ] `node --version` ≥ 20, `npm --version` ≥ 10.
- [ ] A fresh Cloudflare account (or a fresh sub-account), empty.

## Install (CLI path)

1. [ ] `git clone <repo-url>` and `cd` into it.
2. [ ] `npm ci` completes with 0 errors.
3. [ ] `npm run build` completes.
4. [ ] `npx staticlayer init` → answer prompts (account ID, API token).
5. [ ] `staticlayer.config.json` is written and contains NO `apiToken`.
6. [ ] Apply migrations: `npx wrangler d1 migrations apply staticlayer --remote -c wrangler.jsonc`.
7. [ ] `npx staticlayer status` → reports `in sync` (all actions applied + verified).

## Fast installer path (OAuth)

1. [ ] `npm run dev:installer` starts on port 8788.
2. [ ] Browser OAuth authorize → account picker → deploy completes.
3. [ ] The access token is revoked after deploy (check the Cloudflare dashboard
      OAuth apps / audit log).
4. [ ] No secret value appears in the browser UI, terminal, or any file.

## First comment (target: < 5 min total from step "Install")

1. [ ] A static page includes:
      `<div data-staticlayer data-api="<worker-url>" data-article-id="/hello"></div>`
      and `<script src="<worker-url>/widget.js" defer></script>`.
2. [ ] Visitor posts a comment → PoW spinner → "awaiting moderation".
3. [ ] Admin opens `<worker-url>/admin.html`, signs in with `ADMIN_SECRET`.
4. [ ] Approve → the comment appears on the page on reload.
5. [ ] The same article shows exactly ONE copy of the comment (anti-replay).

## Cross-origin (if site ≠ Worker origin)

1. [ ] Set `ALLOWED_ORIGINS` to the site origin in the config.
2. [ ] Redeploy, then verify POST from the real site origin succeeds.
3. [ ] A different origin is rejected (no `Access-Control-Allow-Origin`).

## Record

- [ ] Start/end timestamps for the whole run (target ≤ 5 min).
- [ ] Exact versions (node, npm, wrangler, compatibility_date).
- [ ] Any deviation from this checklist, appended below.
