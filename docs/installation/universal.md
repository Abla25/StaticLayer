# Universal installation

This guide works for any site. Framework-specific notes live in
[`examples/`](../../examples/README.md).

## Two ways to install

- **Fast installer (browser, OAuth)** — sign in with Cloudflare, pick your
  account, and the installer creates the Worker, the D1 database and the three
  secrets for you. No tokens stored on disk. Start it locally:

  ```bash
  npm run dev:installer   # → http://localhost:8788
  ```

- **CLI** — `npx staticlayer init` with an API token. More control, still fully
  scripted.

Both paths produce the same desired state: **Worker + D1 + three secrets**
(`ADMIN_SECRET`, `SESSION_SECRET`, `POW_SECRET`) + rate-limit binding. Secrets
are generated locally and sent straight to Cloudflare via the Bulk Secrets API.
The **admin password (`ADMIN_SECRET`) is shown exactly once** after the deploy
— save it to sign in to `/admin.html`. The other secrets are never shown and
nothing is stored on disk.

## 1 · Deploy the Worker

Run `npx staticlayer init`. The CLI creates the D1 database, deploys the Worker
and binds the secrets, then verifies the desired state.

## 2 · Create & bind D1

Handled automatically by the CLI. Apply the schema migrations to the remote
database:

```bash
npx wrangler d1 migrations apply staticlayer --remote -c wrangler.jsonc
```

## 3 · Configure secrets

Exactly three secrets: `ADMIN_SECRET`, `SESSION_SECRET`, `POW_SECRET`.

## 4 · Configure the allowed origin (CORS)

When your site and the Worker are on different origins, add your site origin(s)
to the `ALLOWED_ORIGINS` var (comma-separated), e.g.
`"https://blog.example.com,https://www.example.com"`. Empty = same-origin only
(fail-closed). No wildcard.

## 5 · Add the widget

```html
<div data-staticlayer
     data-api="https://comments.example.com"
     data-article-id="/blog/my-post"></div>
<script src="https://comments.example.com/widget.js" defer></script>
```

`data-article-id` (alias: `data-article-path`) defaults to
`window.location.pathname` when omitted.

## 6 · Choose the article ID

- **Automatic:** `articleId = window.location.pathname` — one thread per URL.
- **Explicit:** `data-article-id="post-123"` — for client-side routing,
  translated sites, URL migrations and aliases.

Each unique article ID gets its own moderated thread.

## 7 · Open the admin

Visit `https://comments.example.com/admin.html`, sign in with `ADMIN_SECRET`.
The console shows one moderation queue for all articles: approve or delete
pending comments. Approved comments appear on their article immediately.

## 8 · Test a comment

Post from your site: the browser solves a proof-of-work, the comment enters
moderation, and you approve it from the admin. Comments are plain text + emoji
only — no HTML, no Markdown, no clickable links.

## 9 · Deploy the website

Deploy your static site as usual. No build-time integration is required — the
widget loads at runtime.
