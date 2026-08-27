/**
 * StaticLayer public widget — Vanilla JS, zero dependencies, zero tracking.
 *
 * Host element (attribute API) — three modes:
 *   <div data-staticlayer
 *        data-endpoint="https://comments.example.com"   (alias: data-api)
 *        data-article-path="/blog/hello-world"          (alias: data-article-id;
 *                                                        default: location.pathname)
 *        data-host-context="optional override (default: location.hostname)"></div>
 *   → comments only
 *
 *   <div data-staticlayer data-api="..." data-reactions="👍,❤️,🎉"></div>
 *   → comments + reactions (bar above the form)
 *
 *   <div data-staticlayer data-api="..." data-reactions="👍,❤️,🎉"
 *        data-reactions-only></div>
 *   → STANDALONE reactions bar (no comment UI) — place it anywhere, separate
 *     from a comments widget.
 *
 *   <div data-staticlayer data-api="..." data-poll-id="..."></div>
 *   → STANDALONE poll (StrawPoll-style) — question, options, live results.
 *     The poll is created in the admin (Polls tab); single-vote polls use an
 *     anonymous browser token (localStorage, no cookies, no personal data).
 *
 * Optional look & feel (all can also be passed via window.StaticLayer.mount
 * opts: lang, theme, accent, accent2, radius, maxWidth, texts):
 *   data-lang="auto|en|it"        UI language (default auto-detect)
 *   data-theme="auto|light|dark"  force a theme (default: follow OS)
 *   data-accent="#ff8a2a"         accent color (and data-accent-2 for the end)
 *   data-radius="18"              corner radius in px
 *   data-max-width="640"          widget max width in px
 *   data-text='{"post":"Pubblica","empty":"…"}'   per-key text overrides
 *
 * Programmatic API (optional):
 *   window.StaticLayer.mount(el, { endpoint, articlePath, hostContext,
 *                                  reactions, reactionsOnly, lang, theme,
 *                                  accent, accent2, radius, maxWidth, texts })
 *   window.StaticLayer.unmount(el)
 *
 * Reactions (when enabled): each click solves a real Proof-of-Work at the
 * server-issued (escalating) difficulty — same cost-based integrity model as
 * comments. No identity, no cookies, no IP: counts are anonymous events.
 *
 * Security invariants (non-negotiable):
 *   - comments and reactions are rendered with textContent ONLY (never innerHTML);
 *   - no cookies, no localStorage/sessionStorage, no fingerprinting, no analytics;
 *   - no external requests of any kind (avatars are local initials);
 *   - PoW mining runs in a dedicated Web Worker (pow-worker.js).
 *
 * Design: premium/minimal (Notion-style), fully self-contained (<style> scoped
 * under .sl-*), automatic dark mode, CSS-variable themable.
 */
