# DEPLOY TO REAL CLOUDFLARE — StaticLayer (via CLI)

> Step-by-step guide to deploy StaticLayer to **your real Cloudflare account**
> (Worker + D1 database) using the CLI `npx staticlayer init`.
> Everything is handled by the Desired State Engine: **observe → plan → apply →
> verify** (never silent, idempotent).
>
> Estimated time: **5–10 minutes**.

---

## 0. Prerequisites

- A Cloudflare account (free tier is enough).
- Node.js **≥ 20** and npm on your machine.
- A local clone of the StaticLayer repo, with `npm install` already done.

---

## 1. Find your Account ID

1. Go to **https://dash.cloudflare.com** and sign in.
2. Top-right: **My Profile → API Tokens** (or find the Account ID in the right
   sidebar of the home page).
3. Copy the **Account ID** (a 32-character hex string). You'll need it shortly.

---

## 2. Create an API token with minimal permissions

1. In **My Profile → API Tokens**, click **Create Token**.
2. Start from the **"Edit Cloudflare Workers"** template.
3. Add/edit the **Account permissions** so you have exactly:
   - **Workers Scripts** → **Edit**
   - **Cloudflare D1** → **Edit**
   - **Account Settings** → **Read**
4. (Optional, recommended) Under **Account Resources**, restrict the token to
   the account you want to use.
5. Create and **copy the token immediately** (it won't be shown again).

> 💡 Minimal permissions: the token only deploys the Worker, creates/reads the
> D1 database and reads the account. **No** zone/billing permissions.

---

## 3. Generate the 3 secrets (keep them in env, never on disk)

The Worker uses **exactly 3 secrets**: `ADMIN_SECRET`, `SESSION_SECRET`,
`POW_SECRET`. The CLI sends them to Cloudflare with the **Bulk Secrets API**
during the deploy — but the **values must not live on disk**. Pass them via
environment variables:

```sh
export STATICLAYER_ADMIN_SECRET="$(openssl rand -hex 32)"
export STATICLAYER_SESSION_SECRET="$(openssl rand -hex 32)"
export STATICLAYER_POW_SECRET="$(openssl rand -hex 32)"
```

> 🔒 **Security:** `STATICLAYER_*` values are never written to
> `staticlayer.config.json` (which stores only the NAMES). The API token must
> also **not** end up in the config file: use the `CLOUDFLARE_API_TOKEN`
> environment variable (step 5) and **leave the token prompt empty**.

---

## 4. Build the project

```sh
npm install
npm run build
```

---

## 5. Run the installer

Set the token via the environment (so it is **not** saved to disk) and start:

```sh
export CLOUDFLARE_API_TOKEN="YOUR_TOKEN_HERE"

npx staticlayer init
```

The wizard will ask (interactively):

| Prompt | What to enter |
| --- | --- |
| `Cloudflare account ID` | The Account ID from step 1 |
| `Cloudflare API token (kept in memory, not written to disk)` | **Leave EMPTY and press Enter** — the token is read from `CLOUDFLARE_API_TOKEN` |
| `Worker name` | `staticlayer` (or a name you prefer) |
| `D1 database name` | `staticlayer` (or a name you prefer) |
| `Bind the 3 secrets ...?` | `y` (yes) |

> ⚠️ **Important:** if you type the token into the prompt, the CLI saves it
> inside `staticlayer.config.json`. To keep the token off disk, leave the
> prompt empty and use `CLOUDFLARE_API_TOKEN`.

What happens: the CLI **observes** the current state of your account,
**plans** the missing actions (creates the D1 if absent, deploys the Worker,
binds the 3 secrets via the Bulk Secrets API), **applies**, then **verifies**
that the desired state was reached. If anything is off, it fails and tells you
exactly what.

At the end you should see:

```
✔ init complete — desired state verified.
```

---

## 6. Apply the database migrations (D1)

The CLI creates the D1 database, but the **tables** must be created with the
migrations.

1. Find the ID of the database just created:

   ```sh
   npx wrangler d1 list
   ```

2. Copy the ID of the database named `staticlayer` and put it in **`wrangler.jsonc`**
   under `d1_databases[0].database_id` (replacing `REPLACE_WITH_D1_DATABASE_ID`).

3. Apply the migrations **to the remote database**:

   ```sh
   npx wrangler d1 migrations apply staticlayer --remote -c wrangler.jsonc
   ```

   (alternatively run the files one by one: `npx wrangler d1 execute staticlayer
   --remote --file migrations/001_initial.sql`, and the same for
   `002_admin_queue.sql`).

---

## 7. Connect the Worker to your domain (route)

The Worker is deployed but has no public address yet. Pick an option:

**Option A — Workers Routes (recommended, no DNS changes):**
1. Dashboard → **Workers & Pages** → `staticlayer` → **Settings → Domains & Routes**.
2. **Add route**, e.g. `yourdomain.com/*` → Worker `staticlayer`.
3. Your static site can stay on any host; comments are served from the route.

**Option B — Custom domain (great for a site on Cloudflare Pages):**
1. Same panel → **Add → Custom Domain** → `comments.yourdomain.com`.

**Option C — Quick workers.dev test (not recommended for production):**
1. In `wrangler.jsonc` set `"workers_dev": true` and redeploy with
   `npx wrangler deploy -c wrangler.jsonc` (note: this overwrites the CLI's
   deploy; for secrets use the steps below or `staticlayer repair`).

> Note: the CLI deploys the Worker via API without routes; the dashboard panel
> is the right place to manage them.

---

## 8. Add the widget to your static page

In your HTML, before the closing `</body>`:

```html
<script src="https://comments.yourdomain.com/widget.js"
        data-staticlayer
        data-api="https://comments.yourdomain.com"
        data-article-id="/your-article"
        data-host-context="yourdomain.com"></script>
```

- `data-api` (alias of `data-endpoint`) = your Worker base URL.
- `data-article-id` (alias of `data-article-path`) = the page path; comments are
  separate per page. Defaults to `window.location.pathname` when omitted.
- `data-host-context` = your domain.
- The widget also loads `pow-worker.js` (resolved automatically).
- Alternative API: `window.StaticLayer.mount(el, { endpoint, articlePath })`.

---

## 8b. Configure CORS (allowed origins)

If your static site and the Worker are on **different origins** (e.g. site on
GitHub Pages, Worker on `comments.yourdomain.com`), the Worker must allow your
site origin. Edit the `ALLOWED_ORIGINS` var in `wrangler.jsonc`:

```jsonc
"vars": {
  "ALLOWED_ORIGINS": "https://your-site.example,https://www.your-site.example"
}
```

Then redeploy with `npx wrangler deploy -c wrangler.jsonc` (or
`npx staticlayer repair` if you deployed via the CLI). Fail-closed: empty list
= same-origin only, no cross-origin requests allowed.

---

## 9. Moderate comments (admin)

1. Open **https://comments.yourdomain.com/admin.html** (or `…/admin.html` on
   your route).
