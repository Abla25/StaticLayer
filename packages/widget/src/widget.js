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
      countMany: '{n} comments'
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
      countMany: '{n} commenti'
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
    '.sl-comment{display:flex;gap:12px;padding:16px 18px;background:var(--card);border:1px solid var(--border);' +
    'border-radius:var(--radius);box-shadow:var(--shadow);transition:box-shadow .18s ease,transform .18s ease,border-color .18s ease}' +
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
          comments.forEach(function (c) {
            var nick = (c.nickname && c.nickname.trim()) || t('anonymous');
            var li = el('li', 'sl-comment');
            var avatar = el('div', 'sl-avatar', nick.charAt(0).toUpperCase());
            avatar.style.background = AVATAR_GRADIENTS[hashString(nick) % AVATAR_GRADIENTS.length];
            var main = el('div', 'sl-main');
            var head = el('div', 'sl-head');
            head.append(el('span', 'sl-nick', nick), el('span', 'sl-time', new Date(c.created_at * 1000).toLocaleString()));
            var bodyEl = el('p', 'sl-body', c.body); // textContent only — XSS-safe
            main.append(head, bodyEl);
            li.append(avatar, main);
            list.appendChild(li);
          });
        });
    }

    function solveWithWorker(challenge, nickname, body) {
      return new Promise(function (resolve, reject) {
        var worker;
        try { worker = new Worker(workerUrl); } catch (err) { reject(err); return; }
        worker.onmessage = function (e) {
          worker.terminate();
          if (e.data && e.data.type === 'nonce') resolve(e.data.nonce);
          else reject(new Error((e.data && e.data.message) || 'pow worker failed'));
        };
        worker.onerror = function () { worker.terminate(); reject(new Error('pow worker error')); };
        worker.postMessage({ challenge: challenge, nickname: nickname, body: body });
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
          return solveWithWorker(challenge, nickname, body).then(function (nonce) {
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
          return solveWithWorker(challenge, '', '').then(function (nonce) {
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