(function () {
  'use strict';

  var WORKER_FILE = 'pow-worker.js';

  // Resolve the worker URL relative to THIS script's URL (not the page URL).
  var workerUrl = WORKER_FILE;
  var scriptSrc = typeof document !== 'undefined' && document.currentScript && document.currentScript.src;
  if (scriptSrc) {
    try { workerUrl = new URL(WORKER_FILE, scriptSrc).href; } catch (e) { workerUrl = WORKER_FILE; }
  }

  var AVATAR_GRADIENTS = [
    'linear-gradient(135deg,#ff9a5a,#f05a1c)',
    'linear-gradient(135deg,#a78bfa,#7c3aed)',
    'linear-gradient(135deg,#5eead4,#0d9488)',
    'linear-gradient(135deg,#7dd3fc,#0284c7)',
    'linear-gradient(135deg,#f9a8d4,#db2777)',
    'linear-gradient(135deg,#bef264,#65a30d)',
    'linear-gradient(135deg,#fda4af,#e11d48)',
    'linear-gradient(135deg,#fcd34d,#d97706)'
  ];

  function hashString(str) {
    var h = 0;
    for (var i = 0; i < str.length; i += 1) { h = (h * 31 + str.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ------------------------ localization ------------------------------ */
  // UI copy is localizable via `data-lang="en|it|auto"` (default: auto-detect
  // from navigator.language, fallback EN) and overridable per-key via
  // `data-text='{"post":"Pubblica","empty":"…"}'` or opts.texts.
  // countOne/countMany accept a `{n}` placeholder.
  var I18N = {
    en: {
      title: 'Comments',
      nickPlaceholder: 'Name (optional)',
      bodyPlaceholder: 'Write a comment…',
      post: 'Post comment',
      hint: 'Plain text · emoji welcome · anti-spam proof-of-work',
      empty: 'No comments yet — be the first. 💬',
      anonymous: 'Anonymous',
      emptyComment: 'Comment cannot be empty.',
      solving: 'Solving proof-of-work…',
      pending: 'Comment submitted — awaiting moderation.',
      posted: 'Comment posted.',
      reactAria: 'React with ',
      reactionRecorded: '✓ Reaction recorded',
      slowDown: 'Slow down — too many reactions.',
      challengeUsed: 'Challenge already used — try again.',
      countOne: '1 comment',
      countMany: '{n} comments',
      voted: '✓ You voted',
      closed: 'This poll is closed',
      pollMissing: 'Poll not found',
      alreadyVoted: 'You already voted in this poll',
      pollLoadError: 'Failed to load the poll',
      reply: 'Reply',
      cancelReply: 'Cancel',
      replyPlaceholder: 'Write a reply…',
      showMoreReplies: 'Show more replies ({n})',
      parentRemoved: 'Parent comment removed',
      author: 'Author'
    },
    it: {
      title: 'Commenti',
      nickPlaceholder: 'Nome (facoltativo)',
      bodyPlaceholder: 'Scrivi un commento…',
      post: 'Pubblica commento',
      hint: 'Testo semplice · emoji benvenute · anti-spam proof-of-work',
      empty: 'Nessun commento ancora — sii il primo. 💬',
      anonymous: 'Anonimo',
      emptyComment: 'Il commento non può essere vuoto.',
      solving: 'Risoluzione proof-of-work…',
      pending: 'Commento inviato — in attesa di moderazione.',
      posted: 'Commento pubblicato.',
      reactAria: 'Reagisci con ',
      reactionRecorded: '✓ Reazione registrata',
      slowDown: 'Rallenta — troppe reazioni.',
      challengeUsed: 'Challenge già usata — riprova.',
      countOne: '1 commento',
      countMany: '{n} commenti',
      voted: '✓ Hai votato',
      closed: 'Sondaggio chiuso',
      pollMissing: 'Sondaggio non trovato',
      alreadyVoted: 'Hai già votato in questo sondaggio',
      pollLoadError: 'Impossibile caricare il sondaggio',
      reply: 'Rispondi',
      cancelReply: 'Annulla',
      replyPlaceholder: 'Scrivi una risposta…',
      showMoreReplies: 'Mostra altre risposte ({n})',
      parentRemoved: 'Commento padre rimosso',
      author: 'Autore'
    }
  };

  /* ------------------------------ styles ------------------------------ */
  var STYLES = '' +
    '.sl-root{--accent:#f57d1f;--accent-2:#e85d0a;--bg:#ffffff;--card:#ffffff;--border:#e8e8e6;' +
    '--text:#1a1a1a;--muted:#6f6f6f;--radius:14px;' +
    '--shadow:0 1px 2px rgba(16,24,40,.04),0 6px 20px -6px rgba(16,24,40,.08);' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;' +
    'color:var(--text);max-width:640px;margin:0 auto;line-height:1.55;-webkit-font-smoothing:antialiased}' +
    '.sl-root.sl-theme-dark{--bg:#161616;--card:#1f1f1f;--border:#2b2b2b;' +
    '--text:#f4f4f4;--muted:#9d9d9d;--shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px -12px rgba(0,0,0,.5)}' +
    '@media(prefers-color-scheme:dark){.sl-root:not(.sl-theme-light){--bg:#161616;--card:#1f1f1f;--border:#2b2b2b;' +
    '--text:#f4f4f4;--muted:#9d9d9d;--shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px -12px rgba(0,0,0,.5)}}' +
    '.sl-root *{box-sizing:border-box}' +
    '.sl-heading{display:flex;align-items:center;justify-content:space-between;margin:0 0 18px}' +
    '.sl-heading h3{margin:0;font-size:15px;font-weight:650;letter-spacing:-.1px}' +
    '.sl-count{font-size:11px;font-weight:600;color:var(--muted);background:color-mix(in srgb,var(--border) 60%,transparent);' +
    'padding:3px 10px;border-radius:999px}' +
    '.sl-list{list-style:none;margin:0 0 20px;padding:0;display:flex;flex-direction:column;gap:14px}' +
    '.sl-comment{display:flex;flex-direction:column;gap:14px;padding:16px 18px;background:var(--card);border:1px solid var(--border);' +
    'border-radius:var(--radius);box-shadow:var(--shadow);transition:box-shadow .18s ease,transform .18s ease,border-color .18s ease}' +
    '.sl-comment .sl-top{display:flex;gap:12px;min-width:0}' +
    '.sl-comment:hover{box-shadow:0 2px 4px rgba(16,24,40,.05),0 12px 32px -10px rgba(16,24,40,.12);' +
    'transform:translateY(-1px);border-color:color-mix(in srgb,var(--accent) 25%,var(--border))}' +
    '.sl-avatar{flex:none;width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;' +
    'color:#fff;font-weight:650;font-size:14px;user-select:none;box-shadow:inset 0 -2px 6px rgba(0,0,0,.14)}' +
    '.sl-main{min-width:0;flex:1}' +
    '.sl-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:3px}' +
    '.sl-nick{font-weight:600;font-size:13.5px;letter-spacing:-.1px}' +
    '.sl-time{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}' +
    '.sl-body{margin:0;font-size:14.5px;white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word}' +
    '.sl-empty{padding:28px 18px;text-align:center;color:var(--muted);font-size:14px;background:var(--card);' +
    'border:1px dashed var(--border);border-radius:var(--radius)}' +
    '.sl-form{display:flex;flex-direction:column;gap:10px;padding:16px;background:var(--card);border:1px solid var(--border);' +
    'border-radius:var(--radius);box-shadow:var(--shadow)}' +
    '.sl-nick-input,.sl-body-input{width:100%;padding:11px 14px;border:1px solid var(--border);border-radius:10px;' +
    'background:var(--bg);color:var(--text);font:inherit;font-size:14px;outline:none;' +
    'transition:border-color .15s ease,box-shadow .15s ease,background .15s ease}' +
    '.sl-nick-input:focus,.sl-body-input:focus{border-color:var(--accent);background:var(--bg);' +
    'box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent)}' +
    '.sl-nick-input::placeholder,.sl-body-input::placeholder{color:var(--muted)}' +
    '.sl-body-input{resize:vertical;min-height:80px;line-height:1.5}' +
    '.sl-form-row{display:flex;align-items:center;gap:12px;justify-content:space-between;margin-top:2px}' +
    '.sl-hint{font-size:11.5px;color:var(--muted)}' +
    '.sl-submit{appearance:none;border:0;cursor:pointer;padding:10px 18px;border-radius:999px;font:inherit;font-weight:600;' +
    'font-size:13.5px;color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent-2));' +
    'box-shadow:0 6px 16px -6px color-mix(in srgb,var(--accent) 60%,transparent);' +
    'transition:transform .12s ease,filter .12s ease,opacity .12s ease}' +
    '.sl-submit:hover{transform:translateY(-1px);filter:brightness(1.05)}' +
    '.sl-submit:disabled{opacity:.55;cursor:progress;transform:none;filter:none}' +
    '.sl-status{display:flex;align-items:center;gap:8px;min-height:20px;margin:12px 2px 0;font-size:13px;color:var(--muted)}' +
    '.sl-status[data-kind="ok"]{color:#16a34a}.sl-status[data-kind="err"]{color:#dc2626}' +
    '.sl-status .sl-spinner{width:14px;height:14px;border:2px solid color-mix(in srgb,var(--muted) 30%,transparent);' +
    'border-top-color:var(--accent);border-radius:50%;animation:sl-spin .7s linear infinite}' +
    '.sl-reactions{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}' +
    '.sl-reaction{appearance:none;display:inline-flex;align-items:center;gap:7px;cursor:pointer;font:inherit;' +
    'font-size:14px;padding:7px 13px;border-radius:999px;border:1px solid var(--border);background:var(--card);' +
    'color:var(--text);transition:transform .12s ease,border-color .12s ease,box-shadow .12s ease}' +
    '.sl-reaction:hover{transform:translateY(-1px);border-color:var(--accent);' +
    'box-shadow:0 4px 14px -6px color-mix(in srgb,var(--accent) 45%,transparent)}' +
    '.sl-reaction:disabled{opacity:.6;cursor:progress;transform:none}' +
    '.sl-reaction .sl-reaction-count{font-size:11.5px;font-weight:700;color:var(--muted);font-variant-numeric:tabular-nums}' +
    '.sl-reaction-status{min-height:16px;margin:0 2px 12px;font-size:12px;color:var(--muted)}' +
    '.sl-reaction-status[data-kind="ok"]{color:#16a34a}.sl-reaction-status[data-kind="err"]{color:#dc2626}' +
    '.sl-poll-heading{display:flex;align-items:center;justify-content:space-between;margin:0 0 14px}' +
    '.sl-poll-heading h3{margin:0;font-size:15px;font-weight:650;letter-spacing:-.1px;line-height:1.4}' +
    '.sl-poll-options{list-style:none;margin:0 0 12px;padding:0;display:flex;flex-direction:column;gap:10px}' +
    '.sl-poll-btn{appearance:none;width:100%;text-align:left;cursor:pointer;font:inherit;font-size:14px;padding:12px 16px;' +
    'border-radius:12px;border:1px solid var(--border);background:var(--card);color:var(--text);' +
    'transition:transform .12s ease,border-color .12s ease,box-shadow .12s ease}' +
    '.sl-poll-btn:hover{transform:translateY(-1px);border-color:var(--accent);' +
    'box-shadow:0 4px 14px -6px color-mix(in srgb,var(--accent) 45%,transparent)}' +
    '.sl-poll-btn:disabled{opacity:.55;cursor:progress;transform:none}' +
    '.sl-poll-opt-label{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:6px}' +
    '.sl-poll-opt-name{font-size:14px;font-weight:600}' +
    '.sl-poll-opt-meta{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}' +
    '.sl-poll-bar{height:8px;border-radius:999px;background:color-mix(in srgb,var(--border) 60%,transparent);overflow:hidden}' +
    '.sl-poll-fill{height:100%;border-radius:999px;background:linear-gradient(135deg,var(--accent),var(--accent-2));' +
    'transition:width .5s ease}' +
    '.sl-poll-status{display:flex;align-items:center;gap:8px;min-height:20px;margin:10px 2px 0;font-size:13px;color:var(--muted)}' +
    '.sl-poll-status[data-kind="ok"]{color:#16a34a}.sl-poll-status[data-kind="err"]{color:#dc2626}' +
    '.sl-replies{list-style:none;margin:0;padding:4px 0 0 14px;display:flex;flex-direction:column;gap:10px;' +
    'border-left:2px solid color-mix(in srgb,var(--border) 65%,transparent)}' +
    '.sl-reply{box-shadow:none;padding:12px 14px;background:color-mix(in srgb,var(--card) 55%,transparent)}' +
    '.sl-reply:hover{box-shadow:none;transform:none}' +
    '.sl-reply .sl-avatar{width:28px;height:28px;font-size:12px;border-radius:8px}' +
    '.sl-reply .sl-nick{font-size:12.5px}' +
    '.sl-owner-badge{display:inline-block;margin-left:7px;font-size:10px;font-weight:700;letter-spacing:.3px;' +
    'text-transform:uppercase;color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);' +
    'border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);padding:1px 7px;border-radius:999px;vertical-align:1px}' +
    '.sl-reply-btn{appearance:none;border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;' +
    'font-weight:600;cursor:pointer;padding:0;margin-top:6px;transition:color .15s}' +
    '.sl-reply-btn:hover{color:var(--accent)}' +
    '.sl-reply-form{margin-top:12px}' +
    '.sl-parent-removed{color:var(--muted);font-style:italic}' +
    '.sl-show-more{list-style:none}' +
    '@keyframes sl-spin{to{transform:rotate(360deg)}}';

  function injectStyles() {
    if (document.getElementById('sl-styles')) return;
    var style = document.createElement('style');
    style.id = 'sl-styles';
    style.textContent = STYLES;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------ widget ------------------------------ */
  function mount(root, opts) {
    if (!root || root.__slMounted) return;
    // Attribute API with aliases; opts take precedence (programmatic API).
    var endpoint = ((opts && opts.endpoint) || root.getAttribute('data-endpoint') ||
      root.getAttribute('data-api') || '').replace(/\/+$/, '');
    var articlePath = (opts && opts.articlePath) || root.getAttribute('data-article-path') ||
      root.getAttribute('data-article-id') ||
      (typeof location !== 'undefined' ? location.pathname : '');
    var hostContext = (opts && opts.hostContext) || root.getAttribute('data-host-context') ||
      (typeof location !== 'undefined' ? location.hostname : '');
    if (!endpoint) return;
    root.__slMounted = true;
    root.classList.add('sl-root');

    // -------- localization: lang auto-detect + per-key overrides ---------
    var lang = ((opts && opts.lang) || root.getAttribute('data-lang') || 'auto');
    if (lang !== 'en' && lang !== 'it') {
      lang = (typeof navigator !== 'undefined' && navigator.language &&
        navigator.language.toLowerCase().indexOf('it') === 0) ? 'it' : 'en';
    }
    var dict = I18N[lang] || I18N.en;
    var customTexts = null;
    if (opts && opts.texts) {
      customTexts = opts.texts;
    } else {
      var rawTexts = root.getAttribute('data-text');
      if (rawTexts) { try { customTexts = JSON.parse(rawTexts); } catch (e) { customTexts = null; } }
    }
    function t(key) {
      if (customTexts && Object.prototype.hasOwnProperty.call(customTexts, key) &&
          typeof customTexts[key] === 'string' && customTexts[key].length) return customTexts[key];
      if (dict && Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
      return key;
    }
    function countLabel(n) {
      return String(t(n === 1 ? 'countOne' : 'countMany')).replace('{n}', String(n));
    }

    // -------- theming: forced theme + CSS-variable overrides ------------
    // Values may arrive as numbers (programmatic API) or strings (attributes);
    // normalize to strings before trimming.
    var theme = String(((opts && opts.theme) || root.getAttribute('data-theme') || '')).trim();
    if (theme === 'dark') root.classList.add('sl-theme-dark');
    else if (theme === 'light') root.classList.add('sl-theme-light');
    var accent = String(((opts && opts.accent) || root.getAttribute('data-accent') || '')).trim();
    if (accent) root.style.setProperty('--accent', accent);
    var accent2 = String(((opts && opts.accent2) || root.getAttribute('data-accent-2') || '')).trim();
    if (accent2) root.style.setProperty('--accent-2', accent2);
    var radius = String(((opts && opts.radius) || root.getAttribute('data-radius') || '')).trim();
    if (radius) root.style.setProperty('--radius', radius.replace(/[^0-9.]/g, '') + 'px');
    var maxWidth = String(((opts && opts.maxWidth) || root.getAttribute('data-max-width') || '')).trim();
    if (maxWidth) root.style.setProperty('max-width', maxWidth.replace(/[^0-9.]/g, '') + 'px');

    // -------- mode: standalone poll --------
    var pollId = String(((opts && opts.pollId) || root.getAttribute('data-poll-id') || '')).trim();
    var pollStyle = String(((opts && opts.pollStyle) || root.getAttribute('data-poll-style') || 'bars')).trim();
    var pollResults = String(((opts && opts.pollResults) || root.getAttribute('data-poll-results') || 'after')).trim();
    if (pollId) {
      initPoll();
      return;
    }

    // -------- mode: comments only / reactions only / both --------
    // `data-reactions-only` (or opts.reactionsOnly) renders a STANDALONE
    // reactions bar with no comment UI — place it wherever you like, separate
    // from a comments widget.
    var reactionsOnly = !!(opts && opts.reactionsOnly) || root.getAttribute('data-reactions-only') !== null;

    var reactions = null;
    if (opts && Array.isArray(opts.reactions)) {
      reactions = opts.reactions.filter(function (s) { return typeof s === 'string' && s.length; });
    } else {
      var rawAttr = root.getAttribute('data-reactions');
      if (rawAttr) {
        reactions = rawAttr.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      }
    }

    var heading = null, count = null, list = null, nickInput = null, bodyInput = null;
    var submitBtn = null, status = null, form = null;
    var reactBar = null, reactStatus = null;
    var reactBtns = {}, reactBusy = false;

    function buildReactions() {
      if (!reactBar || !reactions) return;
      reactions.forEach(function (r) {
        var btn = el('button', 'sl-reaction');
        btn.type = 'button';
        btn.setAttribute('aria-label', t('reactAria') + r);
        var c = el('span', 'sl-reaction-count', '0');
        btn.append(el('span', 'sl-reaction-emoji', r), c);
        reactBtns[r] = { btn: btn, count: c };
        btn.addEventListener('click', function () { submitReaction(r); });
        reactBar.appendChild(btn);
      });
    }

    if (reactionsOnly) {
      // standalone reactions bar — no comment UI at all
      reactStatus = el('p', 'sl-reaction-status');
      reactBar = el('div', 'sl-reactions');
      buildReactions();
      root.append(reactBar, reactStatus);
    } else {
      heading = el('div', 'sl-heading');
      heading.appendChild(el('h3', null, t('title')));
      count = el('span', 'sl-count', '…');
      heading.appendChild(count);
      list = el('ul', 'sl-list');

      nickInput = el('input');
      nickInput.type = 'text';
      nickInput.maxLength = 50;
      nickInput.placeholder = t('nickPlaceholder');
      nickInput.className = 'sl-nick-input';
      bodyInput = el('textarea');
      bodyInput.maxLength = 3000;
      bodyInput.rows = 3;
      bodyInput.placeholder = t('bodyPlaceholder');
      bodyInput.className = 'sl-body-input';
      submitBtn = el('button', 'sl-submit', t('post'));
      submitBtn.type = 'submit';
      var hint = el('span', 'sl-hint', t('hint'));
      status = el('p', 'sl-status');
      form = el('form', 'sl-form');
      var row = el('div', 'sl-form-row');
      row.append(hint, submitBtn);
      form.append(nickInput, bodyInput, row);
      root.append(heading, list);

      if (reactions && reactions.length) {
        reactStatus = el('p', 'sl-reaction-status');
        reactBar = el('div', 'sl-reactions');
        buildReactions();
        root.append(reactBar, reactStatus);
      }

      root.append(form, status);
    }

    function setStatus(message, kind) {
      status.replaceChildren();
      status.removeAttribute('data-kind');
      if (kind === 'ok') { status.setAttribute('data-kind', 'ok'); status.appendChild(el('span', null, '✓')); }
      if (kind === 'err') { status.setAttribute('data-kind', 'err'); status.appendChild(el('span', null, '✕')); }
      if (kind === 'busy') { status.appendChild(el('span', 'sl-spinner')); }
      status.appendChild(document.createTextNode(message));
    }

    var MAX_DEPTH = 3;
    var REPLIES_PER_PAGE = 5;

    function buildTree(comments) {
      var byId = {};
      var roots = [];
      comments.forEach(function (c) { c.children = []; c.parentMissing = false; byId[c.id] = c; });
      comments.forEach(function (c) {
        if (c.parent_id && byId[c.parent_id]) {
          byId[c.parent_id].children.push(c);
        } else {
          if (c.parent_id) c.parentMissing = true; // parent deleted/hidden
          roots.push(c);
        }
      });
      return roots;
    }

    function renderComment(c, depth) {
      var li = el('li', 'sl-comment' + (depth > 0 ? ' sl-reply' : ''));
      var nick = (c.nickname && c.nickname.trim()) || t('anonymous');
      var avatar = el('div', 'sl-avatar', nick.charAt(0).toUpperCase());
      avatar.style.background = AVATAR_GRADIENTS[hashString(nick) % AVATAR_GRADIENTS.length];
      var main = el('div', 'sl-main');
      var head = el('div', 'sl-head');
      var nickWrap = el('span', 'sl-nick', nick);
      if (c.is_owner) nickWrap.appendChild(el('span', 'sl-owner-badge', t('author')));
      head.append(nickWrap, el('span', 'sl-time', new Date(c.created_at * 1000).toLocaleString()));
      var bodyEl = c.parentMissing ? el('p', 'sl-body sl-parent-removed', t('parentRemoved')) : el('p', 'sl-body', c.body);
      main.append(head, bodyEl);
      if (depth < MAX_DEPTH) {
        var replyBtn = el('button', 'sl-reply-btn', t('reply'));
        replyBtn.type = 'button';
        replyBtn.addEventListener('click', function () { toggleReplyForm(c, main, replyBtn); });
        main.appendChild(replyBtn);
      }
      var top = el('div', 'sl-top');
      top.append(avatar, main);
      li.append(top);
      if (c.children && c.children.length) {
        var ul = el('ul', 'sl-replies');
        var visible = c.children.slice(0, REPLIES_PER_PAGE);
        visible.forEach(function (ch) { ul.appendChild(renderComment(ch, depth + 1)); });
        var hidden = c.children.slice(REPLIES_PER_PAGE);
        if (hidden.length) {
          var more = el('li', 'sl-show-more');
          var moreBtn = el('button', 'sl-reply-btn', t('showMoreReplies').replace('{n}', String(hidden.length)));
          moreBtn.type = 'button';
          moreBtn.addEventListener('click', function () {
            hidden.forEach(function (ch) { ul.insertBefore(renderComment(ch, depth + 1), more); });
            more.remove();
          });
          more.appendChild(moreBtn);
          ul.appendChild(more);
        }
        li.appendChild(ul);
      }
      return li;
    }

    function toggleReplyForm(c, main, btn) {
      var existing = main.querySelector('.sl-reply-form');
      if (existing) { existing.remove(); btn.textContent = t('reply'); return; }
      var form = el('form', 'sl-form sl-reply-form');
      var nickInput = el('input');
      nickInput.type = 'text';
      nickInput.maxLength = 50;
      nickInput.placeholder = t('nickPlaceholder');
      nickInput.className = 'sl-nick-input';
      var bodyInput = el('textarea');
      bodyInput.maxLength = 3000;
      bodyInput.rows = 2;
      bodyInput.placeholder = t('replyPlaceholder');
      bodyInput.className = 'sl-body-input';
      var row = el('div', 'sl-form-row');
      var submit = el('button', 'sl-submit', t('post'));
      submit.type = 'submit';
      var cancel = el('button', 'sl-reply-btn', t('cancelReply'));
      cancel.type = 'button';
      cancel.addEventListener('click', function () { form.remove(); btn.textContent = t('reply'); });
      row.append(cancel, submit);
      form.append(nickInput, bodyInput, row);
      var statusEl = el('p', 'sl-status');
      form.appendChild(statusEl);
      var busy = false;
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        if (busy) return;
        var nickname = nickInput.value.trim();
        var body = bodyInput.value.trim();
        if (!body) { statusEl.textContent = t('emptyComment'); return; }
        busy = true;
        submit.disabled = true;
        statusEl.textContent = t('solving');
        fetch(
          endpoint + '/api/comments/challenge?hostContext=' + encodeURIComponent(hostContext) +
          '&articlePath=' + encodeURIComponent(articlePath)
        )
          .then(function (res) { if (!res.ok) throw new Error('challenge request failed'); return res.json(); })
          .then(function (challenge) {
            return solveWithWorker(challenge, 'comment', nickname, body).then(function (nonce) {
              return { challenge: challenge, nonce: nonce };
            });
          })
          .then(function (solved) {
            return fetch(endpoint + '/api/comments', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                challengeId: solved.challenge.challengeId,
                hostContext: solved.challenge.hostContext,
                articlePath: solved.challenge.articlePath,
                nickname: nickname,
                body: body,
                parentId: c.id,
                difficulty: solved.challenge.difficulty,
                expiresAt: solved.challenge.expiresAt,
                signature: solved.challenge.signature,
                nonce: solved.nonce
              })
            });
          })
          .then(function (res) {
            return res.json().then(function (data) { return { ok: res.ok, data: data }; });
          })
          .then(function (outcome) {
            if (outcome.ok) {
              statusEl.textContent = outcome.data.comment && outcome.data.comment.status === 'pending' ? t('pending') : t('posted');
              bodyInput.value = '';
              return loadComments();
            }
            statusEl.textContent = 'Error: ' + (outcome.data && outcome.data.error ? outcome.data.error : 'unknown');
          })
          .catch(function (err) { statusEl.textContent = 'Error: ' + err.message; })
          .finally(function () { busy = false; submit.disabled = false; });
      });
      main.appendChild(form);
      btn.textContent = t('cancelReply');
      bodyInput.focus();
    }

    function loadComments() {
      return fetch(
        endpoint + '/api/comments?article_path=' + encodeURIComponent(articlePath) +
        '&host_context=' + encodeURIComponent(hostContext)
      )
        .then(function (res) { if (!res.ok) throw new Error('failed to load comments'); return res.json(); })
        .then(function (data) {
          var comments = Array.isArray(data.comments) ? data.comments : [];
          count.textContent = countLabel(comments.length);
          list.replaceChildren();
          if (comments.length === 0) {
            list.appendChild(el('li', 'sl-empty', t('empty')));
            return;
          }
          buildTree(comments).forEach(function (r) { list.appendChild(renderComment(r, 0)); });
        });
    }

    // Cross-origin safety: a CLASSIC Worker cannot be created from a different
    // origin (`new Worker('https://other/pow-worker.js')` is blocked by the
    // browser even with CORS headers). Fix: fetch the script with CORS and
    // wrap it in a Blob URL — works from any page that can load the widget.
    function createPowWorkerUrl() {
      return fetch(workerUrl, { mode: 'cors', credentials: 'omit' })
        .then(function (res) { if (!res.ok) throw new Error('failed to load pow worker'); return res.blob(); })
        .then(function (blob) { return URL.createObjectURL(blob); });
    }

    function solveWithWorker(challenge, kind, a, b) {
      return new Promise(function (resolve, reject) {
        createPowWorkerUrl()
          .then(function (url) {
            var worker;
            try { worker = new Worker(url); } catch (err) { reject(err); return null; }
            worker.onmessage = function (e) {
              URL.revokeObjectURL(url);
              worker.terminate();
              if (e.data && e.data.type === 'nonce') resolve(e.data.nonce);
              else reject(new Error((e.data && e.data.message) || 'pow worker failed'));
            };
            worker.onerror = function () { URL.revokeObjectURL(url); worker.terminate(); reject(new Error('pow worker error')); };
            var msg = { challenge: challenge };
            if (kind === 'poll') { msg.pollId = a; msg.option = b; }
            else { msg.nickname = a; msg.body = b; }
            worker.postMessage(msg);
            return null;
          })
          .catch(reject);
      });
    }

    function submitComment(event) {
      event.preventDefault();
      var nickname = nickInput.value.trim();
      var body = bodyInput.value.trim();
      if (!body) { setStatus(t('emptyComment'), 'err'); return; }
      submitBtn.disabled = true;
      setStatus(t('solving'), 'busy');

      fetch(
        endpoint + '/api/comments/challenge?hostContext=' + encodeURIComponent(hostContext) +
        '&articlePath=' + encodeURIComponent(articlePath)
      )
        .then(function (res) { if (!res.ok) throw new Error('challenge request failed'); return res.json(); })
        .then(function (challenge) {
          return solveWithWorker(challenge, 'comment', nickname, body).then(function (nonce) {
            return { challenge: challenge, nonce: nonce };
          });
        })
        .then(function (solved) {
          return fetch(endpoint + '/api/comments', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              challengeId: solved.challenge.challengeId,
              hostContext: solved.challenge.hostContext,
              articlePath: solved.challenge.articlePath,
              nickname: nickname,
              body: body,
              difficulty: solved.challenge.difficulty,
              expiresAt: solved.challenge.expiresAt,
              signature: solved.challenge.signature,
              nonce: solved.nonce
            })
          });
        })
        .then(function (res) {
          return res.json().then(function (data) { return { ok: res.ok, data: data }; });
        })
        .then(function (outcome) {
          if (outcome.ok) {
            bodyInput.value = '';
            setStatus(
              outcome.data.comment && outcome.data.comment.status === 'pending'
                ? t('pending')
                : t('posted'),
              'ok'
            );
            return loadComments();
          }
          setStatus('Error: ' + (outcome.data && outcome.data.error ? outcome.data.error : 'unknown'), 'err');
        })
        .catch(function (err) { setStatus('Error: ' + err.message, 'err'); })
        .finally(function () { submitBtn.disabled = false; });
    }

    if (form) form.addEventListener('submit', submitComment);
    if (!reactionsOnly) loadComments();
    loadReactions();

    /* -------- reactions: load counts + submit with real PoW -------- */
    function setReactStatus(message, kind) {
      if (!reactStatus) return;
      reactStatus.textContent = message;
      if (kind) reactStatus.setAttribute('data-kind', kind);
      else reactStatus.removeAttribute('data-kind');
    }

    function setReactBusy(busy) {
      reactBusy = busy;
      reactions.forEach(function (x) {
        if (reactBtns[x]) reactBtns[x].btn.disabled = busy;
      });
    }

    function renderReactionCounts(counts) {
      var map = {};
      counts.forEach(function (r) { map[r.reaction] = Number(r.count) || 0; });
      reactions.forEach(function (x) {
        if (reactBtns[x]) reactBtns[x].count.textContent = String(map[x] || 0);
      });
    }

    function loadReactions() {
      if (!reactBar) return;
      fetch(endpoint + '/api/reactions?article_path=' + encodeURIComponent(articlePath))
        .then(function (res) { if (!res.ok) throw new Error('failed to load reactions'); return res.json(); })
        .then(function (data) {
          if (Array.isArray(data.reactions)) renderReactionCounts(data.reactions);
        })
        .catch(function () { /* keep last known counts */ });
    }

    function submitReaction(r) {
      if (reactBusy || !reactBtns[r]) return;
      setReactBusy(true);
      setReactStatus(t('solving'));
      fetch(
        endpoint + '/api/reactions/challenge?hostContext=' + encodeURIComponent(hostContext) +
        '&articlePath=' + encodeURIComponent(articlePath)
      )
        .then(function (res) { if (!res.ok) throw new Error('challenge request failed'); return res.json(); })
        .then(function (challenge) {
          return solveWithWorker(challenge, 'comment', '', '').then(function (nonce) {
            return { challenge: challenge, nonce: nonce };
          });
        })
        .then(function (solved) {
          return fetch(endpoint + '/api/reactions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              challengeId: solved.challenge.challengeId,
              hostContext: solved.challenge.hostContext,
              articlePath: solved.challenge.articlePath,
              reaction: r,
              difficulty: solved.challenge.difficulty,
              expiresAt: solved.challenge.expiresAt,
              signature: solved.challenge.signature,
              nonce: solved.nonce
            })
          });
        })
        .then(function (res) {
          return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
        })
        .then(function (outcome) {
          if (outcome.ok) {
            setReactStatus(t('reactionRecorded'), 'ok');
            if (Array.isArray(outcome.data.reactions)) renderReactionCounts(outcome.data.reactions);
          } else if (outcome.status === 429) {
            setReactStatus(t('slowDown'), 'err');
          } else if (outcome.status === 409) {
            setReactStatus(t('challengeUsed'), 'err');
          } else {
            setReactStatus(
              'Error: ' + (outcome.data && outcome.data.error ? outcome.data.error : 'unknown'),
              'err'
            );
          }
        })
        .catch(function (err) { setReactStatus('Error: ' + err.message, 'err'); })
        .finally(function () { setReactBusy(false); });
    }

    /* -------- standalone poll (data-poll-id) -------- */
    function initPoll() {
      // Anonymous voter token — ONLY used for single-vote polls, lives only in
      // the visitor's browser (no cookies, no personal data, never sent to us).
      var voterKey = 'sl-voter-token';
      var voterToken = null;
      try { voterToken = localStorage.getItem(voterKey); } catch (e) { voterToken = null; }

      var heading = el('div', 'sl-poll-heading');
      var qEl = el('h3', null, '…');
      heading.appendChild(qEl);
      var statusEl = el('p', 'sl-poll-status');
      var listEl = el('ul', 'sl-poll-options');
      root.append(heading, listEl, statusEl);

      function setStatus(message, kind) {
        statusEl.replaceChildren();
        statusEl.removeAttribute('data-kind');
        if (kind === 'ok') { statusEl.setAttribute('data-kind', 'ok'); statusEl.appendChild(el('span', null, '✓')); }
        else if (kind === 'err') { statusEl.setAttribute('data-kind', 'err'); statusEl.appendChild(el('span', null, '✕')); }
        else if (kind === 'busy') { statusEl.appendChild(el('span', 'sl-spinner')); }
        statusEl.appendChild(document.createTextNode(message));
      }

      function renderPoll(poll) {
        qEl.textContent = poll.question || '';
        var opts = Array.isArray(poll.options) ? poll.options : [];
        var total = Number(poll.total) || 0;
        // Show results after voting (or when closed), or ALWAYS when configured.
        var showResults = poll.status !== 'open' || !!poll.voted || pollResults === 'always';
        listEl.replaceChildren();
        opts.forEach(function (o) {
          var c = poll.counts && poll.counts[o] ? Number(poll.counts[o]) : 0;
          var pct = total > 0 ? Math.round((c / total) * 100) : 0;
          var li = el('li', 'sl-poll-option');
          if (showResults) {
            if (pollStyle !== 'counts') {
              var label = el('div', 'sl-poll-opt-label');
              var meta;
              if (pollStyle === 'percent') meta = pct + '%';
              else if (pollStyle === 'minimal') meta = '';
              else meta = c + ' · ' + pct + '%';
              label.append(el('span', 'sl-poll-opt-name', o), el('span', 'sl-poll-opt-meta', meta));
              var bar = el('div', 'sl-poll-bar');
              var fill = el('div', 'sl-poll-fill');
              fill.style.width = pct + '%';
              bar.appendChild(fill);
              li.append(label, bar);
            } else {
              var cLabel = el('div', 'sl-poll-opt-label');
              cLabel.append(el('span', 'sl-poll-opt-name', o), el('span', 'sl-poll-opt-meta', String(c)));
              li.appendChild(cLabel);
            }
          } else {
            var btn = el('button', 'sl-poll-btn', o);
            btn.type = 'button';
            btn.addEventListener('click', function () { vote(o, btn); });
            li.appendChild(btn);
          }
          listEl.appendChild(li);
        });
        if (showResults) {
          setStatus(poll.status !== 'open' ? t('closed') : t('voted'), poll.status !== 'open' ? undefined : 'ok');
        } else {
          setStatus('');
        }
      }

      function findIn(data) {
        var found = null;
        (Array.isArray(data.polls) ? data.polls : []).forEach(function (p) { if (p.id === pollId) found = p; });
        return found;
      }
      function loadPoll() {
        var suffix = voterToken ? '&voterToken=' + encodeURIComponent(voterToken) : '';
        return fetch(endpoint + '/api/polls?article_path=' + encodeURIComponent(articlePath) + suffix)
          .then(function (res) { if (!res.ok) throw new Error(t('pollLoadError')); return res.json(); })
          .then(function (data) {
            var found = findIn(data);
            if (found) { renderPoll(found); return; }
            // Global poll fallback (article path is optional): look up by id.
            return fetch(endpoint + '/api/polls?id=' + encodeURIComponent(pollId) + suffix)
              .then(function (res2) { if (!res2.ok) throw new Error(t('pollLoadError')); return res2.json(); })
              .then(function (data2) {
                var g = findIn(data2);
                if (g) { renderPoll(g); return; }
                qEl.textContent = t('pollMissing');
              });
          })
          .catch(function () { setStatus(t('pollLoadError'), 'err'); });
      }

      function vote(option, btn) {
        if (btn.disabled) return;
        btn.disabled = true;
        setStatus(t('solving'), 'busy');
        fetch(
          endpoint + '/api/polls/challenge?hostContext=' + encodeURIComponent(hostContext) +
          '&articlePath=' + encodeURIComponent(articlePath)
        )
          .then(function (res) { if (!res.ok) throw new Error('challenge request failed'); return res.json(); })
          .then(function (challenge) {
            return solveWithWorker(challenge, 'poll', pollId, option).then(function (nonce) {
              return { challenge: challenge, nonce: nonce };
            });
          })
          .then(function (solved) {
            var payload = {
              challengeId: solved.challenge.challengeId,
              hostContext: solved.challenge.hostContext,
              articlePath: solved.challenge.articlePath,
              pollId: pollId,
              option: option,
              difficulty: solved.challenge.difficulty,
              expiresAt: solved.challenge.expiresAt,
              signature: solved.challenge.signature,
              nonce: solved.nonce
            };
            if (voterToken) payload.voterToken = voterToken;
            return fetch(endpoint + '/api/polls/vote', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload)
            });
          })
          .then(function (res) {
            return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
          })
          .then(function (outcome) {
            if (outcome.ok) {
              if (outcome.data.voterToken) {
                voterToken = outcome.data.voterToken;
                try { localStorage.setItem(voterKey, voterToken); } catch (e) { /* private mode */ }
              }
              renderPoll(outcome.data.poll);
            } else if (outcome.status === 409) {
              setStatus(t('alreadyVoted'), 'err');
              loadPoll();
            } else {
              setStatus('Error: ' + (outcome.data && outcome.data.error ? outcome.data.error : 'unknown'), 'err');
            }
          })
          .catch(function (err) { setStatus('Error: ' + err.message, 'err'); })
          .finally(function () { btn.disabled = false; });
      }

      loadPoll();
    }
  }

  function unmount(root) {
    if (!root) return;
    root.__slMounted = false;
    root.classList.remove('sl-root');
    root.replaceChildren();
  }

  function initAll() {
    injectStyles();
    var roots = document.querySelectorAll('[data-staticlayer]');
    for (var i = 0; i < roots.length; i += 1) mount(roots[i]);
    if (typeof window !== 'undefined') {
      window.StaticLayer = { mount: mount, unmount: unmount };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
