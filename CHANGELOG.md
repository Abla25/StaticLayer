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

### Brand & UI polish (site / admin / installers)
- **Brand icon** — the project icon (`assets/brand/staticlayer-icon.png`) now
  replaces the placeholder mark EVERYWHERE and is rendered **free** (no tile,
  no background, no border): site nav + footer + favicon + apple-touch-icon,
  the admin console (served at `/icon.png` by the Worker, base64-inlined), and
  the hosted + node installers. Accompanying "StaticLayer" text kept where it
  belongs.
- **Hero widget is now a compact carousel** — one feature at a time
  (Comments · Reactions · Polls) with ‹ › arrows, so the hero stays short
  instead of stacking everything; poll bars got roomier (inset track, more
  padding).
- **Docs sidebar unified** — the Quick start page now shows the same flat
  sidebar as every other docs page (no grouping).
- **Fix: hero skeleton** — the loading skeleton is shown only before the
  widget initializes and disappears once the live widget renders (the inline
  `display:flex` was overriding the `hidden` attribute).

### Site — v1.8 polish (home / docs / demo)
- **Home redesigned** — clearer hierarchy: hero headline "Comments, reactions &
  polls for static sites — inside your Cloudflare account", an interactive
  hero widget showing the FULL surface (comments with likes + pin + newest/best
  sort, anonymous reactions, a live mini-poll, posting with real PoW), an
  "in one glance" strip (Comments / Reactions / Polls) and dedicated product
  cards with animated mini-previews. Fewer, denser sections; the security
  scorecard is now one glass panel.
- **Docs reorganized** — sidebar grouped into Getting started / Features /
  Trust; new "How it works — technically" (widget → PoW → Worker → D1 flow
  diagram), "Why installation is easy" (hosted installer / CLI / manual) and
  feature cards linking to the dedicated pages.
- **Demo upgraded** — interactive mode selector: **All / Comments / Reactions /
  Polls**; comments now have anonymous likes, a live StrawPoll-style poll with
  ranked results + leader crown, per-mode embed snippets, mode-aware hints and
  technical log.
- **Design system polish** — skeleton loading in the hero, micro-interactions
  (heart pop, count-up ticks, animated poll bars, gradient shift, one-time
  hero entrance), reduced-motion respected, no overflow on mobile.

### Added
- **Password-less admin sign-in with GitHub OAuth (1.7.0)** — optional "Sign
  in with GitHub" in the admin console: no Cloudflare Zero Trust plan, no
  credit card, no password to remember. New Worker vars
  `GITHUB_CLIENT_ID`, `GITHUB_ADMIN_IDS` / `GITHUB_ADMIN_LOGINS` (allowlist)
  and secret `GITHUB_CLIENT_SECRET`; new endpoints
  `GET /api/admin/github` (status), `GET /api/admin/github/start` (302 to
  GitHub with a signed, 10-minute state cookie) and
  `GET /api/admin/github/callback` (state verification → code exchange →
  allowlist check → same stateless HMAC admin session). The GitHub token is
  used once to read the operator's id and discarded — never stored; no
  visitor data ever leaves the Worker. The password stays as a fallback.
  The admin console now shows a step-by-step setup guide (Settings → Admin
  access & sign-in) and the hosted installer accepts the GitHub Client ID /
  Secret / user id during the review step.

### Fixed
- **Multi polls with ONE selected option (1.6.3)** — the widget now sends an
  `options` array for multi-select polls even when a single choice is selected
  (previously a single selection was sent as a bare `option` string, which the
  server — correctly — rejected with "options must be 1..10"). The vote()
  function now takes an explicit `multi` flag instead of inferring it from the
  array length; tests use a realistic worker mock (`Array.isArray`).
- **Polls: results after voting (1.6.2)** — the widget now mirrors the top-level
  `voted` flag from the vote response into the poll, so it lands on the ranked
  results right after voting — even when "one vote per browser" is off (no
  token needed). Previously it fell back to the voting screen (the poll object
  itself carried no `voted` flag). Tests use a realistic server-shaped mock.

### Added
- **Polls: "View results" (1.6.1)** — a small "View results" button under the
  voting buttons reveals the live ranked results even without voting (with a
  "Vote" button to go back). Works for single and multi polls; no data is
  stored (purely client-side reveal).
- **Comment engagement (1.6.0)** — anonymous **likes** on comments (new
  canonical "comment-action" payload: action byte discriminates flag vs vote;
  `POST /api/comments/vote` with PoW + atomic anti-replay + per-browser guard
  storing only a hash); **pin** comments from the admin (`PATCH { pinned }`,
  new `comments.pinned` column, migration 009); visitor **Report**
  (`POST /api/comments/flag`, `comment_flags` table, migration 010 — stores
  only {comment, time}); thread **sort** `data-comments-sort="newest|oldest|best"`
  with a widget selector and pinned always on top; **relative timestamps**;
  **"Read more"** for long comments; **GDPR data export**
  (`GET /api/admin/export?format=csv|json`, formula-injection guarded).
  Tests: comment-actions.test.ts, widget-comments-v2.test.ts.
- **Polish (1.6.0)** — loading skeletons (comments + polls), visible
  `:focus-visible` states, `prefers-reduced-motion` support, refined
  micro-copy; **framework templates** in `integrations/` (Astro, React/Next,
  Vue/Nuxt, Hugo, Jekyll).
