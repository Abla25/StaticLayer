# Changelog

All notable changes to StaticLayer are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/).

> **Status note:** `v1.0.0-beta.1` is an honest beta. The core invariants are
> tested (127 tests), but remote-D1 concurrency and a clean-room install on a
> fresh environment are documented as pending in
> [`docs/release-checklist.md`](docs/release-checklist.md). Do not treat this
> release as production-ready on that basis alone.

## [Unreleased]

### Added
- **Comments and reactions are now fully separable** — the widget supports
  three modes: comments only (default), comments + reactions
  (<code>data-reactions</code>), and a standalone reactions bar
  (<code>data-reactions-only</code>, or <code>mount(el, { reactionsOnly: true })</code>).
  Each host element is independent, so reactions and comments can live in
  different places on the same page with one <code>widget.js</code>.
  Tests: <code>tests/security/widget-reactions.test.ts</code>. The public demo
  (<code>apps/demo</code>) and the site simulator now showcase reactions and
  the reactions-only mode.
- **Reactions (anonymous, PoW-protected)** — `data-reactions="👍,❤️,🎉"` on the
  widget shows a fully themeable reaction bar. Every reaction solves a
  single-use Proof-of-Work; difficulty escalates per article
  (`REACTION_DIFFICULTY_BASE/CEILING`, `REACTION_ESCALATION_VOTES`), per-article
  rate limiting and a minimum interval apply, and rows are anonymous events
  (article, reaction, timestamp — no IP, no user id). Customizable via
  `REACTION_OPTIONS` and friends. Migration `003_reactions.sql`; endpoints
  `GET/POST /api/reactions`, `GET /api/reactions/challenge`;
  admin articles overview now includes reaction counts.
  Tests: `tests/security/reactions.test.ts`, `tests/security/widget-reactions.test.ts`.

- **CORS allowlist (Phase F)** — `packages/runtime/src/cors.ts`: explicit
  `ALLOWED_ORIGINS` var (comma-separated), fail-closed (empty = same-origin
  only), per-origin echo, never `*`, OPTIONS preflight for API/admin routes.
  `tests/security/cors-health.test.ts`.
- **Widget aliases + programmatic API (Phase F)** — `data-api` (alias of
  `data-endpoint`), `data-article-id` (alias of `data-article-path`, defaults
  to `location.pathname`), and `window.StaticLayer.mount/unmount`.
  `tests/security/widget-api.test.ts`.
- **Health endpoint (Phase F)** — `GET /api/health` (and `GET /`) returns
  runtime version + schema version (`packages/runtime/src/version.ts`).
- **Admin "Pages with comments" overview** — `GET /api/admin/articles` groups
  comments per article path (total / pending / approved); the admin console
  shows the panel and a page chip on every queue item
  (`packages/runtime/src/admin-comments.ts`, `static/admin.html|js`,
  `tests/security/admin-articles.test.ts`). The site demo teaches the same
  concept (visitors see only their page; admins see all pages).
- **Examples (Phase E)** — `examples/` with vanilla, Astro, Hugo, Jekyll,
  Next.js static-export reference implementations + `docs/installation/universal.md`.
- **Release audit (Phase G)** — `PUBLIC_RELEASE_AUDIT.md` (claims → evidence,
  pending items, release gate) + `docs/clean-room-checklist.md`.

### Changed

- **ADMIN_SECRET shown once to the operator (Round 21.2).** Before, the wizard
  generated secrets and never returned them, so a person installing via the
  hosted installer could not sign in to their own `/admin.html`. Now a real
  (non-dry-run) deploy returns `adminSecret` **exactly once** — the step-4
  screen shows it with a copy button and a "save it now" warning.
  `SESSION_SECRET`/`POW_SECRET` remain never returned. Tests + security docs
  (SECURITY_REVIEW I16, SECURITY_AUDIT_REPORT, oauth-scopes, universal,
  PUBLIC_RELEASE_AUDIT, DEPLOY_TO_REAL_CLOUDFLARE) updated; the
  "cannot recover ADMIN_SECRET" residual risk is resolved.
- **Hosted-installer iframe is now seamless (Round 21.2).** The wizard reports
  its content height to the host page via `postMessage` (`source:
  'staticlayer-installer'`); the site's `main.js` resizes the iframe, so there
  is no internal scrollbar and it looks fully integrated. Fallback height 760px
  + `scrolling="no"`.
- **License: MIT → Elastic License 2.0 (Round 21).** The project is now
  **source-available**: anyone can read, modify, self-host and contribute, but
  may **not** resell the software or offer it to third parties as a
  hosted/managed service. The owner retains the right to sell or grant
  commercial licenses and to decide the licensing of future releases (ELv2
  never auto-converts to a permissive license). All references (README,
  site footer, FAQ, index, og-image, CONTRIBUTING, SECURITY.md, demo and
  installer footers) updated from "MIT / open source" to ELv2 wording.
  **New `TERMS.md`** — terms of use, disclaimer & liability (AS-IS, no
  warranty, no liability, BYOC responsibility, moderation/security/compliance
  on the operator, third-party Cloudflare disclaimer, no SLA, not legal
  advice).
- **Hosted installer embed (Round 21).** The installer wizard now supports an
  **embed mode** (`?embed=1` or when loaded in an iframe): the site chrome
  (nav + footer) is hidden so only the wizard shows. The site's install page
  now embeds the live hosted installer in a styled iframe
  (`staticlayer-installer.staticlayer.workers.dev/?embed=1`), with a
  full-screen link.
