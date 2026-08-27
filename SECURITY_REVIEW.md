# StaticLayer v1 — Security Review (draft)

> Living document. Phase 0 covers the protocol package and its verified
> invariants. Phase 1 must close the runtime items marked **[Phase 1]**.

## 1. Goal

A BYOC comment system for static sites that runs entirely inside the customer's
Cloudflare account (Worker + D1). The customer's runtime MUST never send
comments, nicknames, or user data to any StaticLayer server. Comments are
strictly plain text.

## 2. Threat model

| # | Threat | Primary defense | Phase |
| --- | --- | --- | --- |
| T1 | Comment spam / automated flooding | PoW (client cost) + anti-replay + route rate limit | 0 (PoW), 1 (replay) |
| T2 | Challenge forgery / replay across articles | Signed stateless challenge (`POW_SECRET` HMAC) bound to host + article path | 0 |
| T3 | Same challenge used twice (race) | D1 `batch()` + `INSERT OR IGNORE` on `used_challenges`, check `meta.changes` | 1 |
| T4 | SQL injection | Prepared statements + `bind()` only; never string interpolation | 1 |
| T5 | Stored/reflected XSS | `textContent` only in widget; comments stored/rendered as plain text; strict UTF-8; HTML escaping never relied upon | 1 |
| T6 | CSRF on admin mutations | Signed double-submit token bound to session; required on PATCH/DELETE | 1 |
| T7 | Admin session forgery / tampering | Stateless token signed with `SESSION_SECRET`; 2h absolute TTL; no sliding renewal; `__Host-` cookie (`Secure; HttpOnly; SameSite=Strict; Path=/`, NO `Domain`) | 1 |
| T8 | Session cookie theft via cross-site | `SameSite=Strict` + `HttpOnly` + `Secure` | 1 |
| T9 | Protocol-level replay of old proofs | `used_challenges` keyed by `challenge_id`; expiry in signed challenge | 1 |
| T10 | Malformed / oversized payloads | Strict canonical encoding (fail closed): length limits (255/255/50/3000), uint64 bounds, strict UTF-8, exact `challenge_id` length | 0 |
| T11 | Client weakening PoW difficulty / expiry | `difficulty` and `expiresAt` are inside the signed challenge | 0 |
| T12 | Rate-limit bypass via IP rotation | Rate limit is edge-local only; IP never the sole key; PoW + anti-replay are the security boundary | 1 |
| T13 | Third-party SaaS data exfiltration | Zero runtime dependencies; no outbound calls except D1 (binding), no external fetch | 0/1 |
| T14 | Secret misuse / mixing | Exactly 3 secrets with strictly separated roles (`ADMIN_SECRET`, `SESSION_SECRET`, `POW_SECRET`); never reused across purposes | 1 |

## 3. Trust boundaries

```
Browser (widget / Web Worker)          Worker (customer's Cloudflare)     D1 (customer's)
  - user-controlled: nickname, body     - verifies PoW, challenge sig     - SQLite; single writer
  - solves PoW                          - consumes challenge atomically
  - NEVER touches secrets               - holds 3 secrets; never leaks them
```

- The client is fully untrusted. It never sees a secret; it receives a signed
  challenge and returns a proof.
- The Worker trusts only: (a) its own secrets, (b) the verified signature, (c)
  the verified PoW, (d) D1 results.
- D1 is the single source of truth for the anti-replay invariant.

## 4. Security invariants (each with test evidence)

> Policy: "this should be X" is not acceptable without a test or a documented
> platform guarantee. Each invariant cites its enforcement test and/or the
> verified Cloudflare documentation (see `docs/cloudflare-assumptions.md`).

