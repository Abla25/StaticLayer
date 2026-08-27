# StaticLayer v1 — MASTER HANDOFF

> **Single Source of Truth** for any developer or AI agent taking over this
> project. Read this file FIRST, then `SECURITY_REVIEW.md`,
> `docs/cloudflare-assumptions.md` and `docs/oauth-scopes.md`.
>
> Last updated: 2026-08-26 — Phase 4 + Security Audit delivered, **123/123 tests green**.

---

## 0. Executive summary

**StaticLayer** is a **BYOC (Bring Your Own Cloud)** comment system for static
sites. The entire runtime — a Cloudflare **Worker + D1** database — runs inside
the *customer's* Cloudflare account. There is **no centralized SaaS**: the
runtime never sends comments, nicknames, or user data to StaticLayer servers.

**Primary goal:** a developer can install the system and publish their first
comment in **< 5 minutes** (Web Installer with OAuth, or CLI).

**Philosophy:** minimal attack surface, deterministic protocol, reproducible
deployment, zero external dependencies for the runtime.

### Delivered phases

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Canonical binary PoW protocol (encoding, challenge signing, verification, fixed vectors) | ✅ 55 tests |
| 1 | Worker runtime + D1 + **atomic anti-replay** (concurrency-proven) | ✅ 65 tests |
| 2 | Public widget (plain text, no tracking) + admin UI + CSRF + XSS-safe | ✅ 78 tests |
| 3 | CLI + **Desired State Engine** (init/status/repair) + retention cron | ✅ 93 tests |
| 4 | **Web Installer** (OAuth least-privilege) + public demo (daily purge) + privacy template | ✅ 120 tests |

---

## 1. Architecture — Control Plane vs Data Plane

```
┌───────────────────────────── CONTROL PLANE (deploy-time) ─────────────────────────────┐
│                                                                                        │
│   Developer / Site owner                                                               │
│        │                                                                               │
│        ├─(A) Web Installer  @staticlayer/installer   (apps/installer)                  │
│        │      OAuth (3 minimal scopes) → DSE deploy → secrets via Bulk API → revoke     │
│        │                                                                               │
│        └─(B) CLI  @staticlayer/cli   (packages/cli)                                    │
│               observe → diff → plan → apply → verify  (idempotent, never silent)       │
│                                                                                        │
│        ▼  Cloudflare REST API (Bearer token / OAuth access token)                      │
│   ┌─────────────────────────────────────────────────────────────┐                      │
│   │ Customer's Cloudflare account: D1 database + Worker + secrets │                      │
│   └─────────────────────────────────────────────────────────────┘                      │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────── DATA PLANE (runtime) ──────────────────────────────────┐
│                                                                                        │
│   Browser (visitor)                                                                   │
│   │  widget.js (no cookies, no tracking, textContent only)                            │
│   │  pow-worker.js (Web Worker mines nonce)                                          │
│   ▼                                                                                   │
│   StaticLayer Worker (customer's Cloudflare, @staticlayer/runtime)                    │
│   │  GET  /api/comments          → approved comments for an article                   │
│   │  GET  /api/comments/challenge→ signed PoW challenge (POW_SECRET HMAC)             │
│   │  POST /api/comments          → verify PoW + atomic anti-replay + store (pending)  │
│   │  POST /api/admin/login       → timing-safe, session cookie (__Host-)              │
│   │  GET/PATCH/DELETE /api/admin/comments → moderation (session + CSRF)               │
│   │  static: /widget.js /pow-worker.js /admin.html /admin.js                          │
│   │  scheduled() → purge used_challenges > 24h                                        │
│   ▼                                                                                   │
│   D1 (customer's)  — single source of truth; SQLite via binding, prepared stmts       │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Key principle:** the Control Plane (installer/CLI) touches the customer's
account *only during deployment* and holds no runtime data. The Data Plane
(the Worker + D1) never talks to StaticLayer infrastructure. The two planes
share code only through `@staticlayer/deployment-core` (library-first DSE +
API client, Phase 4 audit) and the shared protocol package.

---

## 2. The 5 absolute security invariants

These are **non-negotiable** and each is proven by tests (see `SECURITY_REVIEW.md`
for the full I1–I14 table and evidence). A change that breaks any of these is a
regression, period.

### 2.1 Anti-replay (I5) — exactly-one acceptance under concurrency
A consumed `challenge_id` can never be used twice, even under a race.
- Mechanism: D1 `batch()` (documented SQL transaction) with
  `INSERT OR IGNORE INTO used_challenges` + a **conditional comment insert**
  `INSERT INTO comments ... SELECT ... WHERE changes() = 1`, checking
  `results[0].meta.changes` (0 → 409) and `results[1].meta.changes` (≠1 → 500).
- Proof: 10 concurrent requests sharing one challenge → **exactly 1×200 +
  9×409**, store holds exactly 1 comment + 1 consumed challenge
  (`tests/security/replay-concurrency.test.ts`).
- Never "fix" the comment insert into an unconditional `INSERT`: that would
  store a duplicate comment for the losing request.

### 2.2 XSS (I8) — comments are plain text, period
- **No Markdown, no HTML.** The widget renders exclusively with `textContent`
  (NEVER `innerHTML`). Strict UTF-8 at the protocol boundary rejects unpaired
  surrogates (no two inputs can collapse to the same bytes).
- Proof: payloads `"><img src=x onerror=alert(1)>` and `<script>…</script>`
  render as literal text with zero injected elements
  (`tests/security/xss.test.ts`, jsdom).

