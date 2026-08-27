# Cloudflare API Assumptions — StaticLayer v1

> **MANDATE**: before implementing any Cloudflare-specific API, binding,
> Wrangler configuration, or D1 behavior, verify it against the current
> official Cloudflare documentation and record the verified behavior here.
> Never infer an API from memory.
>
> All facts below were verified against the official documentation on
> **2026-08-26**. Each entry records the source URL and the exact documented
> wording that supports the assumption. If any fact is contradicted by newer
> docs, this file must be updated before relying on it.

---

## 1. D1 — prepared statements & parameter binding

**Status: VERIFIED**

- Source: <https://developers.cloudflare.com/d1/worker-api/d1-database/>
  and <https://developers.cloudflare.com/d1/worker-api/prepared-statements/>
  (page `dateModified` 2026-06-22).
- `env.DB.prepare(query)` returns a `D1PreparedStatement`; parameters are bound
  with `.bind(...)`. Only **ordered** (`?`, `?NNN`) parameters are supported
  (SQLite convention). Docs: *"D1 only supports Ordered (`?NNNN`) and Anonymous
  (`?`) parameters."*
- Execution methods: `.run()` (returns `D1Result`), `.first()`, `.all()`,
  `.raw()`. Docs: *"`run()` is functionally equivalent to `all()`"*.
- **Consequence**: all SQL in the runtime MUST use `prepare(...).bind(...)` —
  never string interpolation. This is also constraint #5 of the project.

## 2. D1 — `batch()` atomicity (anti-replay invariant)

**Status: VERIFIED (atomic, all-or-nothing)**

- Source: <https://developers.cloudflare.com/d1/worker-api/d1-database/#batch>
  (page `dateModified` 2026-06-22).
- Exact wording: *"D1 operates in auto-commit. Our implementation guarantees
  that each statement in the list will execute and commit, sequentially,
  non-concurrently. Batched statements are SQL transactions. If a statement in
  the sequence fails, then an error is returned for that specific statement,
  and it aborts or rolls back the entire sequence."*
- **Consequence**: issuing `INSERT OR IGNORE INTO used_challenges` and
  `INSERT INTO comments` in a single `batch()` gives us an atomic
  consume-and-insert. Exactly one of N concurrent batches with the same
  `challenge_id` can see `meta.changes === 1` for the `INSERT OR IGNORE`.
- **Residual risk (documented, not resolved by docs alone)**: the doc
  guarantees rollback on failure and sequential execution; it does NOT
  explicitly describe the isolation level under concurrency. The mandatory
  integration test (Phase 1, `tests/security`) will empirically prove
  "N concurrent requests with the same challenge_id ⇒ exactly 1 accepted".

## 3. D1 — `D1Result.meta.changes`

**Status: VERIFIED**

- Source: <https://developers.cloudflare.com/d1/worker-api/return-object/>
  (page `dateModified` 2026-04-21).
- Exact wording: `changes: number, // the number of changes made to the database`.
- **Consequence**: `INSERT OR IGNORE` that hits the existing PK yields
  `meta.changes === 0`; the runtime rejects with **409 Challenge Already Used**
  in that case. `changes` is read from the element of the `batch()` result
  array at the same index as the `used_challenges` statement.

## 4. D1 — 52-bit number precision (int64 caveat)

**Status: VERIFIED (platform limitation, plan around it)**

- Source: <https://developers.cloudflare.com/d1/worker-api/return-object/>
  ("Storing large numbers").
- Exact wording: *"Any numeric value in a column is affected by JavaScript's
  52-bit precision for numbers. If you store a very large number (in int64),
  then retrieve the same value, the returned value may be less precise."*
- **Consequence**:
  - `used_at INTEGER` stores unix seconds (≈ 1.7e9) — safe within 52 bits.
  - The PoW `nonce` (uint64) is **never stored as INTEGER**; it is stored as
    TEXT if needed, or not stored at all (the `challenge_id` is the replay key).
  - The protocol package serializes `nonce` as JSON number when ≤ 2^53 and as a
    decimal string otherwise (`serializeNonce` / `parseNonce`).

## 5. Rate Limit binding (Workers)

**Status: VERIFIED**

- Sources:
  - <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>
    (page `dateModified` 2026-04-23)
  - <https://developers.cloudflare.com/workers/wrangler/configuration/> (rate
    limits binding, page `dateModified` 2026-08-13)
- Configuration (Wrangler `wrangler.jsonc` `ratelimits` / TOML `[[ratelimits]]`):
  - `name` (binding name)
  - `namespace_id` — *"A string containing a positive integer that uniquely
    defines this rate limiting namespace within your Cloudflare account"*
  - `simple: { limit: number, period: number }` — *"period ... Must be either
    10 or 60"* seconds. `simple` is the only supported type.
