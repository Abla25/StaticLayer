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

  loginForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var password = document.getElementById('password').value;
    showStatus(loginStatus, '');
    api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: password }), csrf: false })
      .then(function (data) { csrf = data.csrf; showApp(null); })
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
    var body = el('p', 'body', c.body); // textContent only — XSS-safe
    var actions = el('div', 'actions');
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
      })
      .catch(function (err) { showStatus(document.getElementById('settings-status'), 'Error: ' + err.message, true); });
  }
  document.getElementById('settings-save').addEventListener('click', function () {
    var payload = {
      settings: {
        pow_difficulty: parseInt(document.getElementById('set-difficulty').value, 10),
        reaction_options: document.getElementById('set-reactions').value.trim(),
        moderation_mode: document.getElementById('set-mode').value
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
      body: JSON.stringify({ settings: { pow_difficulty: 16, reaction_options: '👍,❤️,🎉', moderation_mode: 'open' } })
    })
      .then(function () { loadSettings(); showStatus(document.getElementById('settings-status'), 'Reset to defaults ✓'); })
      .catch(function (err) { showStatus(document.getElementById('settings-status'), 'Error: ' + err.message, true); });
  });
})();

