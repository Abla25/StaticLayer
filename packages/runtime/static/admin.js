/**
 * StaticLayer admin UI (external script — CSP script-src 'self' forbids inline
 * scripts, so all logic lives here).
 *
 * The CSRF token is kept in a JS variable in memory ONLY — never in
 * localStorage/sessionStorage/cookies. Comment rendering uses textContent only
 * (XSS-safe). No tracking, no analytics, no external requests.
 */
(function () {
  'use strict';

  var csrf = null;
  var PAGE_SIZE = 20;

  // Tab state
  var state = {
    queue: { q: '', article: '', page: 1, selected: {} },
    published: { q: '', article: '', page: 1, selected: {} }
  };

  // ---- helpers ----------------------------------------------------------
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function showStatus(node, message, isError) {
    node.textContent = message;
    node.classList.toggle('err', !!isError);
    node.classList.toggle('ok', !isError && !!message && message.indexOf('Error') === -1);
  }
  function debounce(fn, ms) {
    var t = 0;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }
  function api(path, options) {
    var opts = options || {};
    opts.credentials = 'same-origin';
    if (csrf && opts.csrf !== false) {
      opts.headers = Object.assign({}, opts.headers, { 'X-CSRF-Token': csrf });
    }
    if (opts.body !== undefined && !opts.headers) opts.headers = { 'content-type': 'application/json' };
    else if (opts.body !== undefined) opts.headers['content-type'] = 'application/json';
    return fetch(path, opts).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) { var e = new Error((data && data.error) || ('request failed (' + res.status + ')')); e.status = res.status; throw e; }
        return data;
      });
    });
  }
  function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
  function nickOf(c) { return (c.nickname && c.nickname.trim()) || 'Anonymous'; }
  function timeStr(sec) { return new Date(sec * 1000).toLocaleString(); }
  function esc(s) { return s; } // placeholder — we use textContent, never innerHTML

  // ---- login ------------------------------------------------------------
  var loginView = document.getElementById('login-view');
  var adminView = document.getElementById('admin-view');
  var loginForm = document.getElementById('login-form');
  var loginStatus = document.getElementById('login-status');
  var accessBtn = document.getElementById('access-btn');
  var accessDivider = document.getElementById('access-divider');

  function showApp(me) {
    loginView.classList.add('hidden');
    adminView.classList.remove('hidden');
    if (me && me.email && me.via === 'cloudflare-access') {
      document.getElementById('whoami').textContent = 'Signed in via Cloudflare as ' + me.email;
    }
    loadPages();
    loadQueue();
    loadPublished();
  }

  // Restore an existing session on load (no need to re-type the password; also
  // lets the keychain save it after the POST reload below).
  api('/api/admin/session', { csrf: false })
    .then(function (data) {
      if (data && data.authed) { csrf = data.csrf; showApp(null); }
    })
    .catch(function () { /* not signed in */ });

  loginForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var password = document.getElementById('password').value;
    showStatus(loginStatus, '');
    api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: password }), csrf: false })
      .then(function (data) {
        csrf = data.csrf;
        showApp(null);
        // Offer the browser keychain to save the admin password: submit a real
        // POST form to this same page — the server answers with admin.html, the
        // browser offers to store the credentials, and the reload restores the
        // session via /api/admin/session above.
        try {
          var save = document.createElement('form');
          save.method = 'POST';
          save.action = window.location.pathname;
          var u = document.createElement('input'); u.type = 'text'; u.name = 'username'; u.value = 'admin'; u.autocomplete = 'username';
          var p = document.createElement('input'); p.type = 'password'; p.name = 'password'; p.value = password; p.autocomplete = 'current-password';
          save.appendChild(u); save.appendChild(p);
          save.style.display = 'none';
          document.body.appendChild(save);
          save.submit();
        } catch (e) { /* keychain offer is best-effort */ }
      })
      .catch(function () { showStatus(loginStatus, 'Incorrect password.', true); });
  });

  accessBtn.addEventListener('click', function () {
    showStatus(loginStatus, 'Verifying Cloudflare session…');
    api('/api/admin/access', { method: 'POST', csrf: false })
      .then(function (data) {
        csrf = data.csrf;
        showApp(data);
      })
      .catch(function (err) { showStatus(loginStatus, 'Cloudflare sign-in failed: ' + err.message, true); });
  });

  // Hide the Cloudflare button when Access is not configured.
  api('/api/admin/access', { method: 'GET', csrf: false })
    .then(function (data) {
      if (!data.configured) { accessBtn.classList.add('hidden'); accessDivider.classList.add('hidden'); }
    })
    .catch(function () { /* keep visible; harmless */ });

  document.getElementById('signout').addEventListener('click', function () {
    api('/api/admin/logout', { method: 'POST', csrf: false }).catch(function () {});
    csrf = null;
    adminView.classList.add('hidden');
    loginView.classList.remove('hidden');
    document.getElementById('password').value = '';
  });

  // ---- tabs -------------------------------------------------------------
  var tabButtons = document.querySelectorAll('.tab');
  var tabSections = {
    queue: document.getElementById('tab-queue'),
    published: document.getElementById('tab-published'),
    pages: document.getElementById('tab-pages'),
    lists: document.getElementById('tab-lists'),
    settings: document.getElementById('tab-settings'),
    widget: document.getElementById('tab-widget'),
    polls: document.getElementById('tab-polls'),
    updates: document.getElementById('tab-updates')
  };
  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabButtons.forEach(function (b) { b.classList.toggle('active', b === btn); });
      Object.keys(tabSections).forEach(function (k) { tabSections[k].classList.toggle('hidden', k !== btn.getAttribute('data-tab')); });
      var tab = btn.getAttribute('data-tab');
      if (tab === 'pages') loadPages();
      else if (tab === 'lists') loadLists();
      else if (tab === 'settings') loadSettings();
      else if (tab === 'widget') loadWidget();
      else if (tab === 'polls') loadPolls();
      else if (tab === 'updates') loadUpdates();
      else if (tab === 'queue') loadQueue();
      else if (tab === 'published') loadPublished();
    });
  });

  // ---- queue ------------------------------------------------------------
  function loadQueue() {
    var s = state.queue;
    var q = document.getElementById('q-input').value.trim();
    var article = document.getElementById('article-filter').value;
    s.q = q; s.article = article;
    var params = 'status=pending&page=' + s.page + '&perPage=' + PAGE_SIZE;
    if (q) params += '&q=' + encodeURIComponent(q);
    if (article) params += '&article=' + encodeURIComponent(article);
    api('/api/admin/comments?' + params)
      .then(function (data) {
        renderComments('queue', data.comments, 'pending');
        document.getElementById('queue-count').textContent = data.total + (data.total === 1 ? ' comment' : ' comments');
        renderPager('queue', data);
      })
      .catch(function (err) { showStatus(document.getElementById('queue-status'), 'Error: ' + err.message, true); });
  }

  document.getElementById('q-input').addEventListener('input', debounce(function () { state.queue.page = 1; loadQueue(); }, 250));
  document.getElementById('article-filter').addEventListener('change', function () { state.queue.page = 1; loadQueue(); });

  // ---- published --------------------------------------------------------
  function loadPublished() {
    var s = state.published;
    var q = document.getElementById('pub-q-input').value.trim();
    var article = document.getElementById('pub-article-filter').value;
    s.q = q; s.article = article;
    var params = 'status=approved&page=' + s.page + '&perPage=' + PAGE_SIZE;
    if (q) params += '&q=' + encodeURIComponent(q);
    if (article) params += '&article=' + encodeURIComponent(article);
    api('/api/admin/comments?' + params)
      .then(function (data) {
        renderComments('published', data.comments, 'approved');
        document.getElementById('pub-count').textContent = data.total + (data.total === 1 ? ' comment' : ' comments');
        renderPager('published', data);
      })
      .catch(function (err) { showStatus(document.getElementById('pub-status'), 'Error: ' + err.message, true); });
  }

  document.getElementById('pub-q-input').addEventListener('input', debounce(function () { state.published.page = 1; loadPublished(); }, 250));
  document.getElementById('pub-article-filter').addEventListener('change', function () { state.published.page = 1; loadPublished(); });

  // ---- comment rendering (shared) --------------------------------------
  function commentCard(c, kind) {
    var nick = nickOf(c);
    var li = el('li', 'comment');
    var cb = el('input', 'cb');
    cb.type = 'checkbox';
    var isSelected = state[kind].selected[c.id] === true;
    cb.checked = isSelected;
    cb.addEventListener('change', function () {
      if (cb.checked) state[kind].selected[c.id] = true;
      else delete state[kind].selected[c.id];
      updateBulkbar(kind);
    });
    var avatar = el('div', 'avatar', nick.charAt(0).toUpperCase());
    var main = el('div', 'main');
    var head = el('div', 'head');

    var nickWrap = el('span', 'nick', nick);
    if (nick !== 'Anonymous') {
      var ban = el('button', 'ban-link', '· ban');
      ban.title = 'Add to blocklist';
      ban.addEventListener('click', function () {
        addListValue('block', nick);
      });
      nickWrap.appendChild(ban);
    }
    head.append(nickWrap, el('span', 'time', timeStr(c.created_at)));
    if (c.article_path) head.appendChild(el('span', 'chip', c.article_path));
    if (c.parent_id) {
      var pn = (c.parent_nickname && c.parent_nickname.trim()) || '…';
      head.appendChild(el('span', 'chip allow', '↳ reply to ' + pn));
    }
    var body = el('p', 'body', c.body); // textContent only — XSS-safe
    var actions = el('div', 'actions');
    // Reply as the site owner (marked with an "Author" badge on the widget).
    var replyBtn = el('button', 'btn ghost sm', 'Reply');
    replyBtn.addEventListener('click', function () {
      var existing = main.querySelector('.reply-box');
      if (existing) { existing.remove(); return; }
      var box = el('div', 'reply-box');
      var ta = el('textarea', 'reply-ta', '');
      ta.rows = 2;
      ta.maxLength = 3000;
      ta.placeholder = 'Write your reply as the site owner…';
      var row = el('div', 'row');
      var send = el('button', 'btn ok sm', 'Send');
      var cancel = el('button', 'btn ghost sm', 'Cancel');
      cancel.addEventListener('click', function () { box.remove(); });
      send.addEventListener('click', function () {
        var text = ta.value.trim();
        if (!text) return;
        send.disabled = true;
        api('/api/admin/comments/' + encodeURIComponent(c.id) + '/reply', { method: 'POST', body: JSON.stringify({ body: text }) })
          .then(function () {
            if (kind === 'queue') loadQueue();
            else loadPublished();
          })
          .catch(function (err) {
            showStatus(document.getElementById(kind === 'queue' ? 'queue-status' : 'pub-status'), 'Error: ' + err.message, true);
            send.disabled = false;
          });
      });
      row.append(cancel, send);
      box.append(ta, row);
      main.appendChild(box);
      ta.focus();
    });
    actions.appendChild(replyBtn);
    if (kind === 'queue') {
      var appr = el('button', 'btn ok sm', 'Approve');
      var del = el('button', 'btn danger sm', 'Delete');
      appr.addEventListener('click', function () { moderate(c.id, 'approve'); });
      del.addEventListener('click', function () { moderate(c.id, 'delete'); });
      actions.append(appr, del);
    } else {
      var unappr = el('button', 'btn ghost sm', 'Unapprove');
      var del2 = el('button', 'btn danger sm', 'Delete');
      unappr.addEventListener('click', function () { moderate(c.id, 'unapprove'); });
      del2.addEventListener('click', function () { moderate(c.id, 'delete'); });
      actions.append(unappr, del2);
    }
    main.append(head, body, actions);
    li.append(cb, avatar, main);
    return li;
  }

  function renderComments(kind, comments, _status) {
    var listEl = kind === 'queue' ? document.getElementById('queue-list') : document.getElementById('published-list');
    listEl.replaceChildren();
    if (!comments || comments.length === 0) {
      listEl.appendChild(el('li', 'empty', kind === 'queue'
        ? 'No comments awaiting approval. 🎉'
        : 'No published comments yet.'));
      return;
    }
    comments.forEach(function (c) { listEl.appendChild(commentCard(c, kind)); });
    updateBulkbar(kind);
  }

  function updateBulkbar(kind) {
    var count = Object.keys(state[kind].selected).length;
    var bar = kind === 'queue' ? document.getElementById('bulkbar') : document.getElementById('pub-bulkbar');
    bar.classList.toggle('show', count > 0);
    (kind === 'queue' ? document.getElementById('sel-count') : document.getElementById('pub-sel-count')).textContent = count + ' selected';
  }

  function moderate(id, action) {
    if (!csrf) return;
    var options = {
      headers: {}
    };
    if (action === 'approve' || action === 'unapprove') {
      options.method = 'PATCH';
      options.body = JSON.stringify({ status: action === 'approve' ? 'approved' : 'pending' });
    } else {
      options.method = 'DELETE';
    }
    api('/api/admin/comments/' + encodeURIComponent(id), options)
      .then(function () {
        loadQueue();
        loadPublished();
        loadPages();
        loadLists();
      })
      .catch(function (err) {
        showStatus(document.getElementById('queue-status'), 'Error: ' + err.message, true);
      });
  }

  // ---- bulk -------------------------------------------------------------
  function bulkAction(kind, action) {
    var ids = Object.keys(state[kind].selected);
    if (ids.length === 0) return;
    api('/api/admin/comments/bulk', { method: 'POST', body: JSON.stringify({ ids: ids, action: action }) })
      .then(function () {
        state[kind].selected = {};
        loadQueue();
        loadPublished();
        loadPages();
        loadLists();
      })
      .catch(function (err) {
        showStatus(document.getElementById(kind === 'queue' ? 'queue-status' : 'pub-status'), 'Error: ' + err.message, true);
      });
  }
  document.getElementById('bulk-approve').addEventListener('click', function () { bulkAction('queue', 'approve'); });
  document.getElementById('bulk-delete').addEventListener('click', function () { bulkAction('queue', 'delete'); });
  document.getElementById('bulk-unapprove').addEventListener('click', function () { bulkAction('published', 'unapprove'); });
  document.getElementById('pub-bulk-delete').addEventListener('click', function () { bulkAction('published', 'delete'); });

  // ---- pagination -------------------------------------------------------
  function renderPager(kind, data) {
    var pager = kind === 'queue' ? document.getElementById('queue-pager') : document.getElementById('pub-pager');
    pager.replaceChildren();
    if (!data || data.pages <= 1) {
      pager.appendChild(el('span', 'info', data.total + ' total'));
      return;
    }
    var prev = el('button', 'btn ghost sm', '← Prev');
    var info = el('span', 'info', 'Page ' + data.page + ' of ' + data.pages + ' · ' + data.total + ' total');
    var next = el('button', 'btn ghost sm', 'Next →');
    prev.disabled = data.page <= 1;
    next.disabled = data.page >= data.pages;
    prev.addEventListener('click', function () { state[kind].page -= 1; loadQueueOrPub(kind); });
    next.addEventListener('click', function () { state[kind].page += 1; loadQueueOrPub(kind); });
    pager.append(prev, info, next);
  }
  function loadQueueOrPub(kind) {
    if (kind === 'queue') loadQueue(); else loadPublished();
  }

  // ---- pages ------------------------------------------------------------
  function loadPages() {
    var list = document.getElementById('pages-list');
    var status = document.getElementById('pages-status');
    api('/api/admin/articles')
      .then(function (data) {
        var articles = Array.isArray(data.articles) ? data.articles : [];
        list.replaceChildren();
        if (articles.length === 0) {
          list.appendChild(el('li', 'empty', 'No comments yet on any page.'));
          showStatus(status, '');
          return;
        }
        articles.forEach(function (a) {
          var row = el('li', 'page-row');
          row.appendChild(el('span', 'path', a.article_path));
          var counts = el('div', 'counts');
          counts.append(
            el('span', 'count-pill total', a.total + ' total'),
            el('span', 'count-pill pending', a.pending + ' pending'),
            el('span', 'count-pill approved', a.approved + ' approved'),
            el('span', 'count-pill total', a.reactions + ' reactions')
          );
          row.appendChild(counts);
          row.addEventListener('click', function () {
            // Filter the queue to this page.
            document.getElementById('article-filter').value = a.article_path;
            state.queue.page = 1;
            state.queue.selected = {};
            tabButtons.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === 'queue'); });
            Object.keys(tabSections).forEach(function (k) { tabSections[k].classList.toggle('hidden', k !== 'queue'); });
            loadQueue();
            loadArticleFilters();
          });
          list.appendChild(row);
        });
        showStatus(status, '');
      })
      .catch(function (err) { showStatus(status, 'Error: ' + err.message, true); });
    loadArticleFilters();
  }

  function loadArticleFilters() {
    api('/api/admin/articles').then(function (data) {
      var articles = Array.isArray(data.articles) ? data.articles : [];
      ['article-filter', 'pub-article-filter'].forEach(function (id) {
        var sel = document.getElementById(id);
        var current = sel.value;
        sel.replaceChildren();
        var all = el('option', null, 'All pages');
        all.value = '';
        sel.appendChild(all);
        articles.forEach(function (a) {
          var opt = el('option', null, a.article_path);
          opt.value = a.article_path;
          sel.appendChild(opt);
        });
        if (current) sel.value = current;
      });
    }).catch(function () {});
  }

  // ---- lists ------------------------------------------------------------
  function loadLists() {
    api('/api/admin/lists')
      .then(function (data) {
        renderChips('allow-chips', data.allow, 'allow');
        renderChips('block-chips', data.block, 'block');
        return api('/api/admin/terms');
      })
      .then(function (data) {
        renderTermChips(data.terms || []);
      })
      .catch(function (err) { showStatus(document.getElementById('lists-status'), 'Error: ' + err.message, true); });
  }
  function renderChips(id, items, kind) {
    var box = document.getElementById(id);
    box.replaceChildren();
    items.forEach(function (item) {
      var chip = el('span', 'chip ' + kind, item.value);
      var x = el('button', 'x', '×');
      x.title = 'Remove';
      x.addEventListener('click', function () {
        api('/api/admin/lists/' + item.id, { method: 'DELETE' })
          .then(loadLists)
          .catch(function (err) { showStatus(document.getElementById('lists-status'), 'Error: ' + err.message, true); });
      });
      chip.appendChild(x);
      box.appendChild(chip);
    });
    if (items.length === 0) box.appendChild(el('span', 'chip', 'empty'));
  }
  function addListValue(kind, value) {
    api('/api/admin/lists', { method: 'POST', body: JSON.stringify({ kind: kind, value: value }) })
      .then(loadLists)
      .catch(function (err) { showStatus(document.getElementById('lists-status'), 'Error: ' + err.message, true); });
  }
  document.getElementById('allow-add').addEventListener('click', function () {
    var v = document.getElementById('allow-input').value;
    if (!v.trim()) return;
    addListValue('allow', v);
    document.getElementById('allow-input').value = '';
  });
  document.getElementById('block-add').addEventListener('click', function () {
    var v = document.getElementById('block-input').value;
    if (!v.trim()) return;
    addListValue('block', v);
    document.getElementById('block-input').value = '';
  });
  ['allow-input', 'block-input'].forEach(function (id) {
    document.getElementById(id).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById(id === 'allow-input' ? 'allow-add' : 'block-add').click();
      }
    });
  });

  // ---- blocked terms -----------------------------------------------------
  function renderTermChips(terms) {
    var box = document.getElementById('term-chips');
    box.replaceChildren();
    terms.forEach(function (item) {
      var chip = el('span', 'chip block', '"' + item.term + '"');
      var x = el('button', 'x', '×');
      x.title = 'Remove term';
      x.addEventListener('click', function () {
        api('/api/admin/terms/' + item.id, { method: 'DELETE' })
          .then(loadLists)
          .catch(function (err) { showStatus(document.getElementById('lists-status'), 'Error: ' + err.message, true); });
      });
      chip.appendChild(x);
      box.appendChild(chip);
    });
    if (terms.length === 0) box.appendChild(el('span', 'chip', 'no terms blocked'));
  }
  document.getElementById('term-add').addEventListener('click', function () {
    var v = document.getElementById('term-input').value;
    if (!v.trim()) return;
    api('/api/admin/terms', { method: 'POST', body: JSON.stringify({ term: v }) })
      .then(loadLists)
      .catch(function (err) { showStatus(document.getElementById('lists-status'), 'Error: ' + err.message, true); });
    document.getElementById('term-input').value = '';
  });
  document.getElementById('term-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('term-add').click(); }
  });

  // ---- updates -----------------------------------------------------------
  function loadUpdates() {
    var card = document.getElementById('updates-card');
    var status = document.getElementById('updates-status');
    var detail = document.getElementById('updates-detail');
    status.textContent = 'Checking…';
    detail.textContent = '';
    api('/api/admin/updates', { csrf: false })
      .then(function (data) {
        card.replaceChildren();
        if (data.error) {
          card.appendChild(el('p', 'lsub', 'You are on v' + data.current + '.'));
          status.textContent = 'Could not reach the update server (' + data.error + ').';
          status.classList.add('err');
          return;
        }
        if (data.updateAvailable) {
          card.appendChild(el('p', 'lsub', 'A newer release is available: <b>v' + data.latest + '</b> (you are on v' + data.current + ').'));
          card.appendChild(el('p', 'lsub', 'Update with the hosted installer — it re-deploys the latest version into your account and <b>preserves your secrets</b> (including the admin password).'));
          var row = el('div', 'row');
          var open = el('a', 'btn', 'Open hosted installer →');
          open.href = data.installerUrl || 'https://staticlayer-installer.staticlayer.workers.dev';
          open.target = '_blank';
          open.rel = 'noopener';
          row.appendChild(open);
          card.appendChild(row);
          status.textContent = 'Update available — ' + (data.date || '');
          status.classList.remove('err');
          status.classList.add('ok');
          if (data.notes) detail.textContent = data.notes;
        } else {
          card.appendChild(el('p', 'lsub', 'You are on the latest release (<b>v' + data.current + '</b>).'));
          status.textContent = 'Up to date';
          status.classList.remove('err');
          status.classList.add('ok');
          if (data.notes) detail.textContent = data.notes;
        }
      })
      .catch(function (err) { status.textContent = 'Error: ' + err.message; status.classList.add('err'); });
  }

  // ---- settings ---------------------------------------------------------
  function loadSettings() {
    api('/api/admin/settings')
      .then(function (data) {
        var s = data.settings || {};
        document.getElementById('set-difficulty').value = s.pow_difficulty;
        document.getElementById('set-reactions').value = s.reaction_options || '';
        document.getElementById('set-mode').value = s.moderation_mode === 'allowlist' ? 'allowlist' : 'open';
        document.getElementById('set-telegram-alerts').value = s.telegram_alerts === 'on' ? 'on' : 'off';
        document.getElementById('set-telegram-token').value = s.telegram_bot_token || '';
        document.getElementById('set-telegram-chat').value = s.telegram_chat_id || '';
        document.getElementById('set-owner-nick').value = s.owner_nickname || 'Site owner';
      })
      .catch(function (err) { showStatus(document.getElementById('settings-status'), 'Error: ' + err.message, true); });
    // Show the step-by-step Cloudflare Access guide only when Access is not
    // configured yet.
    api('/api/admin/access', { csrf: false })
      .then(function (data) {
        var guide = document.getElementById('access-guide');
        if (guide) {
          guide.classList.toggle('hidden', !!(data && data.configured));
          document.getElementById('access-domain').textContent = location.origin;
        }
      })
      .catch(function () { /* keep guide hidden on errors */ });
  }
  document.getElementById('settings-save').addEventListener('click', function () {
    var payload = {
      settings: {
        pow_difficulty: parseInt(document.getElementById('set-difficulty').value, 10),
        reaction_options: document.getElementById('set-reactions').value.trim(),
        moderation_mode: document.getElementById('set-mode').value,
        telegram_alerts: document.getElementById('set-telegram-alerts').value,
        telegram_bot_token: document.getElementById('set-telegram-token').value.trim(),
        telegram_chat_id: document.getElementById('set-telegram-chat').value.trim(),
        owner_nickname: document.getElementById('set-owner-nick').value.trim()
      }
    };
    showStatus(document.getElementById('settings-status'), '');
    api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) })
      .then(function () { showStatus(document.getElementById('settings-status'), 'Settings saved ✓'); })
      .catch(function (err) { showStatus(document.getElementById('settings-status'), 'Error: ' + err.message, true); });
  });
  document.getElementById('settings-reset').addEventListener('click', function () {
    api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings: { pow_difficulty: 16, reaction_options: '👍,❤️,🎉', moderation_mode: 'open', telegram_alerts: 'off', telegram_bot_token: '', telegram_chat_id: '', owner_nickname: 'Site owner' } })
    })
      .then(function () { loadSettings(); showStatus(document.getElementById('settings-status'), 'Reset to defaults ✓'); })
      .catch(function (err) { showStatus(document.getElementById('settings-status'), 'Error: ' + err.message, true); });
  });

  // ---- widget builder --------------------------------------------------
  // Generates the copy-paste embed snippet. All options are stored locally in
  // the browser (localStorage) — nothing is sent to the server.
  var WIDGET_KEY = 'sl-widget-config';
  var widgetFields = ['w-reactions', 'w-path', 'w-lang', 'w-theme', 'w-accent-text', 'w-radius', 'w-maxwidth', 'w-texts', 'w-poll', 'w-poll-style', 'w-poll-results'];

  function widgetDefaults() {
    return { mode: 'both', reactions: '👍,❤️,🎉', path: '', lang: 'auto', theme: 'auto', accent: '#f57d1f', radius: '14', maxwidth: '640', texts: '', pollId: '', pollStyle: 'bars', pollResults: 'after' };
  }
  function widgetState() {
    var s = widgetDefaults();
    var checked = document.querySelector('input[name="w-mode"]:checked');
    s.mode = checked ? checked.value : 'both';
    s.reactions = document.getElementById('w-reactions').value.trim();
    s.path = document.getElementById('w-path').value.trim();
    s.lang = document.getElementById('w-lang').value;
    s.theme = document.getElementById('w-theme').value;
    var accent = document.getElementById('w-accent-text').value.trim();
    s.accent = accent || document.getElementById('w-accent').value;
    s.radius = document.getElementById('w-radius').value;
    s.maxwidth = document.getElementById('w-maxwidth').value;
    s.texts = document.getElementById('w-texts').value.trim();
    s.pollId = document.getElementById('w-poll').value;
    s.pollStyle = document.getElementById('w-poll-style').value || 'bars';
    s.pollResults = document.getElementById('w-poll-results').value || 'after';
    return s;
  }
  function escAttr(v) {
    return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function renderWidgetSnippet() {
    var s = widgetState();
    var origin = location.origin;
    // Standalone poll embed (no comments UI).
    if (s.pollId) {
      var plines = ['<!-- StaticLayer — poll -->'];
      plines.push('<div data-staticlayer');
      plines.push('     data-endpoint="' + escAttr(origin) + '"');
      plines.push('     data-poll-id="' + escAttr(s.pollId) + '"');
      if (s.path) plines.push('     data-article-path="' + escAttr(s.path) + '"');
      if (s.lang && s.lang !== 'auto') plines.push('     data-lang="' + escAttr(s.lang) + '"');
      if (s.theme && s.theme !== 'auto') plines.push('     data-theme="' + escAttr(s.theme) + '"');
      if (s.accent && s.accent !== '#f57d1f') plines.push('     data-accent="' + escAttr(s.accent) + '"');
      var pRadius = parseInt(s.radius, 10);
      if (!isNaN(pRadius) && pRadius !== 14) plines.push('     data-radius="' + pRadius + '"');
      var pMw = parseInt(s.maxwidth, 10);
      if (!isNaN(pMw) && pMw !== 640) plines.push('     data-max-width="' + pMw + '"');
      if (s.pollStyle && s.pollStyle !== 'bars') plines.push('     data-poll-style="' + escAttr(s.pollStyle) + '"');
      if (s.pollResults && s.pollResults !== 'after') plines.push('     data-poll-results="' + escAttr(s.pollResults) + '"');
      plines.push('></div>');
      plines.push('<script src="' + escAttr(origin) + '/widget.js" defer></script>');
      document.getElementById('w-snippet').value = plines.join('\n');
      return;
    }
    var lines = ['<!-- StaticLayer — ' + (s.mode === 'reactions' ? 'reactions' : s.mode === 'comments' ? 'comments' : 'comments & reactions') + ' -->'];
    lines.push('<div data-staticlayer');
    lines.push('     data-endpoint="' + escAttr(origin) + '"');
    if (s.path) lines.push('     data-article-path="' + escAttr(s.path) + '"');
    if (s.mode !== 'comments' && s.reactions) lines.push('     data-reactions="' + escAttr(s.reactions) + '"');
    if (s.mode === 'reactions') lines.push('     data-reactions-only');
    if (s.lang && s.lang !== 'auto') lines.push('     data-lang="' + escAttr(s.lang) + '"');
    if (s.theme && s.theme !== 'auto') lines.push('     data-theme="' + escAttr(s.theme) + '"');
    if (s.accent && s.accent !== '#f57d1f') lines.push('     data-accent="' + escAttr(s.accent) + '"');
    var radius = parseInt(s.radius, 10);
    if (!isNaN(radius) && radius !== 14) lines.push('     data-radius="' + radius + '"');
    var mw = parseInt(s.maxwidth, 10);
    if (!isNaN(mw) && mw !== 640) lines.push('     data-max-width="' + mw + '"');
    if (s.texts) {
      try { JSON.parse(s.texts); lines.push('     data-text=\'' + s.texts.replace(/'/g, '&#39;') + '\''); } catch (e) { /* invalid JSON — omit */ }
    }
    lines.push('></div>');
    lines.push('<script src="' + escAttr(origin) + '/widget.js" defer></script>');
    document.getElementById('w-snippet').value = lines.join('\n');
  }
  function saveWidgetState() {
    try { localStorage.setItem(WIDGET_KEY, JSON.stringify(widgetState())); } catch (e) { /* private mode — ignore */ }
  }
  function applyWidgetState(s) {
    var labels = document.querySelectorAll('#w-mode label');
    labels.forEach(function (l) { l.classList.toggle('sel', (l.querySelector('input') || {}).value === s.mode); });
    var radios = document.querySelectorAll('input[name="w-mode"]');
    radios.forEach(function (r) { r.checked = r.value === s.mode; });
    document.getElementById('w-reactions').value = s.reactions;
    document.getElementById('w-path').value = s.path;
    document.getElementById('w-lang').value = s.lang;
    document.getElementById('w-theme').value = s.theme;
    document.getElementById('w-accent').value = s.accent || '#f57d1f';
    document.getElementById('w-accent-text').value = s.accent || '';
    document.getElementById('w-radius').value = s.radius;
    document.getElementById('w-maxwidth').value = s.maxwidth;
    document.getElementById('w-texts').value = s.texts;
    document.getElementById('w-poll').value = s.pollId || '';
    document.getElementById('w-poll-style').value = s.pollStyle || 'bars';
    document.getElementById('w-poll-results').value = s.pollResults || 'after';
    var pollFields = ['w-poll-style-field', 'w-poll-results-field'];
    pollFields.forEach(function (fid) {
      var f = document.getElementById(fid);
      if (f) f.classList.toggle('hidden', !s.pollId);
    });
    var reactionsField = document.getElementById('w-reactions-field');
    if (reactionsField) reactionsField.classList.toggle('hidden', s.mode === 'comments');
    renderWidgetSnippet();
    renderPreview();
  }
  function loadWidget() {
    document.getElementById('widget-origin').textContent = location.origin;
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(WIDGET_KEY) || 'null'); } catch (e) { saved = null; }
    api('/api/admin/polls')
      .then(function (data) {
        pollsCache = Array.isArray(data.polls) ? data.polls : [];
        populatePollSelect();
        applyWidgetState(Object.assign(widgetDefaults(), saved || {}));
      })
      .catch(function () {
        applyWidgetState(Object.assign(widgetDefaults(), saved || {}));
      });
  }
  document.getElementById('w-copy').addEventListener('click', function () {
    var box = document.getElementById('w-snippet');
    function done(ok) { showStatus(document.getElementById('w-status'), ok ? 'Snippet copied to clipboard ✓' : 'Copy failed — select the text and copy manually.', !ok); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(box.value).then(function () { done(true); }, function () { done(false); });
    } else {
      box.focus(); box.select();
      try { done(document.execCommand('copy')); } catch (e) { done(false); }
    }
  });
  widgetFields.forEach(function (id) {
    var node = document.getElementById(id);
    if (!node) return;
    node.addEventListener('input', function () { saveWidgetState(); renderWidgetSnippet(); });
    node.addEventListener('change', function () {
      if (id === 'w-poll') {
        var hasPoll = !!node.value;
        ['w-poll-style-field', 'w-poll-results-field'].forEach(function (fid) {
          var f = document.getElementById(fid);
          if (f) f.classList.toggle('hidden', !hasPoll);
        });
      }
      saveWidgetState();
      renderWidgetSnippet();
    });
  });
  document.querySelectorAll('input[name="w-mode"]').forEach(function (r) {
    r.addEventListener('change', function () {
      var mode = widgetState().mode;
      document.querySelectorAll('#w-mode label').forEach(function (l) { l.classList.toggle('sel', (l.querySelector('input') || {}).value === mode); });
      var reactionsField = document.getElementById('w-reactions-field');
      if (reactionsField) reactionsField.classList.toggle('hidden', mode === 'comments');
      saveWidgetState();
      renderWidgetSnippet();
    });
  });
  document.getElementById('w-accent').addEventListener('input', function () {
    document.getElementById('w-accent-text').value = this.value;
    saveWidgetState();
    renderWidgetSnippet();
    renderPreview();
  });

  // ---- widget templates + live preview ---------------------------------
  var WIDGET_TEMPLATES = {
    classic:    { mode: 'both', reactions: '👍,❤️,🎉', path: '', lang: 'auto', theme: 'auto', accent: '#f57d1f', radius: '14', maxwidth: '640', texts: '' },
    minimal:    { mode: 'comments', reactions: '', path: '', lang: 'auto', theme: 'light', accent: '#1a1a1a', radius: '8', maxwidth: '600', texts: '' },
    vibrant:    { mode: 'both', reactions: '🔥,❤️,👏,😄', path: '', lang: 'auto', theme: 'light', accent: '#ff3d54', radius: '20', maxwidth: '700', texts: '' },
    dark:       { mode: 'both', reactions: '👍,❤️,🎉', path: '', lang: 'auto', theme: 'dark', accent: '#ff8a2a', radius: '14', maxwidth: '640', texts: '' },
    elegant:    { mode: 'comments', reactions: '', path: '', lang: 'auto', theme: 'light', accent: '#7c3aed', radius: '10', maxwidth: '560', texts: '' },
    newsletter: { mode: 'both', reactions: '👍,❤️', path: '', lang: 'it', theme: 'light', accent: '#0284c7', radius: '12', maxwidth: '520', texts: '' },
    reactions:  { mode: 'reactions', reactions: '👍,❤️,🎉,🔥', path: '', lang: 'auto', theme: 'auto', accent: '#16a34a', radius: '999', maxwidth: '640', texts: '' },
    poll:       { mode: 'comments', reactions: '', path: '', lang: 'auto', theme: 'auto', accent: '#f57d1f', radius: '14', maxwidth: '640', texts: '' }
  };
  function renderPreview() {
    var container = document.getElementById('w-preview');
    var status = document.getElementById('w-preview-status');
    if (!container) return;
    if (typeof window.StaticLayer !== 'object' || typeof window.StaticLayer.mount !== 'function') {
      showStatus(status, 'Live preview unavailable here — the widget script is not loaded.', true);
      return;
    }
    showStatus(status, '');
    var s = widgetState();
    try { window.StaticLayer.unmount(container); } catch (e) { /* not mounted */ }
    var opts = { endpoint: location.origin, articlePath: '/__staticlayer_preview__', hostContext: location.hostname };
    if (s.pollId) {
      opts.pollId = s.pollId;
      if (s.pollStyle && s.pollStyle !== 'bars') opts.pollStyle = s.pollStyle;
      if (s.pollResults && s.pollResults !== 'after') opts.pollResults = s.pollResults;
      pollsCache.forEach(function (p) { if (p.id === s.pollId && p.article_path) opts.articlePath = p.article_path; });
    }
    if (s.mode !== 'comments' && s.reactions) {
      opts.reactions = s.reactions.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    }
    if (s.mode === 'reactions') opts.reactionsOnly = true;
    if (s.lang && s.lang !== 'auto') opts.lang = s.lang;
    if (s.theme && s.theme !== 'auto') opts.theme = s.theme;
    if (s.accent) opts.accent = s.accent;
    var radius = parseInt(s.radius, 10);
    if (!isNaN(radius)) opts.radius = radius;
    var mw = parseInt(s.maxwidth, 10);
    if (!isNaN(mw)) opts.maxWidth = mw;
    if (s.texts) { try { opts.texts = JSON.parse(s.texts); } catch (e) { /* invalid JSON — use defaults */ } }
    try {
      window.StaticLayer.mount(container, opts);
    } catch (err) {
      showStatus(status, 'Preview error: ' + err.message, true);
    }
  }
  document.getElementById('w-template').addEventListener('change', function () {
    var t = WIDGET_TEMPLATES[this.value];
    if (!t) return;
    var keepPoll = document.getElementById('w-poll').value;
    var merged = Object.assign(widgetDefaults(), t);
    merged.pollId = keepPoll; // picking a template never clears the chosen poll
    applyWidgetState(merged);
    saveWidgetState();
  });

  // ---- polls (tab + widget builder) ------------------------------------
  var pollsCache = [];
  function pollSnippet(p) {
    return '<!-- StaticLayer — poll -->\n' +
      '<div data-staticlayer\n' +
      '     data-endpoint="' + escAttr(location.origin) + '"\n' +
      '     data-poll-id="' + escAttr(p.id) + '"></div>\n' +
      '<script src="' + escAttr(location.origin) + '/widget.js" defer></script>';
  }
  function copyPollsText(text, okMsg) {
    function done(ok) { showStatus(document.getElementById('polls-status'), ok ? okMsg : 'Copy failed — select and copy manually.', !ok); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else { done(false); }
  }
  function populatePollSelect() {
    var sel = document.getElementById('w-poll');
    if (!sel) return;
    var current = sel.value;
    sel.replaceChildren();
    var none = document.createElement('option');
    none.value = '';
    none.textContent = '— none (comments / reactions) —';
    sel.appendChild(none);
    pollsCache.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = (p.question || '').slice(0, 50) + ' — ' + (p.article_path || '');
      sel.appendChild(o);
    });
    sel.value = current;
  }
  function renderPolls(polls) {
    var list = document.getElementById('polls-list');
    list.replaceChildren();
    if (!polls.length) {
      list.appendChild(el('p', 'lsub', 'No polls yet — create your first one on the left.'));
      return;
    }
    polls.forEach(function (p) {
      var card = el('div', 'poll-card');
      card.appendChild(el('h4', null, p.question));
      card.appendChild(el('div', 'path', p.article_path));
      var chips = el('div', 'poll-options-mini');
      (p.options || []).forEach(function (o) {
        var c = p.counts && p.counts[o] ? p.counts[o] : 0;
        var chip = el('span', 'poll-opt-mini', o + ' — ');
        var b = document.createElement('b');
        b.textContent = c;
        chip.appendChild(b);
        chips.appendChild(chip);
      });
      card.appendChild(chips);
      var row = el('div', 'poll-actions');
      row.appendChild(el('span', 'poll-status-pill ' + p.status, p.status));
      if (p.singleVote) row.appendChild(el('span', 'poll-status-pill open', '1 vote/browser'));
      var toggle = el('button', 'btn ghost sm', p.status === 'open' ? 'Close' : 'Reopen');
      toggle.addEventListener('click', function () {
        api('/api/admin/polls/' + encodeURIComponent(p.id), {
          method: 'PATCH',
          body: JSON.stringify({ status: p.status === 'open' ? 'closed' : 'open' })
        })
          .then(function () { loadPolls(); })
          .catch(function (err) { showStatus(document.getElementById('polls-status'), 'Error: ' + err.message, true); });
      });
      row.appendChild(toggle);
      var copy = el('button', 'btn ghost sm', 'Copy snippet');
      copy.addEventListener('click', function () { copyPollsText(pollSnippet(p), 'Poll snippet copied ✓'); });
      row.appendChild(copy);
      var del = el('button', 'btn danger sm', 'Delete');
      del.addEventListener('click', function () {
        if (!window.confirm('Delete this poll and all its votes?')) return;
        api('/api/admin/polls/' + encodeURIComponent(p.id), { method: 'DELETE' })
          .then(function () { loadPolls(); })
          .catch(function (err) { showStatus(document.getElementById('polls-status'), 'Error: ' + err.message, true); });
      });
      row.appendChild(del);
      card.appendChild(row);
      list.appendChild(card);
    });
  }
  function loadPolls() {
    api('/api/admin/polls')
      .then(function (data) {
        pollsCache = Array.isArray(data.polls) ? data.polls : [];
        renderPolls(pollsCache);
        populatePollSelect();
      })
      .catch(function (err) { showStatus(document.getElementById('polls-status'), 'Error: ' + err.message, true); });
  }
  document.getElementById('poll-create').addEventListener('click', function () {
    var article = document.getElementById('poll-article').value.trim();
    var question = document.getElementById('poll-question').value.trim();
    var options = document.getElementById('poll-options').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    showStatus(document.getElementById('polls-status'), '');
    api('/api/admin/polls', {
      method: 'POST',
      body: JSON.stringify({ articlePath: article, question: question, options: options, singleVote: document.getElementById('poll-single-vote').checked })
    })
      .then(function () {
        document.getElementById('poll-question').value = '';
        document.getElementById('poll-options').value = '';
        document.getElementById('poll-single-vote').checked = false;
        loadPolls();
        renderPollPreview();
        showStatus(document.getElementById('polls-status'), 'Poll created ✓');
      })
      .catch(function (err) { showStatus(document.getElementById('polls-status'), 'Error: ' + err.message, true); });
  });

  // Live preview while typing the poll question/options. Uses the widget's
  // .sl-poll-* styles (widget.js is already loaded in the admin page).
  function renderPollPreview() {
    var box = document.getElementById('poll-preview');
    if (!box) return;
    box.replaceChildren();
    var question = document.getElementById('poll-question').value.trim() || 'Your question…';
    var options = document.getElementById('poll-options').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!options.length) options = ['Option A', 'Option B', 'Option C'];
    var head = document.createElement('h3');
    head.textContent = question;
    head.style.cssText = 'margin:0 0 14px;font-size:15px;font-weight:650;letter-spacing:-.1px;line-height:1.4';
    box.appendChild(head);
    var ul = document.createElement('ul');
    ul.style.cssText = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px';
    options.forEach(function (o) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sl-poll-btn';
      b.textContent = o;
      li.appendChild(b);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    var status = document.createElement('p');
    status.className = 'sl-poll-status';
    status.textContent = '…';
    box.appendChild(status);
  }
  ['poll-question', 'poll-options'].forEach(function (id) {
    var node = document.getElementById(id);
    if (node) node.addEventListener('input', renderPollPreview);
  });
  renderPollPreview();
})();