| Invariant | Enforcement | Evidence |
| --- | --- | --- |
| I1. Same logical payload ⇒ same byte sequence in every implementation | Canonical binary encoding, big-endian, fixed vectors | `test-vectors.ts` + `scripts/gen-vectors.py` (independent Python). Tests: `encoding.test.ts`, `crypto-vectors.test.ts` — **PASS (55/55)** |
| I2. Malformed input fails closed | `encodeCanonicalPayload`/`decode`/`verifyChallenge` throw or return false | `encoding.test.ts` (oversized fields, surrogates, truncated, trailing, wrong lengths), `challenge.test.ts` (tamper cases) — **PASS** |
| I3. Challenge signature cannot be forged/tampered | HMAC-SHA256 over canonical challenge; constant-time compare; `difficulty`+`expiresAt` inside signature | `challenge.test.ts` (wrong secret, tampered every field, flipped byte, wrong length) — **PASS** |
| I4. PoW verification is exact and difficulty-bounded | `verifyPow` = leading-zero-bits of SHA-256 ≥ difficulty | `pow.test.ts` (fixed mined nonce 91134: passes d≤17, fails d≥18) — **PASS** |
| I5. Exactly 1 of N concurrent requests with the same `challenge_id` is accepted | D1 `batch()` (documented transaction) + `INSERT OR IGNORE` + **conditional comment insert** `WHERE changes() = 1` + `meta.changes` check | **PROVEN EMPIRICALLY** (2026-08-26): `tests/security/replay-concurrency.test.ts` fires 10 concurrent posts sharing one challenge → exactly 1×200 + 9×409, DB holds exactly 1 comment + 1 consumed challenge. Atomicity also documented (`cloudflare-assumptions.md` §2) |
| I6. Timing-safe secret comparisons | `constantTimeEqual` (browser-safe); Workers' `timingSafeEqual` noted as non-standard | `crypto-vectors.test.ts` — **PASS** (behavioral; not a timing harness) |
| I7. No SQL injection | `.prepare().bind()` only | **[Phase 1]** code review + D1 binding docs (§1) |
| I8. No XSS | `textContent` only; plain-text comments | **PROVEN EMPIRICALLY** (2026-08-26): `tests/security/xss.test.ts` renders the payloads `"><img src=x onerror=alert(1)>` and `<script>…</script>` in jsdom; the resulting DOM contains ONLY text nodes — zero `<img>`/`<script>` elements |
| I9. No CSRF on admin mutations | Signed double-submit bound to session (`X-CSRF-Token` vs session `csrf`, constant-time) | **PROVEN EMPIRICALLY** (2026-08-26): `tests/security/csrf.test.ts` — PATCH without cookie → 401; with cookie, no/wrong header → 403; correct cookie + header → 200 |

## 5. Protocol design decisions (Phase 0)

- **Canonical binary encoding, not string concatenation**: length-prefixed
  fields with explicit endianness (all BE) remove ambiguity (e.g. a body
  containing `|` can never be confused with a separator).
- **Two canonical encodings, one schema version**:
  1. PoW payload (version, host, path, nickname, body, challenge_id, nonce) —
     the bytes that get hashed and proven.
  2. Signed challenge (version, host, path, challenge_id, expires_at,
     difficulty) — the bytes covered by the `POW_SECRET` HMAC.
  Both share the same UTF-8/length rules. This keeps the client free to choose
  nickname/body/nonce while being unable to alter host, path, difficulty or
  expiry without invalidating the signature.
- **Nonce is uint64 (`bigint`)**: serialized to JSON as a number when ≤ 2^53
  and as a decimal string otherwise — no precision loss, deterministic wire
  format.
- **base64url without padding** for `challenge_id` and `signature` in JSON.
- **Strict UTF-8**: JS strings with unpaired surrogates are rejected, so two
  different inputs can never collapse into the same canonical bytes
  (U+FFFD replacement is a canonicality killer).
- **Challenge signing secret is `POW_SECRET`** — a string secret is UTF-8
  encoded exactly as documented in the vectors.

## 6. Secrets (exactly 3, strictly separated)

| Secret | Used for | Never used for |
| --- | --- | --- |
| `ADMIN_SECRET` | Timing-safe comparison during admin login | signing tokens, PoW |
| `SESSION_SECRET` | Signing the stateless admin session + CSRF binding | PoW, login comparison |
| `POW_SECRET` | Signing/verifying PoW challenges (HMAC-SHA256) | sessions, login |

