# StaticLayer v1 — Security Audit Report

> **Audit Mode (2026-08-26).** Result of the external review: the "Production
> Ready" claim was premature without code-level verification of Cloudflare
> assumptions and secret handling. This report is the audit trail: every claim
> maps to an implementation file:line, an automated test, the Cloudflare
> platform guarantee (verified, never inferred), and the residual risk.
>
> **Scope of this audit:** NO new features were added. Changes made during the
> audit (refactor + verification) are listed in §3.

---

## 1. Verification matrix

| Claim / Invariant | Implementation (File:Line) | Automated Test (File:Line) | Cloudflare Platform Guarantee (Link/Quote) | Residual Risk & Mitigation |
| --- | --- | --- | --- | --- |
| **Challenge Single-Use** | `packages/runtime/src/comments.ts:185` (`INSERT OR IGNORE INTO used_challenges`), `:189-192` (conditional `INSERT INTO comments ... WHERE changes() = 1`), `:197` (`env.DB.batch([consume, insertComment])`), `:205` (409), `:211` (500) | `tests/security/replay-concurrency.test.ts:97` (**MANDATORY**: 10 concurrent posts, exactly 1×200 + 9×409, DB counts asserted), `:121` (sequential replay 409, no duplicate), `:135` (new challenge accepted) | D1 `batch()` executes statements as a SQL transaction; rolls back on failure — quote: *"If any of the statements fail to execute, the entire sequence will be rolled back"* (https://developers.cloudflare.com/d1/worker-api/ — verified 2026-08-26, see `docs/cloudflare-assumptions.md §2`) | **Local Miniflare D1 only.** Remote D1 concurrency requires empirical validation via `wrangler dev --remote` before commercial launch (WARNING at `tests/security/replay-concurrency.test.ts:9-12` and `SECURITY_REVIEW.md §14.4`). |
| **XSS Prevention** | `packages/widget/src/widget.js:11` (render with `textContent` ONLY, never `innerHTML`), `:30` (`node.textContent = text`), `:72` (comment body rendered as text node) | `tests/security/xss.test.ts:57` (payloads `"><img src=x onerror=alert(1)>` and `<script>…</script>` → literal text, zero injected elements, jsdom), `:81` (empty/normal states) | N/A (browser DOM standard — `textContent` never parses markup) | None, strict plain-text enforcement (protocol also rejects unpaired surrogates, `packages/protocol/src/utf8.ts`). |
| **CSRF Protection** | `packages/runtime/src/auth.ts:56-59` (`requireCsrf`: constant-time compare of `X-CSRF-Token` vs the session-bound `csrf`), enforced by `packages/runtime/src/admin-comments.ts` (PATCH/DELETE) | `tests/security/csrf.test.ts:82` (32-byte token), `:88` (no cookie → 401), `:99` (cookie no header → 403), `:111` (wrong header → 403), `:123` (correct → 200), `:144` (DELETE) | N/A (custom double-submit bound to the HMAC-signed session) | None — token bound to session, constant-time compare (`constantTimeEqual`, browser-safe). |
| **No App-Level IP Persistence** | `migrations/001_initial.sql:9` (`used_challenges`), `:16` (`comments`) — schema has **no** IP/geo/fingerprint columns; `packages/runtime/src/comments.ts` stores only comment fields; `packages/runtime/src/ratelimit.ts:9` (route-scoped keys, never raw IPs); documented decision not to read `cf-connecting-ip` (`docs/cloudflare-assumptions.md:190`) | `tests/security/no-ip-persistence.test.ts:24` (schema has no IP/geo columns), `:45` (widget never uses `innerHTML`), `:55` (runtime never reads the client IP header) | Cloudflare infrastructure processes network metadata (source IP) as **data processor** for routing/security (https://www.cloudflare.com/trust-hub/privacy-and-data-protection/); the app DB stays clean | Cloudflare infrastructure still sees the IP for routing/rate-limit (edge-local, documented); the application DB contains no IP — see `docs/PRIVACY_POLICY_TEMPLATE.md`. |
| **Secrets Management** | `apps/installer/src/deploy.ts:68-71` (CSPRNG `generateSecrets`, 32 bytes base64url), `:104-105` (values only into `DesiredState`, never returned); `packages/deployment-core/src/api.ts:163-172` (`setSecretsBulk` → `PATCH /secrets-bulk`, JSON Merge Patch); `packages/deployment-core/src/engine.ts:99,130,138` (one bulk call after worker deploy) | `apps/installer/test/deploy.test.ts:63` (apply pushes via bulk, result contains **no** secret values), `packages/deployment-core/test/api.test.ts:64` (bulk request shape), `apps/installer/test/deploy.test.ts:87` (idempotency) | **Workers Bulk Secrets API** — `PATCH /accounts/{id}/workers/scripts/{name}/secrets-bulk`, RFC 7396 merge patch (https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/bulk_update/ — verified 2026-08-26, `docs/cloudflare-assumptions.md §10`) | Values exist in server memory only during apply; never logged, never returned, never shown ("Deploy Successful" only). OAuth token revoked + session cleared right after apply. |
| **OAuth Least Privilege** | `apps/installer/src/oauth.ts:34-41` (`INSTALLER_OAUTH_SCOPES` = exactly `workers-platform.write`, `d1.write`, `account.read`), `:55-62` (`buildAuthorizeUrl` — minimal scopes only) | `apps/installer/test/oauth.test.ts:13` (authorize URL requests EXACTLY the minimal set, rejects broad/account-edit/user/zone), `:38` (constant guard) | OAuth scope labels are dot-delimited and validated against available OAuth API scopes; `account.read` and `workers-platform.write` verified verbatim in official examples (https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/methods/list/ and https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/ — `docs/oauth-scopes.md §4`) | `d1.write` follows the documented `<group>.<level>` convention but has no verbatim public example: MUST be confirmed via `GET /oauth/scopes` at client registration (`docs/oauth-scopes.md §4.3`). The scope set is a single constant, test-enforced. |

---

## 2. Claims previously "assumed" that are now verified at code level

| Previous claim | Verified by |
| --- | --- |
| "Secrets shown exactly once" (Phase 4 wording) | **CHANGED (audit):** secrets are now **never shown**. `runInstallerDeploy` returns `{ actions, alreadyInSync }` only (`apps/installer/src/deploy.ts:116-119`); the browser never receives secret values. |
| "Workers Bulk Secrets API" | Verified endpoint `PATCH /secrets-bulk` (JSON Merge Patch body `{ secrets: { NAME: { name, type: "secret_text", text } } }`), implemented in `packages/deployment-core/src/api.ts:163-172` and covered by `packages/deployment-core/test/api.test.ts:64`. |
| OAuth scope IDs `workers-platform.write` / `account.read` | Verified verbatim against official API/Fundamentals examples (see matrix row + `docs/oauth-scopes.md §4`). `com.cloudflare.*` strings are the underlying resource scopes, NOT the OAuth labels (correction documented). |
| `@staticlayer/cli` is a safe import for the installer | **CHANGED (audit):** the installer now imports `@staticlayer/deployment-core` (library-first, no `process.exit`, no prompts, no console). CLI and installer share the same engine. |

## 3. Changes applied during Audit Mode

1. **New package `@staticlayer/deployment-core`** (`packages/deployment-core/`):
   engine (Observe→Diff→Plan→Apply→Verify), Cloudflare API client (incl.
   **Bulk Secrets API**), shared types, worker bundler, in-memory test mock.
   The installer no longer imports `@staticlayer/cli`.
2. **Installer secret handling**: secrets are generated server-side (CSPRNG)
   and pushed directly to Cloudflare via `PATCH /secrets-bulk`; the HTTP
   response and the UI contain **no secret values** — the user only sees
   "Deploy Successful" (`apps/installer/src/deploy.ts`, `apps/installer/src/index.ts:309-321`,
   `apps/installer/public/app.js`).
3. **Privacy wording**: replaced absolute "No-IP tracking" with the accurate
   **"No application-level IP persistence"** across `MASTER_HANDOFF.md`,
   `README.md`, `docs/PRIVACY_POLICY_TEMPLATE.md` (which now also discloses
   that Cloudflare infrastructure handles network metadata as data processor).
4. **Concurrency WARNING** added at the top of
   `tests/security/replay-concurrency.test.ts` and in `SECURITY_REVIEW.md §14.4`
   (local Miniflare only; remote D1 requires `wrangler dev --remote` validation).
5. **Retention JSDoc** added in `packages/runtime/src/retention.ts` justifying
   the 24h window (safety buffer for clock skew/retries/auditability; does not
   weaken anti-replay).
6. **`docs/oauth-scopes.md`** rewritten with verified scope IDs + links +
   mandatory `GET /oauth/scopes` confirmation step; `docs/cloudflare-assumptions.md`
   updated (§10 bulk secrets, §11 verified IDs + Bach-scope correction).
7. **New structural test** `tests/security/no-ip-persistence.test.ts`.

## 4. Residual risk register

| Risk | Severity | Mitigation / owner |
| --- | --- | --- |
| Remote D1 concurrency not yet proven end-to-end | Medium (pre-launch) | Run `wrangler dev --remote` concurrency replay before commercial launch (SECURITY_REVIEW.md §14.4). |
| `d1.write` scope ID not yet confirmed verbatim | Low | `GET /oauth/scopes` at client registration; single constant + test guard. |
| Installer magic-link SMTP not wired in production | Low | `STATICLAYER_DEV_MODE=0` requires an SMTP transport (integration point documented). |
| Operators cannot recover `ADMIN_SECRET` after an installer deploy (never shown) | Medium (usability) | Documented tradeoff of the audit: rotate via `wrangler secret put ADMIN_SECRET` or redeploy; the CLI path (`npx staticlayer init`) lets operators set their own secrets. |
| Rate limiting is edge-local / eventually consistent | Accepted (backstop only) | PoW + anti-replay remain the security boundary (Cloudflare-documented). |

## 5. Evidence status

- `npm test` → **green: 123/123 tests, 15 files** (see §1 matrix for per-claim test files).
- `npm run typecheck` → **clean** across `packages/*` and `apps/*`.
- Every Cloudflare-specific fact cited above is recorded with date + source in
  `docs/cloudflare-assumptions.md` (verification mandate).
