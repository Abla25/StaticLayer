# 🗨️ StaticLayer

**Comments for static sites — without the comment SaaS.**

StaticLayer is a source-available, Cloudflare-native comment system designed for static websites. Your Worker. Your database. No centralized comment platform.

> **🌐 [Website](https://Abla25.github.io/StaticLayer/)** · **[Try the interactive demo](https://Abla25.github.io/StaticLayer/demo.html)** · **[Docs](https://Abla25.github.io/StaticLayer/docs.html)** · **[Security](SECURITY.md)** · **[Install guide](DEPLOY_TO_REAL_CLOUDFLARE.md)** · **[GitHub](https://github.com/Abla25/StaticLayer)**

---

## Quick links

| | |
| --- | --- |
| **Product** | Source-available, BYOC comment system running entirely in *your* Cloudflare account (Worker + D1) |
| **Demo / simulator** | `apps/site` — static website + interactive client-side simulator (`npm run build:site`) |
| **Install** | [DEPLOY_TO_REAL_CLOUDFLARE.md](DEPLOY_TO_REAL_CLOUDFLARE.md) · [docs/installation/universal.md](docs/installation/universal.md) · [docs.html](apps/site/src/pages/docs.html) |
| **Examples** | [examples/](examples/README.md) — vanilla, Astro, Hugo, Jekyll, Next.js static |
| **Security** | [SECURITY.md](SECURITY.md) · [THREAT_MODEL.md](THREAT_MODEL.md) · [SECURITY_REVIEW.md](SECURITY_REVIEW.md) · [SECURITY_AUDIT_REPORT.md](SECURITY_AUDIT_REPORT.md) |
| **Release audit** | [PUBLIC_RELEASE_AUDIT.md](PUBLIC_RELEASE_AUDIT.md) · [docs/clean-room-checklist.md](docs/clean-room-checklist.md) |
| **Privacy** | [docs/PRIVACY_POLICY_TEMPLATE.md](docs/PRIVACY_POLICY_TEMPLATE.md) · [privacy.html](apps/site/src/pages/privacy.html) |

[![License: Elastic 2.0](https://img.shields.io/badge/license-Elastic%202.0-orange.svg)](LICENSE)

---

## How it compares

> Structural comparison only — not a legal or marketing claim about Disqus's
> current terms. Verify Disqus's own privacy policy and pricing before you
> make representations to your users.

| | **Disqus** | **StaticLayer** |
| --- | --- | --- |
| **Where your data lives** | Disqus-operated servers (a third-party comment SaaS) | **Your Cloudflare account** (Worker + D1) |
| **Cookies / tracking** | Uses cookies and analytics on its free tier (see their current policy) | **No cookies, no fingerprinting, no analytics** from the widget |
| **Personal data handled** | Processed by Disqus under their DPA/terms | Minimal: nickname + plain-text comment + timestamp; **no IP persistence** |
| **Cost** | Free (ad-supported) and paid tiers | **Cloudflare free tier** (Worker + D1) |
| **License / lock-in** | Proprietary | **Source-available (Elastic License 2.0)**, deterministic protocol |
| **Spam protection** | CAPTCHA / ML on their side | **Client-side Proof-of-Work** + honeypot + time gate — no CAPTCHA, no friction, zero data |

**TL;DR:** Disqus is a centralized third-party comment SaaS. StaticLayer keeps the entire comment system inside your own Cloudflare account.

---

## ✨ Features

- 🪙 **Proof-of-Work anti-spam** — visitors solve a tiny client-side puzzle; no CAPTCHA, no forms of friction.
- 🧲 **Zero-data anti-spam** — hidden **honeypot** field (bots get silently dropped) + a 3-second **time gate** on challenge submissions (429 on too-fast posts). Pure behavioural checks: no content reading, no storage, no personal data.
- 🛡️ **Anti-replay by design** — a solved challenge can never be reused, even under concurrent races (proven by tests).
- 🧑‍💼 **Moderation queue** — new comments are `pending` until an admin approves them.
- 🔒 **XSS-safe** — comments are **plain text only** (no Markdown, no HTML). Rendered exclusively with `textContent`.
- 🔐 **CSRF-safe admin** — session-bound, constant-time-verified tokens.
- 🕵️ **No tracking** — the public widget sets no cookies and stores nothing in the browser.
- 🔁 **Idempotent, verifiable deploys** — a Desired State Engine observes → plans → applies → verifies. It never fails silently.
- 🔔 **Telegram alerts (optional)** — get a private notification when a comment awaits moderation; GDPR-minimal (no comment data in the message), configured from the admin panel.
- 🗳️ **Polls** — StrawPoll-style, privacy-first (no IP, no cookies), PoW-protected votes; optional anonymous **one-vote-per-browser** guard, optional **multi-select** (pick several options, one PoW), ranked results with leader + total-votes chip, and **Change your votes** on guarded multi polls. Created & managed from the admin.
- 🧵 **Nested replies** — up to 3 levels, with "Reply" inline, moderator-aware (pending parents hide the thread; deleted parents keep replies with a placeholder).
- 🧑‍💻 **Owner replies** — answer comments right from the admin console; your replies are approved instantly and shown with an **Author** badge (owner nickname is configurable in Settings).
- 🧩 **Drop-in widget** — a few lines of HTML on any static site (Astro, Hugo, Jekyll, plain HTML…).
- 🗂️ **Comment layout (v1.5)** — a unified **"Start the conversation"** card (empty message + form) and `data-reactions-position="top|bottom"` to place the whole reactions bar together, above or below the comments.

---

## 🚀 Install in 3 steps

### 1. Create an API token (Cloudflare dashboard)

**My Profile → API Tokens → Create Token** with account permissions:
**Workers Scripts: Edit**, **Cloudflare D1: Edit**, **Account Settings Read**.

Grab your **Account ID** from the same dashboard.

### 2. Generate secrets & run the installer

```sh
npm install
npm run build

export CLOUDFLARE_API_TOKEN="<your token>"          # never stored on disk
export STATICLAYER_ADMIN_SECRET="$(openssl rand -hex 32)"
export STATICLAYER_SESSION_SECRET="$(openssl rand -hex 32)"
export STATICLAYER_POW_SECRET="$(openssl rand -hex 32)"

npx staticlayer init    # observe → plan → apply → verify
```

The CLI creates the D1 database, deploys the Worker, binds the 3 secrets via the
**Bulk Secrets API**, then **verifies** the desired state. Apply the schema:

```sh
npx wrangler d1 migrations apply staticlayer --remote -c wrangler.jsonc
```

> 📖 Full step-by-step (routes, custom domain, widget snippet, admin login):
> **[DEPLOY_TO_REAL_CLOUDFLARE.md](DEPLOY_TO_REAL_CLOUDFLARE.md)**

### 3. Add the snippet to your page

```html
<script src="https://comments.yourdomain.com/widget.js"
        data-staticlayer
        data-endpoint="https://comments.yourdomain.com"
        data-article-path="/your-article"
        data-host-context="yourdomain.com"></script>
```

Done. Moderate comments at `https://comments.yourdomain.com/admin.html`.

> 🔔 **Telegram alerts (optional):** in the admin → **Settings** → **Telegram alerts**, set
> Alerts = On, paste a bot token (create it with **@BotFather** in Telegram) and your chat id
> (see `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`), then **Save settings**. When a
> comment awaits moderation you get a private message with a link to the queue — the message
> contains **no comment data** (privacy-first).

---

## 🗳️ Polls (optional)

Create StrawPoll-style polls from the admin (**Polls** tab): article path, question, 2–10
options, and optional **one vote per browser** / **multi-select** toggles. Then embed on any page:

```html
<div data-staticlayer
     data-endpoint="https://comments.yourdomain.com"
     data-poll-id="<poll id from the admin>"></div>
<script src="https://comments.yourdomain.com/widget.js" defer></script>
```

Votes are anonymous (no IP, no cookies), protected by the same Proof-of-Work + atomic
anti-replay as comments, and results are shown as a **ranking** (highest first, #1/#2
badges) with the **leader highlighted**, a **"Leads by N votes"** gap line and a
**total-votes chip** in the heading. With the single-vote guard, the server issues an
**anonymous** token that lives only in the visitor's browser (localStorage) and stores
only a hash of it — so a returning visitor cannot vote twice, and no personal data ever
leaves the device.

**Multi-select:** visitors pick several options and cast **one vote (a single
Proof-of-Work)** for the whole set; every chosen option gets +1. On guarded multi polls
they can also **"Change your votes"** — revoking their own previous anonymous votes
(no new data stored).

**Global polls:** leave the article path empty when creating a poll and it appears on **any**
page where you embed its id. Optional display: `data-poll-style="bars|percent|counts|minimal"`
and `data-poll-results="after|always"`.

> Honest limitation: without an identity, "one vote = one person" cannot be guaranteed for
> visitors who clear their browser storage — the same trade-off every anonymous poll (StrawPoll
> included) accepts.

## 🧵 Nested replies

Comments support replies up to **3 levels** (comment → reply → reply). Click **Reply** on any
comment: the same PoW + moderation pipeline applies. Moderation rules:

- A reply is visible only when **it and its parent** are approved.
- If a parent is deleted, its replies stay visible with a *"parent comment removed"* placeholder.
- The admin queue shows a **"↳ reply to …"** badge so you can moderate threads in context.

**Owner replies:** from the admin queue or published list, press **Reply** and answer as the
site owner — the reply is approved immediately and shown with an **Author** badge. Set the
owner nickname in **Settings → Owner nickname** (default "Site owner").

> 🧙 No terminal? The **Web Installer** (`npm run dev:installer`) guides you
> through the same deploy with OAuth — scopes are least-privilege by design
> ([`docs/oauth-scopes.md`](docs/oauth-scopes.md)).

---

## 🧠 How it works

```
Visitor browser                Your Cloudflare account
┌──────────────────┐          ┌──────────────────────────────────────┐
│ widget.js        │  POST    │ StaticLayer Worker                    │
│ + PoW Web Worker │ ───────► │  verify PoW → atomic anti-replay      │
│ (solves puzzle)  │          │  → store as 'pending'                 │
└──────────────────┘          │  D1 (SQLite): comments, challenges   │
                              └──────────────────────────────────────┘
```

1. The widget asks the Worker for a **signed challenge** (bound to your host + article).
2. A Web Worker in the visitor's browser solves a **Proof-of-Work** puzzle.
3. The Worker verifies the proof, **atomically consumes the challenge** (D1 `batch()`),
   and stores the comment as **pending**.
4. An admin approves it from `/admin.html` — then it becomes public.

The runtime never calls any StaticLayer server. **Your data never leaves your account.**

---

## 🪄 Zero-data anti-spam

Two behavioural layers **on top of the PoW**, both designed to never read, store or
persist any content or personal data (GDPR-neutral by default):

1. **Honeypot** — the widget renders a hidden field that real humans never see but
   naive bots love to fill. If it arrives filled, the server **silently drops** the
   submission and answers with a *plausible fake "pending"* — the bot learns nothing,
   and nothing is stored or consumed. 0 data.
2. **Time gate (3s)** — a human takes seconds to type a comment; a scripted bot can
   solve the puzzle and POST in milliseconds. The server rejects any submission
   arriving **sooner than 3 seconds after the challenge was issued** with `429`. The
   issue time is recovered from the **signed** challenge (`expiresAt − TTL`), so the
   server keeps **zero state** for the check. The widget waits the gate client-side,
   so real users never notice it.

Already in place: **Proof-of-Work** (cost-based integrity), **atomic anti-replay**,
**edge rate limiting** (`RATE_LIMITER`) and **human moderation**. Content heuristics
and duplicate-content hashing are deliberately **not** enabled by default — they would
require reading the comment text, against the project's zero-data principle.

---

## 🔐 Security

Security is a first-class feature, not an afterthought — **123 tests, all invariants
proven empirically** (anti-replay concurrency, XSS, CSRF, retention, no-IP-persistence).

| Invariant | Guarantee |
| --- | --- |
| Challenge single-use | Exactly 1 of N concurrent requests with the same challenge is accepted |
| XSS | Plain text only; `textContent` rendering; strict UTF-8 |
| CSRF | Session-bound, constant-time double-submit on all admin mutations |
| No app-level IP persistence | The application DB stores no IP addresses |
| Zero-data anti-spam | Honeypot + time gate never read, store or persist content (behavioural only) |
| Never fail silently | The deploy engine re-verifies the live state after every apply |

> 📄 [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) (threat model + evidence) ·
> [`SECURITY_AUDIT_REPORT.md`](SECURITY_AUDIT_REPORT.md) (claim-by-claim matrix) ·
> [`docs/cloudflare-assumptions.md`](docs/cloudflare-assumptions.md) (every Cloudflare fact verified against official docs).

---

## 🧪 Try it locally

```sh
npm run dev:demo        # public demo on http://localhost:8787
npm run dev:installer   # web installer wizard on http://localhost:8788
```

Walk through the whole product like a real user — including PoW, XSS and
moderation — with the checklist in **[HOW_TO_TEST_MANUALLY.md](HOW_TO_TEST_MANUALLY.md)**.

---

## 📁 Project layout

```
packages/protocol         canonical binary PoW protocol (encoding, challenge signing, verification)
packages/runtime          the Cloudflare Worker + D1 (public API, moderation, admin, cron)
packages/widget           public widget + PoW Web Worker (vanilla JS)
packages/deployment-core  library-first Desired State Engine + Cloudflare API client
packages/cli              CLI shell (init / status / repair)
apps/installer            Web Installer (OAuth + DSE deploy + wizard)
apps/demo                 public demo worker (data purged daily)
migrations/               D1 SQL migrations
tests/security            anti-replay, CSRF, XSS, retention, no-IP-persistence
docs/                     verified assumptions, OAuth scopes, privacy template
```

## 🔧 Commands

```sh
npm install            # link workspaces
npm run build          # protocol → widget → static assets → CLI → installer
npm test               # full suite (123 tests)
npm run typecheck
npm run dev:demo       # local public demo (port 8787)
npm run dev:installer  # local web installer (port 8788)
npm run test:installer # OAuth least-privilege + deploy engine tests
npm run test:demo      # demo daily-purge tests
```

---

## 📚 Documentation

- **[MASTER_HANDOFF.md](MASTER_HANDOFF.md)** — single source of truth: architecture, invariants, decisions
- **[DEPLOY_TO_REAL_CLOUDFLARE.md](DEPLOY_TO_REAL_CLOUDFLARE.md)** — real deploy guide
- **[HOW_TO_TEST_MANUALLY.md](HOW_TO_TEST_MANUALLY.md)** — manual validation checklist
- **[docs/PRIVACY_POLICY_TEMPLATE.md](docs/PRIVACY_POLICY_TEMPLATE.md)** — privacy-policy template for your site

## 📄 License, terms & business model

- **Source-available, not OSI "open source".** The code is public under the
  [Elastic License 2.0](LICENSE) (ELv2): anyone can read, modify, self-host and
  contribute, but **may not** resell it or offer it to third parties as a
  hosted/managed service. This keeps StaticLayer free to self-host while
  protecting the owner's right to sell or license it commercially.
- **Owner rights.** The copyright holder retains the right to (a) sell or
  license the software commercially, (b) grant custom licenses, and (c) decide
  the licensing of future releases — ELv2 never auto-converts to a permissive
  license, so the source can stay closed for future versions if ever needed.
- **Premium features** may ship in a separate package/repo under their own
  (proprietary) license — multi-site dashboard, advanced moderation, polls &
  votes, white-labeling, hosted installer, etc. The self-hosted core keeps
  working without them.
- **No warranty, no liability.** See [TERMS.md](TERMS.md): the software is
  provided "AS IS". You operate it on **your own Cloudflare account** (BYOC)
  and remain responsible for your content, your infrastructure, your security
  configuration and your legal compliance.
