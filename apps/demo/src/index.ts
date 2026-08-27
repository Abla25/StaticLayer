/**
 * StaticLayer demo worker.
 *
 * Wraps the real runtime (@staticlayer/runtime) and adds:
 *   - a public demo page at / (with the widget embedded, pointing at itself);
 *   - a daily purge cron (demoDailyReset) on top of the runtime's retention.
 *
 * The widget endpoint/data-article-path are injected at request time so the
 * page works from any host (no hardcoded origin, no inline script).
 */
import type { D1Database, ExecutionContext, ExportedHandler } from '@cloudflare/workers-types';
import staticlayer from '@staticlayer/runtime';
import type { Env } from '@staticlayer/runtime/src/env.ts';
import { demoDailyReset } from './demo-reset.ts';

// Public website links — overridable at deploy time (env) so the demo always
// points at the real site. Defaults follow the GitHub Pages subpath convention.
const SITE_BASE = process.env.STATICLAYER_SITE_BASE || 'https://Abla25.github.io/StaticLayer/';
const REPO_URL = process.env.STATICLAYER_REPO_URL || 'https://github.com/Abla25/StaticLayer';

/** Mobile-nav toggle. Kept as a static file (not inline <script>) to preserve
 *  the strict CSP (script-src 'self') on the demo page. */
const NAV_JS = `(function () {
  var burger = document.getElementById('nav-burger');
  var mobile = document.getElementById('mobile-nav');
  if (!burger || !mobile) return;
  burger.addEventListener('click', function () {
    var open = mobile.classList.toggle('open');
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
  });
})();`;