- Runtime API: `await env.MY_RATE_LIMITER.limit({ key })` → `{ success: boolean }`.
- **WARNING about IP keys — CONFIRMED by docs**: *"It is not recommended to use
  IP addresses or locations (regions or countries), since these can be shared
  by many users in many valid cases."*
- **Locality & accuracy — CONFIRMED by docs**: rate limits are *"local to the
  Cloudflare location"* and the API is *"permissive, eventually consistent, and
  intentionally designed to not be used as an accurate accounting system."*
- **Consequence (architectural)**: rate limiting is an **edge-local
  mitigation**, not a security boundary. The primary protocol-level defenses are
  **PoW + anti-replay** (D1 `used_challenges`), with rate limiting on top.
  Keys chosen per route (e.g. `challenge:<article_path>`,
  `login:global`) — NOT raw IPs.

## 6. Wrangler configuration

**Status: VERIFIED**

- Source: <https://developers.cloudflare.com/workers/wrangler/configuration/>
  (page `dateModified` 2026-08-13).
- `wrangler.jsonc` is recommended for new projects (supported since Wrangler
  v3.91.0); some newer features are JSON-only.
- At minimum `name`, `main`, `compatibility_date` are required to deploy.
- `d1_databases`: `binding`, `database_name`, `database_id` (required);
  `preview_database_id`, `migrations_dir`, `migrations_pattern` (optional).
  Docs recommend `preview_database_id` when using `wrangler dev --remote`.
- Secrets: `secrets: { required: [...] }` declares required secret names and is
  validated at deploy. Local dev secrets go in `.dev.vars` (never committed).
  Docs: *"Do not use `vars` to store sensitive information ... Use secrets
  instead."*

## 7. D1 migrations workflow

**Status: VERIFIED**

- Sources:
  - <https://developers.cloudflare.com/d1/reference/migrations/>
    (page `dateModified` 2026-06-08)
  - <https://developers.cloudflare.com/workers/wrangler/commands/d1/>
    (page `dateModified` 2026-04-23)
- `wrangler d1 migrations create [DATABASE] [MESSAGE]` creates a versioned
  `NNNN_name.sql` in `migrations/`. `wrangler d1 migrations apply [DATABASE]`
  applies pending migrations (rolls back on error; backup captured). Applied
  migrations are recorded in the `d1_migrations` table.
- Default discovery: top-level `migrations/*.sql` under `migrations_dir`.

## 8. Web Crypto (Workers runtime)

**Status: VERIFIED**

- Source: <https://developers.cloudflare.com/workers/runtime-apis/web-crypto/>
  (page `dateModified` 2026-04-23).
- Supported: `SHA-256` digest ✓, `HMAC` sign/verify ✓, `crypto.getRandomValues` ✓
  (fills any ArrayBufferView with CSPRNG bytes).
- **`crypto.subtle.timingSafeEqual` is a NON-STANDARD Workers extension** and is
  NOT available in browsers. Consequence: the `@staticlayer/protocol` package
  (which must run identically in the Worker, the client Web Worker and the test
  runner) implements its own constant-time compare (`constantTimeEqual`). The
  runtime may additionally use `timingSafeEqual` on the server only — but
  preferring the shared implementation keeps behavior identical everywhere.
- HMAC usage pattern: `importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])`
  then `sign('HMAC', key, data)` (per the Web Crypto standard, which Workers
  implements fully).

## 9. `__Host-` cookie prefix (NOT a Cloudflare API)

**Status: VERIFIED (industry standard, RFC 6265bis)**

- The `__Host-` prefix is defined by the cookie standard (RFC 6265bis §4.1.3.5 /
  MDN). A cookie named `__Host-StaticLayerSession` **must** have `Secure`,
  `Path=/`, **no `Domain` attribute**, and be set from a secure origin; browsers
  reject cookies violating this.
- Consequence: the session cookie is emitted as
  `__Host-StaticLayerSession=<jwt>; Secure; HttpOnly; SameSite=Strict; Path=/`
  — never with `Domain`. This is enforced at the HTTP layer (plain `Set-Cookie`
  header), not via a Workers-specific API.
- The session token itself is self-contained (signed with `SESSION_SECRET`),
  absolute 2-hour TTL, no sliding renewal.

---

## Open items / ambiguities to verify in Phase 1 (before coding)

1. **D1 batch isolation under concurrency — RESOLVED (2026-08-26).** The docs
   guarantee sequential execution and rollback, but do not state the isolation
   level for concurrent batches. The integration test
   (`tests/security/replay-concurrency.test.ts`) fired 10 concurrent requests
   with the same `challenge_id` and observed **exactly 1 success + 9× 409, with
   exactly 1 row in both `comments` and `used_challenges`** on the local D1
   (Miniflare/workerd). The `WHERE changes() = 1` guard on the comment insert
   was validated by the same test (a naive unconditional insert would have
   stored duplicates). Re-run this test before every D1-related change.