Local dev values go in `.dev.vars` (git-ignored); production values are set with
`wrangler secret put` (declared via `secrets.required` in the Wrangler config).

## 7. Known limitations (accepted)

- PoW is not a hard anti-spam guarantee; it raises the cost per comment. With
  anti-replay it also prevents "replay until rate limit resets".
- Rate limiting is per-Cloudflare-location and eventually consistent
  (documented by Cloudflare) — it is a backstop, not a security boundary.
- No authentication for readers (by design — no accounts, no email, no
  tracking). Nickname is a self-asserted plain-text string.

## 8. Open questions for the Phase 1 review

1. ~~D1 batch isolation under concurrency~~ **RESOLVED** — proven by the mandatory
   integration test (see I5).
2. `namespace_id` provisioning for the Rate Limit binding (dashboard vs Wrangler
   auto-provision) — still to verify before production deployment.
3. `used_challenges` retention/purge policy (the table grows with every consumed
   challenge; short-lived challenges suggest a periodic cleanup job) — Phase 2.
4. Exact free-tier request-size limits for `MAX_REQUEST_BYTES` at deploy time.
5. Challenge issuance via `GET` (as requested) is cacheable by intermediaries;
   acceptable because challenges are short-lived and bound to article+host, but
   a `POST` would be more correct semantically. Flagged for review.

## 9. Evidence summary

- `npm test` → **123/123 passing** (15 files): 55 protocol unit tests + 28
  security integration tests (anti-replay, CSRF, XSS, retention,
  no-IP-persistence structural) + 14 Desired-State-Engine tests
  (`packages/deployment-core/test`) + 22 installer tests + 4 demo tests.
- `npm run typecheck` → clean across `packages/*` and `apps/*`.
- Fixed vectors derived from an independent Python implementation
  (`scripts/gen-vectors.py`) — the TS implementation was NOT used to generate
  the expected values.
- Mandatory anti-replay concurrency invariant (I5) proven against the real
  Worker + local D1 in workerd (Miniflare): **exactly 1 of 10 concurrent posts
  accepted, 9× 409, store holds exactly 1 comment + 1 consumed challenge**.
  (LOCAL-only — see §14.4 for the remote-D1 caveat.)
- Engine invariants (I10/I11/I12/I15) proven with an in-memory mock of the
  Cloudflare API: idempotency, repair, verify-catches-lying-API, and the
  Bulk Secrets API push.

## 10. Phase 1 — design decision worth noting

The naive batch `[INSERT OR IGNORE used_challenges, INSERT comments]` has a
subtle bug: when `INSERT OR IGNORE` is ignored (`changes === 0`), the
*unconditional* comment INSERT still executes in the same batch, storing a
duplicate comment before the handler can return 409. The implementation guards
the comment insert with `WHERE changes() = 1`, so it only fires when THIS batch
actually consumed the challenge. Both `results[0].meta.changes` (the 409
decision) and `results[1].meta.changes` (the insert confirmation) are checked.
This is why the concurrency test also asserts the DB row counts, not just HTTP
statuses.

## 11. Phase 2 — delivered (2026-08-26)

- **Moderation pipeline**: new comments are stored as `pending`; the widget and
  the public `GET /api/comments` expose only `approved` comments.
- **Public GET**: `GET /api/comments?article_path=...&host_context=...` returns
  `{ comments: [{ id, nickname, body, created_at }] }` with
  `Cache-Control: public, max-age=60` and never sets a cookie.
- **Admin API**: `GET/PATCH/DELETE /api/admin/comments[/:id]` behind
  `verifySession` (401) + `X-CSRF-Token` gate on PATCH/DELETE (403, constant-time
  compare against the session-bound 32-byte CSRF token).