### 2.3 CSRF (I9) — admin mutations require a bound token
- On login the server issues a 32-byte base64url `csrf` value embedded in the
  signed session; every PATCH/DELETE must send it in `X-CSRF-Token`
  (constant-time compare).
- Proof: PATCH without cookie → 401; cookie without/wrong header → 403;
  correct → 200 (`tests/security/csrf.test.ts`).

### 2.4 Timing-safe comparisons (I6)
- All secret comparisons use `constantTimeEqual` implemented locally with
  `crypto.subtle` — **browser-safe** (Workers' `timingSafeEqual` is
  Workers-only). Used for: admin login vs `ADMIN_SECRET`, CSRF token, session
  and magic-link HMAC verification.

### 2.5 No application-level IP persistence (constraint, part of I12/T12)
- The application does **not persist IP addresses** in its database, and the
  public widget/runtime set no cookies, no localStorage/sessionStorage, no
  fingerprinting, no analytics. Rate limiting never uses IP as the sole key
  (Cloudflare docs explicitly warn against IP keys) — it is a per-route,
  edge-local backstop only.
- **Precise scope of the claim:** StaticLayer (the application layer) stores no
  IP in the app DB. Cloudflare's infrastructure necessarily sees network
  metadata (including the source IP) as the data processor for routing and
  security. See `docs/PRIVACY_POLICY_TEMPLATE.md` and
  `SECURITY_AUDIT_REPORT.md` ("No App-Level IP Persistence").

---

## 3. Final folder structure