2. **Rate limit `namespace_id` provisioning.** `namespace_id` is a
   customer-account integer. Whether it can be auto-created by Wrangler, or must
   be created via the dashboard/API first, must be verified before production
   deployment (docs show it as a config value only).
3. **`cf-connecting-ip`** exists but is deliberately **not** used as a rate
   limit key (docs discourage it). No assumption is made about its reliability.
4. **`request` body size cap** — `MAX_REQUEST_BYTES` is enforced in the Worker
   (ArrayBuffer byte count); the exact free-tier request size limit for Workers
   is a platform limit to re-check at deploy time.
5. **Local test environment** — security tests bundle the runtime with esbuild
   and run it in Miniflare (workerd) with an ephemeral local D1; the concurrency
   behavior of the local SQLite-backed D1 is a proxy for production D1. Two
   local-tooling quirks were observed and worked around (recorded for
   maintainers): Miniflare v4 rejects bundled scripts loaded via `scriptPath`
   (pass them inline via `script:`), and its `exec()` rejects multi-line
   statements (collapse whitespace; safe because the migration has no string
   literals).

---

## 10. Cloudflare REST API endpoints used by the engine (Desired State Engine, `@staticlayer/deployment-core`)

**Status: VERIFIED** — pages `dateModified` 2026-07-03 / 2026-08-26.

Base: `https://api.cloudflare.com/client/v4` — auth `Authorization: Bearer <token>`.

| Operation | Endpoint | Verified detail |
| --- | --- | --- |
| Upload Worker (module) | `PUT /accounts/{id}/workers/scripts/{name}` | `multipart/form-data`; `metadata` part (JSON) with `main_module`, `bindings`, `compatibility_date`, `triggers`; code part content-type `application/javascript+module`; `bindings_inherit`/`keep_bindings` optional. Source: Upload Worker Module API + multipart-upload-metadata docs. |
| Script exists | `GET /accounts/{id}/workers/scripts/{name}` | 404 ⇒ script not found; 200 ⇒ exists. |
| Bulk set secrets | `PATCH /accounts/{id}/workers/scripts/{name}/secrets-bulk` | **Workers Bulk Secrets API (verified 2026-08-26)** — JSON Merge Patch (RFC 7396): body `{ secrets: { NAME: { name, type: "secret_text", text } } }`; set `null` to delete; omitted = unchanged. Returns map `{ NAME: { name, type } }`. Source: api reference "Patch multiple script secrets". |
| List secrets | `GET /accounts/{id}/workers/scripts/{name}/secrets` | `{ result: [{ name, type }] }`. |
| Create D1 | `POST /accounts/{id}/d1/database` | JSON body `{ name }` ⇒ `result.uuid`. |
| List D1 | `GET /accounts/{id}/d1/database` | `result: [{ uuid, name }]`; supports `?name=` filter. |

> Note: the old single-secret endpoint
> `PUT /accounts/{id}/workers/scripts/{name}/secrets` was replaced by the
> Bulk Secrets API in the Phase 4 audit — the engine pushes all missing
> secret values in ONE `PATCH /secrets-bulk` call.

Response envelope: `{ success, errors[], messages[], result }`. A 2xx with
`success: false` is an error (the client treats both as failures — never
silent).

Metadata binding shapes confirmed: `d1` → `{ type: "d1", name, id }`;
`plain_text` → `{ type: "plain_text", name, text }`; `json` →
`{ type: "json", name, value }`; `secret_text` → `{ type: "secret_text", name,
text }`. The `ratelimit` binding type (`{ type: "ratelimit", name,
namespace_id, simple: { limit, period } }`) follows the Rate Limiting binding
configuration (see §5) mapped to the metadata format.

**Caveat (documented)**: the current bindings/crons of an already-deployed
Worker are NOT reliably readable back via the GET script API, so the engine
treats "worker exists" as satisfying the worker dimension and uses the signed
deploy response + existence re-check for verification; `repair` forces a
re-deploy to guarantee bindings/crons are current.

---

## 11. OAuth for the Web Installer (Phase 4)

**Status: VERIFIED** — pages `dateModified` 2026-06-03 / 2026-08-20 / 2026-08-25.

### Endpoints (source: `fundamentals/oauth/integrate-with-cloudflare/`)