const DEMO_PAGE_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StaticLayer — Public Demo</title>
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<style>
  :root {
    --bg:#f4f2ec; --bg-2:#ece8df; --surface:#fffdf8; --surface-2:#f8f5ee;
    --ink:#17130e; --ink-soft:#3a332a; --muted:#6f675a;
    --line:rgba(23,19,14,.1); --line-strong:rgba(23,19,14,.16);
    --acc:#ff5a1f; --acc-2:#ff8a2a; --acc-3:#ff3d54;
    --acc-grad:linear-gradient(135deg,#ff8a2a 0%,#ff5a1f 55%,#ff3d54 120%);
    --acc-soft:rgba(255,90,31,.1);
    --ok:#1a8f5a; --warn:#b45309;
    --glass:rgba(255,253,248,.72); --glass-strong:rgba(255,253,248,.9); --blur:20px;
    --radius:18px; --radius-lg:26px; --radius-sm:11px;
    --shadow-sm:0 1px 2px rgba(23,19,14,.05),0 4px 14px -6px rgba(23,19,14,.08);
    --shadow-md:0 2px 4px rgba(23,19,14,.05),0 18px 50px -22px rgba(23,19,14,.22);
    --shadow-acc:0 8px 26px -8px rgba(255,90,31,.45);
    --font:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
    --ease:cubic-bezier(.22,1,.36,1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0e0d0b; --bg-2:#12100c; --surface:#16140f; --surface-2:#1a1711;
      --ink:#f4f1ea; --ink-soft:#d8d2c6; --muted:#9a9284;
      --line:rgba(244,241,234,.1); --line-strong:rgba(244,241,234,.18);
      --acc-soft:rgba(255,90,31,.14);
      --glass:rgba(22,20,15,.72); --glass-strong:rgba(22,20,15,.92);
      --shadow-sm:0 1px 2px rgba(0,0,0,.3),0 4px 14px -6px rgba(0,0,0,.5);
      --shadow-md:0 2px 6px rgba(0,0,0,.4),0 24px 60px -24px rgba(0,0,0,.65);
    }
  }
  * { box-sizing:border-box; }
  html { scroll-behavior:smooth; }
  body { margin:0; font-family:var(--font); font-size:16px; line-height:1.6; color:var(--ink);
    background:var(--bg); -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
  a { color:var(--acc); text-decoration:none; }
  a:hover { text-decoration:underline; }
  code { font-family:var(--mono); font-size:.86em; background:var(--surface-2); border:1px solid var(--line);
    border-radius:6px; padding:.15em .42em; }
  ::selection { background:var(--acc-soft); }
  :focus-visible { outline:2px solid var(--acc); outline-offset:2px; border-radius:4px; }
  .skip { position:absolute; left:-999px; top:0; z-index:100; background:var(--ink); color:var(--bg); padding:10px 16px; border-radius:0 0 10px 0; }
  .skip:focus { left:0; }
  .container { max-width:1120px; margin:0 auto; padding:0 24px; }

  /* buttons */
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; font:inherit; font-weight:600;
    font-size:15px; color:var(--ink); background:var(--surface); border:1px solid var(--line-strong);
    border-radius:999px; padding:12px 22px; cursor:pointer; text-decoration:none; white-space:nowrap;
    transition:transform .18s var(--ease), box-shadow .18s var(--ease), border-color .18s var(--ease), background .18s var(--ease); }
  .btn:hover { text-decoration:none; transform:translateY(-1px); border-color:var(--acc); box-shadow:var(--shadow-sm); }
  .btn-sm { padding:8px 15px; font-size:13.5px; }
  .btn-primary { color:#fff; background:var(--acc-grad); border:0; box-shadow:var(--shadow-acc); }
  .btn-primary:hover { filter:brightness(1.06); box-shadow:0 10px 30px -8px rgba(255,90,31,.55); }
  .btn-ghost { background:transparent; border-color:transparent; color:var(--muted); }
  .btn-ghost:hover { color:var(--ink); border-color:var(--line); background:var(--surface); }

  /* nav */
  .site-nav { position:sticky; top:0; z-index:60; background:var(--glass);
    -webkit-backdrop-filter:blur(var(--blur)); backdrop-filter:blur(var(--blur)); border-bottom:1px solid var(--line); }
  .nav-inner { display:flex; align-items:center; gap:12px; height:64px; }
  .brand { display:inline-flex; align-items:center; gap:10px; color:var(--ink); font-weight:700; font-size:17px; letter-spacing:-.3px; }
  .brand:hover { text-decoration:none; }
  .brand-mark { display:grid; place-items:center; width:30px; height:30px; border-radius:9px; background:var(--ink); color:transparent; }
  .brand-mark svg { width:20px; height:20px; display:block; }
  .nav-links { display:flex; align-items:center; gap:2px; margin-left:auto; }
  .nav-links a { color:var(--muted); font-size:14px; font-weight:500; padding:8px 12px; border-radius:9px; transition:color .15s, background .15s; }
  .nav-links a:hover { color:var(--ink); background:var(--surface-2); text-decoration:none; }
  .nav-links a.active { color:var(--ink); }
  .nav-drop { position:relative; }
  .nav-drop summary { display:inline-flex; align-items:center; gap:6px; list-style:none; cursor:pointer; color:var(--muted);
    font-size:14px; font-weight:500; padding:8px 12px; border-radius:9px; transition:color .15s, background .15s; }
  .nav-drop summary::-webkit-details-marker { display:none; }
  .nav-drop summary:hover { color:var(--ink); background:var(--surface-2); }
  .nav-drop .caret { width:7px; height:7px; flex:none; border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor;
    transform:rotate(45deg); margin-top:-4px; transition:transform .2s var(--ease); }
  .nav-drop[open] .caret { transform:rotate(225deg); margin-top:3px; }
  .drop-menu { position:absolute; top:calc(100% + 12px); left:50%; transform:translateX(-50%) translateY(-4px); min-width:210px;
    background:var(--surface); border:1px solid var(--line-strong); border-radius:14px; box-shadow:var(--shadow-md); padding:6px;
    display:flex; flex-direction:column; gap:2px; opacity:0; visibility:hidden; z-index:70;
    transition:opacity .18s var(--ease), transform .18s var(--ease), visibility .18s; }
  .nav-drop[open] .drop-menu { opacity:1; visibility:visible; transform:translateX(-50%) translateY(0); }
  .drop-menu a { padding:9px 12px; border-radius:9px; font-size:13.5px; color:var(--muted); }
  .drop-menu a:hover { color:var(--ink); background:var(--surface-2); text-decoration:none; }
  .nav-actions { display:flex; align-items:center; gap:10px; }
  .nav-burger { display:none; background:none; border:0; padding:8px; cursor:pointer; border-radius:8px; }
  .nav-burger:hover { background:var(--surface-2); }
  .nav-burger span { display:block; width:20px; height:2px; background:var(--ink); margin:4px 0; border-radius:2px; transition:transform .2s var(--ease); }
  .nav-burger[aria-expanded="true"] span:nth-child(1) { transform:translateY(6px) rotate(45deg); }
  .nav-burger[aria-expanded="true"] span:nth-child(2) { transform:translateY(-6px) rotate(-45deg); }
  .mobile-nav { display:none; flex-direction:column; gap:2px; padding:8px 24px 18px; border-top:1px solid var(--line); }
  .mobile-nav.open { display:flex; }
  .mobile-nav a { padding:12px 8px; color:var(--ink); font-weight:500; border-top:1px solid var(--line); }
  .mobile-nav a:first-child { border-top:0; }
  .mobile-nav a.btn { border-top:0; margin-top:10px; justify-content:center; }

  /* alert strip */
  .demo-alert { border-bottom:1px solid var(--line); background:var(--acc-soft); color:var(--muted);
    text-align:center; padding:10px 20px; font-size:12.5px; letter-spacing:.2px; }
  .demo-alert b { color:var(--acc); }

  /* hero */
  .hero { position:relative; padding:76px 0 56px; overflow:hidden; }
  .hero::before { content:""; position:absolute; top:-220px; right:-160px; width:640px; height:640px;
    background:radial-gradient(circle at 30% 30%, rgba(255,138,42,.22), rgba(255,61,84,.08) 55%, transparent 70%); pointer-events:none; }
  .hero::after { content:""; position:absolute; inset:0; pointer-events:none; opacity:.5;
    background-image:linear-gradient(to right, var(--line) 1px, transparent 1px), linear-gradient(to bottom, var(--line) 1px, transparent 1px);
    background-size:72px 72px;
    -webkit-mask-image:radial-gradient(ellipse 90% 60% at 50% 0%, #000 20%, transparent 75%);
    mask-image:radial-gradient(ellipse 90% 60% at 50% 0%, #000 20%, transparent 75%); }
  .hero-inner { position:relative; max-width:760px; }
  .hero-eyebrow { display:inline-flex; align-items:center; gap:8px; font-size:12.5px; font-weight:650; letter-spacing:.04em;
    text-transform:uppercase; color:var(--acc); background:var(--acc-soft); border:1px solid rgba(255,90,31,.22);
    border-radius:999px; padding:6px 13px; margin-bottom:22px; }
  .hero-eyebrow::before { content:""; width:6px; height:6px; border-radius:50%; background:var(--acc); box-shadow:0 0 0 3px var(--acc-soft); }
  .hero h1 { margin:0 0 20px; font-size:clamp(38px, 5vw, 58px); line-height:1.05; letter-spacing:-.045em; font-weight:750; text-wrap:balance; }
  .hero h1 .grad { background:var(--acc-grad); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:transparent; }
  .hero-sub { font-size:17px; line-height:1.6; color:var(--muted); max-width:560px; margin:0 0 28px; }
  .hero-sub b { color:var(--ink); }
  .hero-cta { display:flex; flex-wrap:wrap; gap:12px; }

  /* panels */
  .glass-panel { background:var(--glass); border:1px solid var(--line-strong); border-radius:var(--radius-lg);
    padding:26px; -webkit-backdrop-filter:blur(var(--blur)); backdrop-filter:blur(var(--blur)); box-shadow:var(--shadow-sm); }
  .panel-title { display:flex; align-items:center; gap:10px; margin:0 0 6px; font-size:16px; letter-spacing:-.02em; }
  .panel-sub { margin:0 0 18px; font-size:13px; color:var(--muted); }
  .demo-body { padding:0 0 70px; }
  .hint { display:flex; gap:12px; align-items:flex-start; margin-bottom:20px; font-size:13px; color:var(--muted); }
  .hint b { color:var(--ink); }
  .hint .ico { flex:none; width:32px; height:32px; border-radius:10px; display:flex; align-items:center; justify-content:center;
    background:var(--acc-soft); color:var(--acc); font-size:15px; }
  #demo-widget { scroll-margin-top:90px; }
  #staticlayer { --accent:var(--acc); --accent-2:#e85d0a; --bg:transparent;
    --card:var(--surface); --border:var(--line-strong); --text:var(--ink); --muted:var(--muted); --shadow:var(--shadow-sm); }

  /* content rules */
  .content-rules { margin-top:18px; padding:16px 18px; background:var(--surface-2);
    border:1px dashed var(--line-strong); border-radius:14px; font-size:13px; color:var(--muted); }
  .content-rules b { color:var(--ink); font-size:12.5px; letter-spacing:.02em; text-transform:uppercase; }
  .content-rules ul { margin:8px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:5px; }
  .content-rules li { display:flex; align-items:center; gap:8px; }
  .content-rules li::before { content:""; width:5px; height:5px; border-radius:50%; background:var(--acc); flex:none; }

  /* footer */
  .site-footer { border-top:1px solid var(--line); background:var(--bg-2); padding:60px 0 34px; }
  .footer-inner { display:grid; grid-template-columns:1.4fr 1fr 1fr; gap:40px; }
  .footer-brand { display:flex; align-items:center; gap:10px; font-weight:750; font-size:16px; margin:0 0 6px; letter-spacing:-.3px; }
  .footer-brand .brand-mark { width:26px; height:26px; border-radius:8px; }
  .footer-tag { color:var(--muted); font-size:13.5px; margin:0 0 16px; max-width:300px; }
  .footer-links { display:flex; flex-direction:column; gap:9px; }
  .footer-links a { color:var(--muted); font-size:13.5px; font-weight:500; }
  .footer-links a:hover { color:var(--ink); }
  .footer-legal { grid-column:1 / -1; color:var(--muted); font-size:12.5px; margin:26px 0 0;
    border-top:1px solid var(--line); padding-top:20px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px; }

  @media (max-width: 960px) { .footer-inner { grid-template-columns:1fr 1fr; } }
  @media (max-width: 720px) {
    .nav-links { display:none; }
    .nav-actions .btn { display:none; }
    .nav-burger { display:block; }
    .hero { padding:56px 0 44px; }
    .hero h1 { font-size:38px; }
    .footer-inner { grid-template-columns:1fr; gap:24px; }
  }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-nav">
  <div class="container nav-inner">
    <a class="brand" href="${SITE_BASE}" aria-label="StaticLayer home">
      <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none"><defs><linearGradient id="slg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a2a"/><stop offset="1" stop-color="#ff3d54"/></linearGradient></defs><g fill="url(#slg)"><rect x="15" y="39" width="34" height="7" rx="3.5"/><rect x="15" y="30" width="27" height="7" rx="3.5" opacity="0.82"/><rect x="15" y="21" width="20" height="7" rx="3.5" opacity="0.64"/></g></svg></span>
      <span class="brand-name">StaticLayer</span>
    </a>
    <nav class="nav-links" aria-label="Primary">
      <a href="${SITE_BASE}">Product</a>
      <a href="${SITE_BASE}demo.html" class="active" aria-current="page">Demo</a>
      <details class="nav-drop">
        <summary>Docs<span class="caret" aria-hidden="true"></span></summary>
        <div class="drop-menu" role="menu">
          <a href="${SITE_BASE}docs.html" role="menuitem">Quick start</a>
          <a href="${SITE_BASE}install.html" role="menuitem">Universal install</a>
          <a href="${SITE_BASE}integrations.html" role="menuitem">Integrations</a>
          <a href="${SITE_BASE}security.html" role="menuitem">Security</a>
          <a href="${SITE_BASE}privacy.html" role="menuitem">Privacy</a>
          <a href="${SITE_BASE}faq.html" role="menuitem">FAQ</a>
        </div>
      </details>
      <a href="${REPO_URL}" class="nav-github" target="_blank" rel="noopener">GitHub ↗</a>
    </nav>
    <div class="nav-actions">
      <a class="btn btn-primary btn-sm" href="${SITE_BASE}docs.html">Get started</a>
      <button class="nav-burger" id="nav-burger" aria-label="Menu" aria-expanded="false" aria-controls="mobile-nav"><span></span><span></span></button>
    </div>
  </div>
  <nav class="mobile-nav" id="mobile-nav" aria-label="Mobile">
    <a href="${SITE_BASE}">Product</a>
    <a href="${SITE_BASE}demo.html">Demo</a>
    <a href="${SITE_BASE}docs.html">Quick start</a>
    <a href="${SITE_BASE}install.html">Universal install</a>
    <a href="${SITE_BASE}integrations.html">Integrations</a>
    <a href="${SITE_BASE}security.html">Security</a>
    <a href="${SITE_BASE}privacy.html">Privacy</a>
    <a href="${SITE_BASE}faq.html">FAQ</a>
    <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub ↗</a>
    <a class="btn btn-primary" href="${SITE_BASE}docs.html">Get started</a>
  </nav>
</header>

<div class="demo-alert"><b>PUBLIC DEMO</b> — all data is purged every night · no personal data is collected</div>

<main id="main">
  <section class="hero">
    <div class="container hero-inner">
      <span class="hero-eyebrow">Public sandbox</span>
      <h1>Try StaticLayer <span class="grad">live</span></h1>
      <p class="hero-sub">This is the real worker: your browser solves the anti-spam <b>proof-of-work</b>, your comment enters the <b>moderation queue</b>, and an admin approves it. No tracking, no personal data — comments are purged every night.</p>
      <div class="hero-cta">
        <a class="btn btn-primary" href="#demo-widget">Post a comment</a>
        <a class="btn btn-ghost" href="${SITE_BASE}docs.html">Read the docs</a>
      </div>
    </div>
  </section>

  <div class="container demo-body">
    <div class="glass-panel hint">
      <div class="ico">🛡️</div>
      <div>Comments are <b>plain text</b> (no HTML/Markdown, no tracking) — <b>emoji</b> work as Unicode text.
      To approve a comment, open <code>{{ORIGIN}}/admin.html</code> and sign in with <code>ADMIN_SECRET</code>
      (local: <code>apps/demo/.dev.vars</code>), then hit <b>Approve</b>.</div>
    </div>

    <section class="glass-panel" id="demo-widget">
      <div class="panel-title">Comments</div>
      <p class="panel-sub">Moderated manually — your first comment appears after approval. Try the reactions too (each click solves a real proof-of-work).</p>
      <div
        id="staticlayer"
        data-staticlayer
        data-endpoint="{{ORIGIN}}"
        data-article-path="/demo"
        data-host-context="staticlayer-demo.workers.dev"
        data-reactions="👍,❤️,🎉"
      ></div>
    </section>

    <div class="content-rules" aria-label="What visitors can write">
      <b>What visitors can write</b>
      <ul>
        <li>Plain text + emoji ✓</li>
        <li>No HTML, no Markdown — everything renders as text</li>
        <li>No clickable links</li>
        <li>Nickname ≤ 50 · body ≤ 3000 characters</li>
        <li>Reactions are anonymous events (real PoW, escalating difficulty)</li>
      </ul>
    </div>
  </div>
</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <div>
      <p class="footer-brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none"><g fill="url(#slg)"><rect x="15" y="39" width="34" height="7" rx="3.5"/><rect x="15" y="30" width="27" height="7" rx="3.5" opacity="0.82"/><rect x="15" y="21" width="20" height="7" rx="3.5" opacity="0.64"/></g></svg></span>StaticLayer</p>
      <p class="footer-tag">Comments for static sites — without the comment SaaS.</p>
    </div>
    <div class="footer-links">
      <a href="${SITE_BASE}">Product</a>
      <a href="${SITE_BASE}demo.html">Demo</a>
      <a href="${SITE_BASE}docs.html">Docs</a>
      <a href="${SITE_BASE}security.html">Security</a>
      <a href="${SITE_BASE}privacy.html">Privacy</a>
      <a href="${SITE_BASE}faq.html">FAQ</a>
    </div>
    <div class="footer-links">
      <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
      <a href="${REPO_URL}/blob/main/SECURITY.md" target="_blank" rel="noopener">Report a vulnerability</a>
      <a href="${SITE_BASE}docs.html#quick-start">Quick start</a>
    </div>
    <p class="footer-legal"><span>MIT licensed · Open Source · BYOC</span><span>© 2026 StaticLayer</span></p>
  </div>
</footer>
<script src="{{ORIGIN}}/widget.js"></script>
<script src="{{ORIGIN}}/demo-nav.js"></script>
</body>
</html>`;

const DEMO_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** The demo environment is exactly the runtime Env (same bindings/vars). */
type DemoEnv = Env & { DB: D1Database };

const runtime = staticlayer as ExportedHandler<DemoEnv>;

const demoWorker: ExportedHandler<DemoEnv> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/demo-nav.js') {
      return new Response(NAV_JS, {
        headers: {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        },
      });
    }
    if (url.pathname === '/') {
      const page = DEMO_PAGE_TEMPLATE.replaceAll('{{ORIGIN}}', url.origin);
      return new Response(page, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': DEMO_CSP,
          'x-content-type-options': 'nosniff',
          'cache-control': 'public, max-age=60',
        },
      });
    }
    if (runtime.fetch) {
      return runtime.fetch(request, env, {} as ExecutionContext);
    }
    return new Response('runtime fetch unavailable', { status: 500 });
  },

  async scheduled(controller, env, ctx) {
    await demoDailyReset(env.DB);
    if (runtime.scheduled) {
      await runtime.scheduled(controller, env, ctx);
    }
  },
};

export default demoWorker;