2. Sign in with `ADMIN_SECRET` (the one you generated in step 3).
3. Approve / delete pending comments.

> Lost `ADMIN_SECRET`? Rotate it (new value) with:
> `npx wrangler secret put ADMIN_SECRET -c wrangler.jsonc`

---

## 10. Final verification

- Check the health endpoint: `curl https://comments.yourdomain.com/api/health`
  → `{"name":"staticlayer","status":"ok","version":"…","schemaVersion":2}`.
- Post a comment from your site → "Solving proof-of-work…" → it enters
  moderation.
- Approve it from `/admin.html` → it becomes visible.
- Check state with:

  ```sh
  npx staticlayer status    # must report "State matches the desired state"
  ```

---

## Alternative — Web Installer (OAuth)

Prefer a no-terminal wizard? Register an **OAuth client** in your Cloudflare
account (**Manage Account → OAuth clients**) with the minimal scopes
`account.read`, `workers-platform.write`, `d1.write` (see
`docs/oauth-scopes.md`), then run `npm run dev:installer` and follow the wizard
at **http://localhost:8788**. Secrets are generated server-side and bound to
the Worker via the Bulk Secrets API — **never shown** to the user.

---

## Troubleshooting

| Problem | Solution |
| --- | --- |
| `Error: missing Cloudflare API token` | Export `CLOUDFLARE_API_TOKEN` (an empty prompt is not enough) |
| `verify failed: …` | The CLI detected the state doesn't match: run `npx staticlayer repair` |
| Comment won't publish | It's in moderation: approve it from `/admin.html` |
| Widget doesn't load | Check the route/domain from step 7 and CORS (same domain recommended) |
| Migrations not applied | Re-run step 6 |