| Endpoint | URL |
| --- | --- |
| Authorization | `https://dash.cloudflare.com/oauth2/auth` |
| Token | `https://dash.cloudflare.com/oauth2/token` |
| Revoke | `https://dash.cloudflare.com/oauth2/revoke` |
| User info / OIDC | `https://dash.cloudflare.com/oauth2/userinfo`, `https://dash.cloudflare.com/.well-known/openid-configuration`, `https://dash.cloudflare.com/.well-known/jwks.json` |

### Flows (source: `fundamentals/oauth/create-an-oauth-client/`)

- Only the **OAuth 2.0 Authorization Code** flow is supported for third-party
  clients. Client Credentials, Implicit, ROPC, Device are NOT supported.
- Server-side web app: Authorization Code **with client secret**
  (`client_secret_basic` or `client_secret_post`). PKCE is optional for
  confidential clients.
- **"OAuth scope names correspond to Cloudflare API token permission names."**
  The exact scope IDs are enumerated via `GET /oauth/scopes` (API reference,
  IAM → OAuth Scopes → List). The IDs are **dot-delimited labels validated
  against available OAuth API scopes** (colon-delimited are rejected).
  **Verified verbatim IDs (2026-08-26):**
  - `account.read` — official List OAuth Scopes example: `{ id: "account.read",
    name: "Account Read", category: "account_and_billing",
    scopes: ["com.cloudflare.api.account"] }`.
  - `workers-platform.write` — official Create your OAuth client example body:
    `"scopes": ["workers-platform.read", "workers-platform.write"]`.
  - `d1.write` — convention-consistent; no verbatim public example; confirm via
    `GET /oauth/scopes` at registration (docs/oauth-scopes.md §4.3).
  **Correction:** `com.cloudflare.*` strings (e.g. `com.cloudflare.api.account`,
  `com.cloudflare.edge.workers.scripts.edit`) are the UNDERLYING resource
  scopes ("Bach scopes") in the `scopes` array — NOT the OAuth scope labels
  used in an OAuth client's `scopes` list.
- Consent screen: the user sees the application name/domain and the exact
  requested permissions, can pick the target account, and can decline optional
  scopes. Required scopes must be granted.
- New clients default to **private** visibility (only members of the parent
  account can authorize); making a client public requires domain verification.
- Client secrets can be rotated; each client can hold two secrets.

### Permission names (source: `fundamentals/api/reference/permissions/`, 2026-08-25)

Account-scoped (scope id `com.cloudflare.api.account`):

| Permission | Grants |
| --- | --- |
| **Workers Scripts: Edit** | Write access to Cloudflare Workers scripts (deploy + bind secrets) |
| **Cloudflare D1: Edit** | Write access to D1 (create/list databases) |
| **Account Settings Read** | Read access to account resources/membership (list accounts) |

There is NO broad "Account: Edit" permission group — Cloudflare uses granular
permission names, which satisfies the installer's least-privilege requirement.

### Installer policy (implemented)

- The installer requests exactly three scopes (see `docs/oauth-scopes.md`):
  `account.read`, `workers-platform.write`, `d1.write`. It NEVER requests
  account edit/all, zone, or user-global permissions.
- Token exchange uses `client_secret_post` (server-side only; the secret never
  reaches the browser).
- **Secrets (Phase 4 audit):** after a successful apply, the OAuth access token
  is **revoked** and the session cleared. The worker secrets are generated
  server-side (CSPRNG) and pushed via the Bulk Secrets API (§10); they are
  NEVER returned to the browser, never logged, never shown.
- **Caveat (documented)**: `d1.write` must be confirmed against
  `GET /oauth/scopes` at client-registration time. The installer keeps the
  scope set in one constant (`INSTALLER_OAUTH_SCOPES`) and a test asserts no
  broad/extra scope is ever requested.

---

## Summary of consequences for the implementation

| Area | Verified conclusion |
| --- | --- |
| Anti-replay atomicity | `batch()` = transaction; use `INSERT OR IGNORE` + check `meta.changes` |
| SQL injection | `.prepare().bind()` only; ordered `?` params |
| PoW crypto | SHA-256 + HMAC via Web Crypto; own constant-time compare (browser-safe) |
| Rate limiting | edge-local only; route-scoped keys; never IP-only |
| Wrangler | `wrangler.jsonc`; `d1_databases` + `ratelimits` + `secrets.required` + `triggers.crons` |
| Migrations | `wrangler d1 migrations create/apply`, `migrations/*.sql` |
| Cookie | `__Host-` prefix forbids `Domain`; emit `Secure; HttpOnly; SameSite=Strict; Path=/` |
| CLI endpoints | Worker upload multipart, D1 create/list, secrets bulk (`PATCH /secrets-bulk`, see §10) |
| OAuth scopes | `account.read` + `workers-platform.write` verified verbatim; `d1.write` to confirm (§11) |
| Cron retention | `triggers.crons` daily purge of `used_challenges` > 24h |