```
StaticLayer/
├── package.json                  # monorepo (workspaces: packages/* + apps/*), scripts
├── tsconfig.base.json            # strict base (ES2022, Bundler, noEmit)
├── wrangler.jsonc                # production worker config (D1, Rate Limit, secrets, cron)
├── vitest.config.ts              # all test suites incl. apps/*
├── MASTER_HANDOFF.md             # ← this file
├── SECURITY_REVIEW.md            # threat model T1–T14, invariants I1–I16, evidence
├── SECURITY_AUDIT_REPORT.md      # audit matrix: claim → file:line → test → CF guarantee
├── HOW_TO_TEST_MANUALLY.md       # non-technical validation checklist (demo + PoW + XSS + admin)
├── DEPLOY_TO_REAL_CLOUDFLARE.md  # step-by-step real deploy (CLI + secrets)
├── LICENSE                       # MIT
├── PHASE1_REVIEW_DUMP.md         # historical Phase 1 dump
│
├── packages/
│   ├── protocol/                 # Phase 0 — canonical binary PoW protocol
│   │   └── src/  encoding.ts, challenge.ts, pow.ts, crypto.ts,
│   │             base64url.ts, utf8.ts, constants.ts, errors.ts
│   ├── runtime/                  # Phase 1–3 — Cloudflare Worker + D1
│   │   └── src/  index.ts (router), comments.ts (submit), comments-read.ts,
│   │             challenge.ts, admin.ts, admin-comments.ts, session.ts,
│   │             auth.ts, retention.ts, ratelimit.ts, static.ts,
│   │             static-content.ts (AUTO-GENERATED), env.ts, http.ts
│   ├── widget/                   # Phase 2 — public widget + PoW worker (vanilla JS)
│   │   └── src/  widget.js, pow-worker.js   (dist/ via esbuild)
│   ├── deployment-core/          # Phase 4 audit — library-first Desired State Engine
│   │   └── src/  engine.ts, api.ts (incl. Bulk Secrets API), types.ts,
│   │             build-worker.ts, mock-api.ts (testing)   — shared by CLI + installer
│   └── cli/                      # Phase 3 — CLI shell (init/status/repair)
│       └── src/  index.ts, config.ts, prompts.ts   (engine lives in deployment-core)
│
├── apps/
│   ├── installer/                # Phase 4 — Web Installer (OAuth + DSE deploy + wizard)
│   │   └── src/  oauth.ts, auth.ts (magic link + session), deploy.ts, index.ts (server)
│   │       └── public/ index.html, app.js
│   └── demo/                     # Phase 4 — public demo (data purged daily)
│       └── src/  index.ts (wrapper), demo-reset.ts
│           + wrangler.jsonc (prod) + wrangler.local.jsonc (dev:demo) + .dev.vars.example
│
├── migrations/                   # D1 SQL (001_initial.sql, 002_admin_queue.sql)
├── tests/
│   └── security/                 # integration: replay-concurrency, csrf, xss, retention, no-ip-persistence, worker.ts
├── scripts/                      # gen-vectors.py (independent vectors), sync-static.mjs
└── docs/
    ├── cloudflare-assumptions.md # EVERY verified Cloudflare fact (mandate)
    ├── oauth-scopes.md           # Phase 4 least-privilege OAuth scopes
    └── PRIVACY_POLICY_TEMPLATE.md# customer-facing privacy template
```

**Command cheat-sheet**

```sh
npm install                # link workspaces
npm run build              # protocol → widget → static-content → CLI → installer
npm test                   # full suite (123 tests)
npm run test:protocol      # protocol unit tests
npm run test:security      # integration (Miniflare + D1 + jsdom)
npm run test:cli           # DSE tests (mock Cloudflare API)
npm run test:installer     # OAuth least-privilege + deploy + magic link
npm run test:demo          # daily purge
npm run dev:demo           # local public demo (port 8787) — validation checklist in HOW_TO_TEST_MANUALLY.md
npm run dev:installer      # local web installer wizard (port 8788, dev mode)
npm run typecheck
npm run dev                # build + wrangler dev
```

---

## 4. Key architectural decisions

### 4.1 Canonical binary encoding (Phase 0)
- All integers **big-endian**, length-prefixed UTF-8 fields, one protocol
  version. No string concatenation — a body containing `|` can never collide
  with a separator.
- **Two canonical encodings:** (1) the PoW payload (version, host, path,
  nickname, body, challenge_id, nonce) — the bytes hashed/proven; (2) the
  **signed challenge** (version, host, path, challenge_id, expires_at,
  difficulty) — the bytes covered by the `POW_SECRET` HMAC. The client can
  freely choose nickname/body/nonce but cannot alter host, path, difficulty or
  expiry without invalidating the signature.
- `nonce` is a `uint64` `bigint` → JSON number when ≤ 2^53, decimal string
  otherwise. `challenge_id`/`signature` are **base64url without padding**.
- Fixed vectors come from an **independent Python implementation**
  (`scripts/gen-vectors.py`) — the TS code was never used to generate them.