- **Widget** (`packages/widget`, built with esbuild): Vanilla JS, PoW mining in
  a dedicated Web Worker (`pow-worker.js`), `textContent`-only rendering,
  zero cookies/localStorage/analytics. Served at `/widget.js` and
  `/pow-worker.js` (`Cache-Control: public, max-age=3600`).
- **Admin UI**: `/admin.html` + `/admin.js` with CSP
  `default-src 'self'; script-src 'self'; …; frame-ancestors 'none'`; CSRF token
  kept in JS memory only.
- Static assets are inlined into the Worker at build time
  (`scripts/sync-static.mjs` → generated `static-content.ts`): zero runtime
  dependencies.

## 12. Retention of `used_challenges` (Phase 3) — why 24h is safe

`used_challenges` grows unboundedly; every consumed challenge stays forever.
Challenges have a **5-minute TTL**, so any row older than 24h can never be used
by a valid proof — it is pure storage overhead. The cron trigger
(`0 3 * * *` UTC, `wrangler.jsonc`) runs `DELETE FROM used_challenges
WHERE used_at < now - 24h` (`packages/runtime/src/retention.ts`).

**Why this does NOT weaken the anti-replay invariant (I5):**

- The anti-replay gate is the consumed `challenge_id` PK. Deleting an old
  consumed row can only make a REPLAY of that exact challenge possible again —
  but replays are additionally blocked by the **5-minute signed expiry** of the
  challenge (checked on every POST), which is far shorter than the 24h
  retention window. After the challenge expires, the proof is rejected with
  410 regardless of the table.
- `challenge_id` is 32 CSPRNG bytes; a freshly issued challenge cannot collide
  with an archived one (birthday-bound probability is negligible), so a deleted
  row can never be "re-consumed" by a new challenge.
- Empirically proven: `tests/security/retention.test.ts` invokes the real
  `scheduled` handler against the Miniflare D1; rows older than 24h are
  deleted, fresh rows are kept.

## 13. Desired State Engine — @staticlayer/deployment-core (Phase 3 + Phase 4 audit)

The DSE logic lives in the library-first package
**`@staticlayer/deployment-core`** (engine, API client, types, worker bundler).
It is consumed by both `@staticlayer/cli` (`staticlayer init|status|repair`)
and `@staticlayer/installer`. The package has **no `process.exit`, no prompts,
no console side effects** — the CLI's interactive shell (prompts, exit codes)
and the installer's HTTP server are thin shells around the same engine.
`packages/cli/src/engine.ts` was moved → `packages/deployment-core/src/engine.ts`
(Phase 4 audit).

Invariants (proven by `packages/deployment-core/test/engine.test.ts` with an
in-memory mock of the Cloudflare API):

- **I10 — Idempotency**: running `init` twice performs exactly one create-D1,
  one deploy and one bulk-secret call; the second run produces zero actions and
  no duplicates or failures.
- **I11 — Repair**: a missing D1 or missing worker is detected by `diff` and
  recreated by a forced `apply` + `verify`.
- **I12 — Never fail silently**: any Cloudflare API error propagates with the
  exact HTTP status and response detail (`ApiError`) and aborts the run; and if
  an API *returns success but persists nothing* (a lying/edge-case API), the
  mandatory `verify` step re-observes, re-diffs and **throws** instead of
  reporting success. Missing secret values abort BEFORE any apply (zero side
  effects).
- **I15 — Secrets travel via the Bulk Secrets API only** (Phase 4 audit): the
  engine pushes all missing secret values in ONE
  `PATCH /workers/scripts/{name}/secrets-bulk` call (JSON Merge Patch,
  verified 2026-08-26). Values exist only in server memory and inside the PATCH
  body — never logged, never returned.

Secret values are never stored in `staticlayer.config.json` (names only); they
are read from `STATICLAYER_<NAME>` env vars or prompted (masked) at apply time.

## 14. Web Installer + OAuth + Demo (Phase 4)

### 14.1 OAuth — least privilege (verified against official docs, 2026-08-25)

