# StaticLayer Web Installer (`@staticlayer/installer`)

Installs StaticLayer into the user's Cloudflare account, reusing the
Desired State Engine from `@staticlayer/deployment-core`
(Observe → Diff → Plan → Apply → Verify).

## Start

```sh
npm run dev:installer   # → http://localhost:8788 (dev mode, placeholders)
```

In **dev mode** there is no email step: the wizard shows a **"Continue →"**
button that opens a local session directly (you're running it on your own
machine — no email proof needed). The magic link remains as an optional
secondary path.

To connect your **real Cloudflare account**, copy the env template and fill it
in (you type the values yourself — secrets never travel through chat):

```sh
cp apps/installer/.env.example apps/installer/.env.local
# edit .env.local: SESSION_SECRET, and optionally CLIENT_ID/CLIENT_SECRET
npm run dev:installer:real   # → http://localhost:8788
```

There are **two ways to connect** (see the wizard):

- **Option A — OAuth** (`recommended`): needs a Cloudflare OAuth client
  registered once (Manage Account → OAuth clients). Requires
  `STATICLAYER_CLIENT_ID` / `STATICLAYER_CLIENT_SECRET` in `.env.local`.
- **Option B — API token**: no OAuth client needed. Paste a token with
  **Workers Scripts: Edit**, **Cloudflare D1: Edit** and **Account Settings:
  Read**; it is validated, kept in memory, and cleared after the deploy.

Required env (see `src/index.ts`): `STATICLAYER_SESSION_SECRET`; optional
`STATICLAYER_DEV_MODE=1`, `STATICLAYER_CLIENT_ID`, `STATICLAYER_CLIENT_SECRET`,
`STATICLAYER_REDIRECT_URI`, `STATICLAYER_INSTALLER_URL`, `PORT`.

> The OAuth connection requires a real client registered with the minimal
> scopes — see `docs/oauth-scopes.md` and `DEPLOY_TO_REAL_CLOUDFLARE.md`.

## Flow

1. Local session (dev) **or** magic link (email) → HMAC-signed cookie
   (`SLSession`, HttpOnly).
2. Connect: **OAuth** Authorization Code (`client_secret_post`) with exactly
   the scopes `workers-platform.write`, `d1.write`, `account.read` — or a
   **pasted API token** (validated via the accounts endpoint, memory only).
3. Dry-run: plan with no side effects, no secrets.
4. Apply: the server generates the 3 secrets (32 bytes, base64url, CSPRNG) and
   sends them straight to Cloudflare via the **Bulk Secrets API**
   (`PATCH /secrets-bulk`); they are **never shown** to the user. OAuth tokens
   are revoked, pasted tokens are cleared, and the session is closed.

## Tests

```sh
npm run test:installer   # oauth (least-privilege), deploy (dry-run/apply/idempotent), auth (magic link), flow (meta/local/token)
```

## Security

- Client secret stays server-side; access token in memory only (never in a cookie).
- Pasted API tokens are validated, kept only in the in-memory session, never
  logged, and cleared after the deploy.
- Minimal scopes enforced by tests (`oauth.test.ts`).
- Deploys are never silent: the engine's `verify` catches any drift.