- **Site polish (Round 21).** Copy updated to match reality: "Start →" instead
  of "Continue" in the installer steps, hosted installer promoted from
  "roadmap" to live (FAQ), new FAQ entries for admin login/security, optional
  Cloudflare Access SSO, and the update model (BYOC = you redeploy; site/docs/
  hosted installer update automatically). Meta description + keywords +
  kicker aligned to "source-available".
- **Magic-link sign-in removed (Round 20).** The email path
  (`/api/auth/request` + `/api/auth/verify`, `createMagicToken`/
  `verifyMagicToken`, wizard email UI) is gone: no SMTP transport was wired, so
  "send magic link" silently did nothing. The anonymous **Start →** session
  (identity = the Cloudflare OAuth consent or a pasted token) is now the only
  entry point. Endpoints return 404; tests updated (5 removed).
- **Hardening headers on every runtime response (Round 20).** All API JSON
  responses and static assets now send `x-content-type-options: nosniff`,
  `referrer-policy: no-referrer`, `x-frame-options: DENY`,
  `permissions-policy: camera=(), microphone=(), geolocation=()` (admin.html
  also keeps its CSP). Verified live on
  `staticlayer-comments.staticlayer.workers.dev`.
- **Rebrand: PureComment → StaticLayer.** Project name, package scope
  (`@staticlayer/*`), CLI, environment variables (`STATICLAYER_*`), worker/D1
  names, docs, tests, README and website — all renamed. Widget CSS prefix
  `pc-` → `sl-`. HMAC test vectors regenerated independently
  (`scripts/gen-vectors.py`).
- **Public website (`apps/site`) redesigned** — new premium design system
  (warm paper + ink, signal-orange gradient, layered depth, glass surfaces),
  new StaticLayer brand mark, redesigned hero with a live widget mockup in a
  browser frame, numbered sections, security scorecard, and new OG image
  (`og-image.png`).
- **Interactive demo upgraded** — visible published-comment thread with seeded
  comments, live graphic-theme picker (Classic / Ink / Glass / Ocean / Sunset)
  that restyles the widget and updates the embed snippet, inline admin
  approval, real Proof-of-Work timeline and technical log.
- **Interactive homepage hero** — the hero widget now accepts real comments
  with a real (low-difficulty) Proof-of-Work (`apps/site/src/scripts/hero-widget.js`).
- **Admin console in the demo** — visitor/admin tabs with login, a shared
  moderation queue (approve/delete) and a published list, plus a "what visitors
  can write" content-rules card.
- **Docs expanded** — installer flow step-by-step, per-page threads, managing
  comments, and new FAQ items (SEO, anti-bot, multiple comments, customization,
  per-page opt-in, zero-terminal installer roadmap).

## [v1.0.0-beta.1] — 2026-08-26

### Added

- **Protocol (`@staticlayer/protocol`)** — canonical binary Proof-of-Work
  encoding: explicit endianness, explicit byte lengths, strict UTF-8, signed
  challenge (HMAC-SHA256), nonce (uint64), leading-zero-bit verification.
  Independent Python vector generator (`scripts/gen-vectors.py`).
- **Runtime (`@staticlayer/runtime`)** — Cloudflare Worker + D1:
  - public API: `GET /api/comments`, `GET /api/comments/challenge`,
    `POST /api/comments`;
  - atomic anti-replay (D1 `batch()` + `INSERT OR IGNORE` + conditional
    insert) — exactly one acceptance under concurrency;
  - admin API (login, session, CSRF, moderation approve/delete);
  - static assets (`/widget.js`, `/pow-worker.js`, `/admin.html`, `/admin.js`);
  - daily retention cron (`used_challenges` > 24 h).
- **Widget (`@staticlayer/widget`)** — vanilla JS, zero tracking, `textContent`
  only, PoW in a Web Worker, premium/minimal UI, automatic dark mode.
- **Deployment core (`@staticlayer/deployment-core`)** — library-first Desired
  State Engine (observe → plan → apply → verify), Cloudflare API client with
  the Bulk Secrets API, worker bundler, in-memory test mock.
- **CLI (`@staticlayer/cli`)** — `staticlayer init|status|repair`; API token
  never persisted to disk.
- **Web Installer (`@staticlayer/installer`)** — OAuth (Authorization Code,
  least-privilege scopes), anonymous start, DSE deploys; secrets generated
  server-side and **never shown** to the user.
- **Demo (`@staticlayer/demo`)** — public sandbox with daily data purge.

### Security

- 127 automated tests (16 files): anti-replay concurrency, CSRF, XSS, retention,
  no-IP-persistence structural checks, deploy engine, OAuth least privilege,
  session cookies.
- `SECURITY_REVIEW.md`, `SECURITY_AUDIT_REPORT.md`, `THREAT_MODEL.md`,
  `SECURITY.md`, `docs/cloudflare-assumptions.md` (verified, dated).
- Privacy wording: **No application-level IP persistence**; the public widget
  uses no tracking cookies/localStorage/fingerprinting.

### Known limitations

- PoW is an anti-spam cost, not "spam-proof".
- Rate limiting is edge-local and eventually consistent.
- Remote D1 concurrency validation pending (`wrangler dev --remote`).
- Exact OAuth scope ID for D1 (`d1.write`) to be confirmed at client
  registration via `GET /oauth/scopes`.