`apps/installer` deploys the system into the *user's* account via OAuth
(Authorization Code grant; only supported flow for third-party clients —
`client_secret_post` server-side). Docs confirmed: "OAuth scope names
correspond to Cloudflare API token permission names"; the exact IDs come from
`GET /oauth/scopes`. Verified verbatim IDs (2026-08-26): `account.read`
(official API example), `workers-platform.write` (official create-client
example); `d1.write` follows the same convention and must be confirmed at
registration — see `docs/oauth-scopes.md` and
`docs/cloudflare-assumptions.md §11`.

- **I13 — Scope minimization is enforced by test**: `oauth.test.ts` asserts
  the authorize URL requests EXACTLY `INSTALLER_OAUTH_SCOPES` and rejects any
  broad/account-edit/user/zone scope. The scope set lives in one constant.
- The client secret never leaves the server; the access token is kept only in
  an in-memory session (never in a cookie, never persisted).
- **I16 — Secrets stay server-side; the operator's ADMIN_SECRET is shown once**
  (Phase 4 audit, amended Round 21): after a successful apply the installer
  generates `ADMIN_SECRET`/`SESSION_SECRET`/`POW_SECRET` (32 bytes, base64url,
  CSPRNG) and pushes them straight to Cloudflare via the Bulk Secrets API. The
  HTTP response contains `{ actions, alreadyInSync, endpoint }` plus
  `adminSecret` — the operator's password, returned **exactly once** so they
  can sign in to `/admin.html`. `SESSION_SECRET`/`POW_SECRET` values are never
  returned. Then the OAuth token is revoked (`/oauth2/revoke`) and the session
  cleared. A dry-run returns the plan with zero side effects and no secrets.
- Installer session cookie: HMAC-signed, HttpOnly, SameSite=Lax; constant-time
  verification (proven in `auth.test.ts`).
- Deploy reuses the deployment-core engine verbatim: dry-run = plan only;
  apply = idempotent, verified (`verify` throws on drift). Proven in
  `deploy.test.ts` with the shared in-memory mock
  (`@staticlayer/deployment-core/testing`).

### 14.2 Demo — privacy by construction

`apps/demo` is a PUBLIC sandbox. Invariant **I14 — Demo data never
accumulates**: a daily cron (`demoDailyReset`) deletes EVERY comment except a
fixed `demo-welcome` row, which is re-inserted if missing. Proven by
`apps/demo/test/demo-reset.test.ts` (delete-all + re-insert + idempotency +
welcome visible via public read path). The demo worker also runs the runtime's
own retention purge.

### 14.3 Evidence summary (Phase 4)

- `apps/installer/test/oauth.test.ts` — scope minimization (exact minimal set),
  token exchange (client_secret_post), revoke, account listing (stub `fetch`).
- `apps/installer/test/deploy.test.ts` — dry-run (zero side effects, no
  secrets), apply pushes secrets via bulk API and **returns no secret values**
  (I16), idempotency, error propagation, ratelimit honored.
- `apps/installer/test/auth.test.ts` — session cookie (signed, HttpOnly,
  no Domain).
- `apps/demo/test/demo-reset.test.ts` — daily purge against real Miniflare D1.
- `packages/deployment-core/test/api.test.ts` — Bulk Secrets API request shape
  (`PATCH /secrets-bulk`, JSON Merge Patch body), multipart deploy, 404
  handling, error propagation.

### 14.4 Anti-replay concurrency — LOCAL-only evidence (Phase 4 audit)

**WARNING: This concurrency test runs against local Miniflare D1. While D1
docs guarantee batch atomicity, production REMOTE D1 concurrency behavior
requires empirical validation via `wrangler dev --remote` before commercial
launch.**

The I5 invariant (exactly 1 of N concurrent requests with the same
`challenge_id`) is proven only against the real Worker + **local** D1 in
workerd (`tests/security/replay-concurrency.test.ts`). The warning comment is
also placed at the top of that test file. See `SECURITY_AUDIT_REPORT.md`
("Challenge Single-Use" row, Residual Risk column) for the mitigation plan.