### 4.2 D1 `batch()` conditional insert (anti-replay, Phase 1)
See §2.1. The single most important runtime decision: the comment insert is
conditional on `changes() = 1` from the challenge-consume statement, inside a
documented D1 transaction. This is what makes exactly-one semantics hold under
concurrency. Do not regress this.

### 4.3 Desired State Engine (Phase 3)
- Strict **Observe → Diff → Plan → Apply → Verify**. Idempotent by
  construction (running `init` twice = zero second-run actions). `repair`
  forces convergence. **Never silent:** every API failure propagates with
  exact status/detail, and the mandatory `verify` re-observes and **throws** if
  any action is still pending — catching APIs that "return success" without
  persisting.
- Secret **values** never touch disk (`staticlayer.config.json` stores names
  only; values from `STATICLAYER_<NAME>` env or masked prompt). Reused verbatim
  by the Web Installer.

### 4.4 OAuth least privilege + secret handling (Phase 4 + audit)
- Web Installer requests **exactly** `workers-platform.write`, `d1.write`,
  `account.read` (constant `INSTALLER_OAUTH_SCOPES`, test-enforced to reject
  any broad/account-edit/user/zone scope). Authorization Code flow,
  `client_secret_post` server-side; access token in-memory only.
- **Secrets are NEVER shown** (Phase 4 audit): generated server-side (CSPRNG)
  and pushed straight to Cloudflare via the **Workers Bulk Secrets API**
  (`PATCH /secrets-bulk`); after a successful apply the token is **revoked**
  and the session cleared. The user only sees "Deploy Successful".
- Caveat: `d1.write` must be confirmed against `GET /oauth/scopes` at client
  registration (docs/oauth-scopes.md).

### 4.5 No application-level IP persistence runtime
- Public widget: no cookies, no localStorage/sessionStorage, no fingerprinting,
  no analytics. Comments stored/rendered strictly as plain text (`textContent`).
  The application never persists IP addresses in its DB (Cloudflare
  infrastructure handles network metadata as data processor).
- Exactly **3 secrets**, strictly separated roles: `ADMIN_SECRET` (login
  compare), `SESSION_SECRET` (session + CSRF signing), `POW_SECRET` (challenge
  HMAC). Never reused across purposes.
- Rate limiting: per-route keys (`challenge`/`comments`/`login`), never IP-only;
  edge-local backstop (Cloudflare-documented).

---

## 5. Rules for future contributors

1. **Verification mandate:** before relying on any Cloudflare-specific API,
   binding, Wrangler config or D1 behavior, verify against current official
   docs and record it in `docs/cloudflare-assumptions.md`. Never infer from
   memory.
2. **No scope creep.** Keep the runtime dependency-free and the surface minimal.
3. **Never use `innerHTML`** for comment data; never enable Markdown/HTML.
4. **Prepared statements only** (`.prepare().bind()`); no SQL interpolation.
5. **Tests are the contract.** Every invariant has an enforcement test; keep
   the full suite green (`npm test`) and typecheck clean before finishing.
6. Worker TS gotcha: worker projects use `lib:["ES2022"]` +
   `types:["@cloudflare/workers-types"]` (do NOT inherit the `WebWorker` lib —
   causes Request/Response global clashes).

## 6. Status at handoff

- **Tests:** 123/123 (15 files). Typecheck clean. Build clean. See
  `SECURITY_AUDIT_REPORT.md` for the code-level audit matrix.
- **Docs:** `SECURITY_REVIEW.md` (threat model + invariants + evidence),
  `docs/cloudflare-assumptions.md` (§1–§11 verified facts),
  `docs/oauth-scopes.md` (verified scope IDs), `docs/PRIVACY_POLICY_TEMPLATE.md`,
  `SECURITY_AUDIT_REPORT.md` (Phase 4 audit).
- **Open items (accepted):** confirm `d1.write` via `GET /oauth/scopes` at
  client registration; remote-D1 concurrency validation via `wrangler dev
  --remote`; production SMTP wiring for the installer's magic link.
