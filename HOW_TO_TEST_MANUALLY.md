# HOW TO TEST MANUALLY — StaticLayer

> Step-by-step checklist to validate StaticLayer **locally** the way a real,
> non-technical user would. No Cloudflare knowledge required for the local demo.
>
> Requirements: **Node.js ≥ 20** and **npm** on your machine.

---

## ⚙️ Step 0 — One-time setup

Open a terminal in the project folder and run:

```sh
npm install
npm run build
```

You should see the bundles build without errors.

---

## 🖥️ Part A — The public demo (fully local, no sign-up)

### A1. Start the demo

```sh
npm run dev:demo
```

Wait for the message **`Ready on http://localhost:8787`**.

### A2. Open the demo page

Open your browser at: **http://localhost:8787**

What you should see:

- ✅ The **"PUBLIC DEMO — all data is purged every night"** banner
- ✅ The **"Try it yourself ✨"** hero card
- ✅ The **Comments** card with the welcome comment by "StaticLayer" (with emoji 👋)

> 💡 If the welcome comment is missing, press **Enter** in the wrangler
> terminal, then in a second terminal run:
> `curl -X POST http://localhost:8787/cdn-cgi/local/scheduled`
> (this is the "daily cron" run manually).

### A3. Verify the Proof-of-Work (anti-spam)

1. In the comment form, enter:
   - **Name**: `Tester`
   - **Comment**: `Hello, this is my first comment!`
2. Click **Post comment**.
3. You should see **"Solving proof-of-work…"** with a spinner — this is the
   PoW running in your browser. Wait a few seconds.
4. Then a confirmation appears: **"✓ Comment submitted — awaiting moderation."**
   The comment is NOT visible yet (moderation queue).

**What you just verified:** the browser solved a cryptographic puzzle before
submitting — the anti-spam mechanism (costly for spammers, nearly free for
real users).

### A4. Verify admin moderation

1. Open a second tab at: **http://localhost:8787/admin.html**
2. Sign in with the local admin password — the `ADMIN_SECRET` value inside
   **`apps/demo/.dev.vars`**, i.e. (local demo only):
   `demo-admin-secret-0123456789abcdef`
3. You'll see the **Moderation queue** with your pending comment
   "Hello, this is my first comment!".
4. Click **Approve**.
5. Back on the demo page (http://localhost:8787), reload (Cmd+R).
6. ✅ "Tester"'s comment is now public.

**What you just verified:** moderation works — no comment is published without
an administrator's approval.

### A5. Verify XSS safety (comments do NOT execute HTML)

1. Post a new comment with this **exact** text (copy-paste):

   ```html
   <script>alert("xss")</script>
   ```

2. Approve it from the admin page (as in A4).
3. Reload the demo page.
4. ✅ **No alert popup** appears.
5. ✅ The text is shown **as-is**, as plain text:
   `<script>alert("xss")</script>`

**What you just verified:** comments are **plain text** — HTML and JavaScript
are neutralized (XSS invariant). If you saw a popup or an image, that would be
a bug — please report it.

> Bonus: repeat with `"><img src=x onerror=alert(1)>` — it must stay inert text.

### A6. Verify the daily purge (privacy)

1. After publishing a few comments, run in the terminal:

   ```sh
   curl -X POST http://localhost:8787/cdn-cgi/local/scheduled
   ```

2. Reload the demo page (Cmd+R).
3. ✅ **All comments are gone**, except the welcome comment.

**What you just verified:** the demo does not accumulate data — every night
(and here, manually) comments are deleted.

### A7. Try the anti-replay / double-submit (optional, curious minds)

Right after submitting, click **Post comment** again quickly with the same
text. The second submit is rejected (challenge already used) — this prevents
reusing the same proof for spam.

---

## 🧙 Part B — The Web Installer (local start)

> The full wizard (Cloudflare connection) requires a **real OAuth client**
> registered in your account (see `DEPLOY_TO_REAL_CLOUDFLARE.md`). Here we
> validate the startup and the sign-in flow.

### B1. Start the installer

In another terminal:

```sh
npm run dev:installer
```

Wait for: **`[installer] StaticLayer Web Installer on http://localhost:8788`**

### B2. Open the wizard

Open **http://localhost:8788**

- ✅ You'll see the "StaticLayer" brand and step 1.
- Click **Start →** — an anonymous session is created (no email).
  ✅ You're signed in and the wizard advances to "Connect Cloudflare".

### B3. Cloudflare connection (requires the real OAuth client)

The **"Connect with Cloudflare ↗"** button takes you to Cloudflare's consent
screen. To complete this step you must have registered an OAuth client with the
minimal scopes — full instructions in `DEPLOY_TO_REAL_CLOUDFLARE.md`
("Web Installer method") and `docs/oauth-scopes.md`.

> No OAuth client yet? You can still validate wizard steps 1–2 and the UI.
> For the real deploy, use the CLI (Part C).

---

## 🚀 Part C — Real deploy to YOUR Cloudflare account (CLI)

Follow the full guide in **`DEPLOY_TO_REAL_CLOUDFLARE.md`**. In short:

```sh
# 1. token + account (Cloudflare dashboard)  →  see the guide
# 2. generate the 3 secrets and pass them via env (never on disk)
export STATICLAYER_ADMIN_SECRET="$(openssl rand -hex 32)"
export STATICLAYER_SESSION_SECRET="$(openssl rand -hex 32)"
export STATICLAYER_POW_SECRET="$(openssl rand -hex 32)"

# 3. init (observe → plan → apply → verify)
npx staticlayer init
```

---

## ✅ Final checklist

| # | Check | Result |
| --- | --- | --- |
| 1 | `npm run dev:demo` → page on :8787 with PUBLIC DEMO banner | ☐ |
| 2 | Welcome comment visible | ☐ |
| 3 | Post comment → "Solving proof-of-work…" → confirmation (not visible) | ☐ |
| 4 | Admin on :8787/admin.html → Approve → comment visible | ☐ |
| 5 | Comment with `<script>` → no popup, literal text | ☐ |
| 6 | `curl …/scheduled` → all comments purged except welcome | ☐ |
| 7 | `npm run dev:installer` → wizard on :8788, anonymous Start → | ☐ |
| 8 | `npm run typecheck` and `npm test` green | ☐ |

---

## Common issues

- **Port busy (8787/8788)** → close the other instance or change the port.
- **PoW feels slow** → normal: the browser is computing. With
  `POW_DIFFICULTY=16` it takes ~1–3 seconds.
- **Comment doesn't appear after posting** → it's in moderation: approve it
  from the admin page.
- **Demo won't start** → make sure you ran `npm install` and `npm run build`.