- **Polls v2 (1.5.0)** — total-votes chip in the heading ("N votes"), ranked
  results (highest first, #1/#2 badges, stable ties), leader highlight with a
  "Leads by N votes" gap line, and animated bars (staggered fill + count-up).
  **Multi-select polls**: visitors pick several options and cast ONE vote (a
  single Proof-of-Work over the whole set) — new canonical "poll-multi"
  payload schema in `@staticlayer/protocol` (`encodeCanonicalPollPayloadMulti`,
  `minePollNonceMulti`), runtime accepts `options` arrays, batch stores one row
  per chosen option (+1 each). **Change your votes**: guarded multi polls let a
  returning anonymous browser revoke its own votes (`POST /api/polls/revoke`)
  and vote again. Admin: "Multi-select" toggle at creation and after (PATCH
  now updates `singleVote` and `multi` too), chip + toggles on poll cards, live
  multi preview. Tests: multi-vote, PATCH, revoke, ranking, widget poll v2.
- **Comment layout (1.5.0)** — unified "Start the conversation" card (empty
  message + form as one block) and `data-reactions-position="top|bottom"`
  (default bottom) so the whole reactions bar sits together, above or below the
  comments (widget builder field added). Tests: start card + positions.
- **Zero-data anti-spam (1.4.0)** — hidden honeypot field (silently dropped
  bots, fake "pending") + 3s challenge time gate (429 on too-fast submissions;
  issue time recovered from the signed challenge, zero server state). Widget
  mirrors the gate client-side (`data-time-gate-ms`). Tests: antiabuse.
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

- **Hosted installer: no more iframe embed (Round 21.5).** Browsers block
  third-party cookies inside cross-origin iframes, so the wizard's session
  cookie was never stored and the buttons did nothing when embedded on the
  site. The install page now shows a clear **"Launch hosted installer ↗"** CTA
  card that opens the wizard in its own tab (with the local CLI as fallback).
  The `?embed=1` mode stays in the wizard (harmless) but the site no longer
  uses it. The `main.js` iframe-resize listener and `.embed-frame` CSS were
  removed.
- **Admin polish round (Round 21.4): updates, word blacklist, guided Access, recovery.**
  - **In-panel update checker**: new admin **Updates** tab → `GET /api/admin/updates`
    fetches `updates.json` from the official site (var `UPDATES_URL`), compares
    with the runtime version and, when a newer release exists, links to the
    hosted installer (which re-deploys preserving secrets). Read-only; applying
    is a re-deploy. `RUNTIME_VERSION` → `1.0.0`; site ships `public/updates.json`.
  - **Blocked terms (word blacklist)**: migration `005_blocked_terms.sql`;
    comments whose body contains a blocked term are auto-rejected at submit
    (403) and never stored. Admin CRUD via `GET/POST/DELETE /api/admin/terms`;
    new panel in the Lists tab. SCHEMA_VERSION=5.
  - **Cloudflare Access guided at install**: the wizard step 3 now offers
    optional **Cloudflare Access team / AUID** fields; when provided, the
    installer pre-configures `CF_ACCESS_TEAM`/`CF_ACCESS_AUD` vars on the
    deployed worker (both node + hosted installer). Admin login shows
    "Sign in with Cloudflare" automatically.
  - **Password recovery guidance**: the admin Settings panel and FAQ document
    rotation via `wrangler secret put ADMIN_SECRET` (and that re-running the
    installer preserves secrets, so it won't rotate them). Cloudflare Access
    removes the problem entirely.
  - Tests: blocked terms + updates + installer CF vars (+ mock records deploy
    metadata). Suite now **191/191**, typecheck 0.
- **Admin console v2 + Cloudflare Access login (Round 21.3).** Big upgrade:
  - **"Sign in with Cloudflare"**: new `POST /api/admin/access` verifies a
    Cloudflare Access `Cf-Access-Jwt-Assertion` (RS256, JWKS from the team,
    issuer/expiry/audience checks, cached 1h) and issues the same stateless
    admin session — no password to remember. Enabled by setting `CF_ACCESS_TEAM`
    (optionally `CF_ACCESS_AUD`). `GET /api/admin/access` reports readiness;
    the login screen shows/hides the button accordingly. Added `POST
    /api/admin/logout`. Password login stays as fallback.
  - **Pagination, search & filters**: `GET /api/admin/comments` now supports
    `q` (nickname/body), `article`, `page`, `perPage` (newest-first, total/pages).
  - **Bulk actions**: `POST /api/admin/comments/bulk` approve/unapprove/delete
    up to 100 ids (CSRF).
  - **Allow/block lists + nickname ban**: `settings` + `moderation_lists`
    tables (migration 004). Blocked nicknames are rejected at submit (403);
    allowlisted nicknames are auto-approved; `moderation_mode=allowlist` lets
    only allowlisted members comment. Admin CRUD via `GET/POST/DELETE
    /api/admin/lists`.
  - **Live settings panel**: `GET/PUT /api/admin/settings` for
    `pow_difficulty`, `reaction_options`, `moderation_mode` — applied
    immediately (challenge/submit/reactions read the table with env fallback),
    no redeploy.
  - **New admin UI** (tabs Queue / Published / Pages / Lists / Settings, search,
    pagination, bulk bar, ban shortcut on nicknames, styled with the StaticLayer
    design system, dark mode). Migration `004_moderation.sql`; SCHEMA_VERSION=4;
    health reports 4.
  - Tests: `tests/security/admin-moderation.test.ts` + `access-login.test.ts`
    (21 new); suite now **188/188**, typecheck 0. Live-verified on
    `staticlayer-comments.staticlayer.workers.dev`.
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
