# StaticLayer Web Installer — OAuth Scopes (verified IDs)

> **Principle: least privilege.** The installer asks Cloudflare users for the
> minimum permissions needed to deploy a StaticLayer Worker + D1 database into
> *their* account. It never asks for account-level editing, zone, or
> user-global access.
>
> **Verified 2026-08-26** against the official Cloudflare API reference and
> Fundamentals docs (see §4). The exact IDs below follow Cloudflare's OAuth
> scope format — dot-delimited `<group>.<level>` labels validated against the
> available OAuth API scopes.

## 1. Why OAuth at all?

The Web Installer lets a site owner deploy the StaticLayer worker **into their
own Cloudflare account** without pasting an API token. OAuth with the
Authorization Code grant means:

- the owner reviews exactly what is being asked (consent screen);
- the installer never sees the owner's password or API token;
- the access token can be **revoked immediately after the deploy**.

## 2. Scopes requested (exact IDs)

| Scope ID (exact) | Maps to permission | Why |
| --- | --- | --- |
| `account.read` | Account Settings: Read | List the accounts to pick the deploy target |
| `workers-platform.write` | Workers Scripts: Edit | Deploy the worker module + bind secrets |
| `d1.write` | Cloudflare D1: Edit | Create / list the D1 database |

These are the **only** scopes in the authorize URL (see
`apps/installer/src/oauth.ts`, constant `INSTALLER_OAUTH_SCOPES`).

## 3. Scopes NOT requested

| Never requested | Reason |
| --- | --- |
| `account.write` / account-level edit | We must not be able to change account settings |
| Zone scopes | StaticLayer needs no DNS/zone access |
| `user:*` global permissions | Not needed; the OAuth flow is per-user authorized |
| Billing / membership write | Out of scope for a comment deployer |

## 4. How these IDs were verified (official docs)

### 4.1 `account.read` — CONFIRMED VERBATIM

API reference — List OAuth Scopes
(`https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/methods/list/`),
`GET /oauth/scopes`, returns `result: [{ id, name, category, scopes }]`. The
official example:

```json
{
  "id": "account.read",
  "name": "Account Read",
  "category": "account_and_billing",
  "scopes": ["com.cloudflare.api.account"]
}
```

Also confirmed in the Create OAuth Client example (`POST /accounts/{id}/oauth_clients`):
`"scopes": ["account.read"]`, `"optional_scopes": ["account.write"]`.

**Important correction:** `com.cloudflare.api.account` (and any
`com.cloudflare.*` form such as `com.cloudflare.edge.workers.scripts.edit`) is
the **underlying resource scope** ("Bach scope") listed in the `scopes` array
of an OAuth scope — it is NOT the OAuth scope label. The label used in the
`scopes` array of a client is the short dot-delimited ID like `account.read`.

### 4.2 `workers-platform.write` — CONFIRMED VERBATIM

Fundamentals — Create your OAuth client
(`https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/`),
official API request example body:

```json
"scopes": ["workers-platform.read", "workers-platform.write"]
```

### 4.3 `d1.write` — convention-consistent, to be confirmed at registration

The API reference states scope IDs are **dot-delimited and validated against
available OAuth API scopes** ("Colon-delimited scopes are not accepted.
Dot-delimited scopes are validated against available OAuth API scopes") and
that the full list is returned by `GET /oauth/scopes`. No verbatim `d1.*`
example appears in the current public reference pages, so `d1.write` follows
the documented `<group>.<level>` convention but **must be confirmed** before
registering the production client:

```sh
curl "https://api.cloudflare.com/client/v4/oauth/scopes" \
  -H "Authorization: Bearer $API_TOKEN"
```

Filter the result for the `name` "Cloudflare D1: Edit" (or similar) and use its
`id`. If it differs from `d1.write`, update the single constant
`INSTALLER_OAUTH_SCOPES` in `apps/installer/src/oauth.ts` — the test
`apps/installer/test/oauth.test.ts` enforces whatever minimal set is defined
there and rejects any broad scope.

## 5. Token lifecycle (security)

1. `GET /api/oauth/start` → redirect to `https://dash.cloudflare.com/oauth2/auth`
   with `response_type=code`, `state`, and the three scopes.
2. `GET /oauth/callback` → exchange the code server-side
   (`client_secret_post`); the client secret never leaves the server.
3. The access token lives **only** in an in-memory server session (never in a
   cookie, never persisted to disk).
4. After a successful apply, the installer calls
   `https://dash.cloudflare.com/oauth2/revoke` and clears the session.
5. The site owner can also revoke at any time from
   **Manage OAuth authorizations** in the Cloudflare dashboard.

## 6. Runtime privacy guarantee (unchanged)

The OAuth token is used **only** to deploy. The StaticLayer runtime
(Worker + D1) never sends comments, nicknames, or user data anywhere outside
the customer's Cloudflare account — and the application never persists IP
addresses in its database (see `docs/PRIVACY_POLICY_TEMPLATE.md` and
`SECURITY_AUDIT_REPORT.md`).

## 7. Secret handling (Phase 4 audit)

The installer generates `ADMIN_SECRET` / `SESSION_SECRET` / `POW_SECRET`
server-side (CSPRNG, 32 bytes, base64url) and pushes them directly to
Cloudflare via the **Workers Bulk Secrets API**
(`PATCH /accounts/{id}/workers/scripts/{name}/secrets-bulk`, JSON Merge Patch —
verified 2026-08-26). The values are **never returned to the browser, never
logged, never shown**: the user only sees "Deploy Successful".
