# PUBLIC_RELEASE_AUDIT.md

**Project:** StaticLayer v1 — BYOC comment system for static sites (Cloudflare Worker + D1).
**Status:** v1.0.0-beta.1 — honest beta, NOT production-grade yet.
**Date:** 2026-08-27

This audit maps every public claim to its evidence. Anything without evidence is
listed as **pending** — nothing here is assumed.

---

## 1 · Test & verification status

| Item | Result | Evidence |
| --- | --- | --- |
| Full test suite | **155 passed / 20 files** | `npm test` (2026-08-27) |
| Typecheck (all TS workspaces) | **0 errors** | `npm run typecheck` |
| Protocol unit tests | passed | `packages/protocol/test/**` (encoding, challenge, PoW, crypto) |
| Independent Python vectors | generated | `scripts/gen-vectors.py` → `packages/protocol/test/test-vectors.ts` |
| Security integration tests | passed | `tests/security/**` (XSS, CSRF, anti-replay concurrency, retention, no-IP, CORS, health, widget API) |
| CLI/deployment-core tests | passed | `packages/deployment-core/test/**`, `packages/cli/test/**` |
| Installer tests | passed | `apps/installer/test/**` |
| Demo reset test | passed | `apps/demo/test/**` |
| Site build | passed | `npm run build:site` (7 pages) |
| npm audit | run in CI | `.github/workflows/ci.yml` (`npm audit --audit-level=high \|\| true`) |

## 2 · Security claims → evidence

| Claim | Evidence (file) | Notes |
| --- | --- | --- |
| Plain-text comments, no raw HTML | `packages/widget/src/widget.js` (`.sl-body` via `textContent`); `tests/security/xss.test.ts` | XSS payload rendered as literal text; no injected nodes |
| No visitor tracking in the widget | `packages/widget/src/widget.js` (no cookies/storage/fingerprint); `tests/security/no-ip-persistence.test.ts` | structural test |
| No application-level IP persistence | `migrations/*.sql` (no IP columns); `packages/runtime/src/**` (no `cf-connecting-ip`) | `tests/security/no-ip-persistence.test.ts` |
| Prepared statements only | `packages/runtime/src/comments.ts`, `admin-comments.ts`, `retention.ts`, `challenge.ts` | all D1 access via prepared `stmt.bind()` |
| PoW challenge signed + single-use | `packages/runtime/src/challenge.ts`, `packages/runtime/src/comments.ts` | HMAC-SHA256, expiry inside signature |
| D1 transactional anti-replay | `packages/runtime/src/comments.ts` (`batch()` + `INSERT OR IGNORE` + conditional insert) | `tests/security/replay-concurrency.test.ts` (10 concurrent → 1×200 + 9×409) — **local Miniflare only** |
| Timing-safe admin login | `packages/runtime/src/admin.ts` | `__Host-` cookie, stateless HMAC session |
| CSRF binding | `packages/runtime/src/auth.ts`, `admin-comments.ts` | `tests/security/csrf.test.ts` |
| Rate limiting, route-based (never IP) | `packages/runtime/src/ratelimit.ts` | keys are route+nonce, not IP |
| Retention (used_challenges > 24h) | `packages/runtime/src/retention.ts` | cron `0 3 * * *`; JSDoc justification |
| **CORS allowlist (NEW — Phase F)** | `packages/runtime/src/cors.ts`, `index.ts` | fail-closed; explicit origins only, never `*`; `tests/security/cors-health.test.ts` |
| **Widget aliases + programmatic API (NEW — Phase F)** | `packages/widget/src/widget.js` | `data-api`/`data-article-id` aliases; `StaticLayer.mount/unmount`; `tests/security/widget-api.test.ts` |
| **Health endpoint (NEW — Phase F)** | `packages/runtime/src/version.ts`, `index.ts` (`GET /api/health`) | runtime version + schema version; `tests/security/cors-health.test.ts` |
| **Reactions (NEW)** | `packages/runtime/src/reactions.ts`, `migrations/003_reactions.sql`, `packages/widget/src/widget.js` | anonymous events, single-use PoW, per-article escalation + rate limit + interval; comments/reactions separable (`data-reactions-only`); `tests/security/reactions.test.ts`, `tests/security/widget-reactions.test.ts` |
| Secrets stay server-side; ADMIN_SECRET shown once | `apps/installer/src/deploy.ts`, `packages/cli/src/index.ts` | generated server-side, pushed via Bulk Secrets API; operator's ADMIN_SECRET returned exactly once after a real deploy; `packages/deployment-core/src/engine.ts` |
| `apiToken` never on disk | `packages/cli/src/config.ts` (saveConfig strips it) | `packages/cli/test/config.test.ts` |

## 3 · Architecture & infrastructure claims

| Claim | Evidence |
| --- | --- |
| BYOC — runs in customer's Cloudflare account | `wrangler.jsonc`, `packages/runtime/`, `packages/deployment-core/` |
| Exactly 3 secrets, strict separation | `packages/runtime/src/env.ts`, `SECURITY.md`, `THREAT_MODEL.md` |
| No centralized comment database | no external service in runtime; all data in customer D1 |
| Cloudflare API facts verified | `docs/cloudflare-assumptions.md` (dated 2026-08-26) |

## 4 · Documentation integrity

| Doc | Covers |
| --- | --- |
| `SECURITY.md` | vulnerability reporting, posture, dependency hygiene |
| `THREAT_MODEL.md` | trust boundaries, T1–T16, invariants, out-of-scope |
| `SECURITY_REVIEW.md` | controls I1–I16, §13 deployment-core, §14 installer/demo |
| `SECURITY_AUDIT_REPORT.md` | claim-by-claim matrix, residual risk register |
| `CHANGELOG.md` | versions incl. StaticLayer rebrand + site |
| `README.md` / `apps/site` | product, demo, docs, integrations, FAQ |

## 5 · PENDING before commercial launch (do NOT skip)

- [ ] **Remote D1 concurrency** — anti-replay verified on local Miniflare only. Must be
      re-run against a real remote D1 (`wrangler dev --remote` or deployed worker).
- [ ] **Clean-room install** — a fresh machine + fresh Cloudflare account, following
      `docs/clean-room-checklist.md`, with no prior repo state.
- [ ] **CORS end-to-end on a real origin** — verify preflight + actual cross-origin
      POST from a deployed static site (GitHub Pages / CF Pages) to a deployed Worker.
- [ ] **Hosted/zero-terminal installer** — documented as roadmap; requires a registered
      Cloudflare OAuth app + hosting. NOT in this release.
- [ ] **SEO caveat accepted** — comments are client-side rendered; no SEO promise.
- [ ] **PoW benchmark doc** — difficulty-to-time table on reference hardware.
- [ ] **Bundle-size validation script** — currently printed by `apps/site/build.mjs` only.

## 6 · Release gate (checklist)

1. `npm ci` clean
2. `npm run typecheck` → 0 errors
3. `npm test` → 140/140
4. `npm run build` → all packages
5. `npm run build:site` → 7 pages, assets sized
6. Clean-room install passed (see §5)
7. Remote-D1 concurrency passed (see §5)
8. Real-origin CORS passed (see §5)
9. `docs/release-checklist.md` green
