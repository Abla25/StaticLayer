/**
 * StaticLayer admin UI (external script — CSP script-src 'self' forbids inline
 * scripts, so all logic lives here).
 *
 * The CSRF token is kept in a JS variable in memory ONLY — never in
 * localStorage/sessionStorage/cookies. Comment rendering uses textContent only.
 */
(function () {
  'use strict';

  var csrf = null;

  var loginForm = document.getElementById('login-form');
  var loginStatus = document.getElementById('login-status');
  var loginView = document.getElementById('login-view');
  var adminView = document.getElementById('admin-view');
  var pendingList = document.getElementById('pending-list');
  var listStatus = document.getElementById('list-status');
  var pagesList = document.getElementById('pages-list');
  var publishedList = document.getElementById('published-list');
  var pubStatus = document.getElementById('pub-status');

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showStatus(node, message, isError) {
    node.textContent = message;
    node.classList.toggle('err', !!isError);
  }

  loginForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var password = document.getElementById('password').value;
    showStatus(loginStatus, '');
    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: password })
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (outcome) {
        if (outcome.ok && outcome.data.csrf) {
          csrf = outcome.data.csrf; // in-memory only — never persisted
          loginView.hidden = true;
          adminView.hidden = false;
          loadPages();
          loadPending();
          loadPublished();
        } else {
          showStatus(loginStatus, 'Incorrect password.', true);
        }
      })
      .catch(function () { showStatus(loginStatus, 'Sign-in failed.', true); });
  });

  function loadPages() {
    if (!pagesList) return;
    fetch('/api/admin/articles', { credentials: 'same-origin' })
      .then(function (res) { if (!res.ok) throw new Error('request failed'); return res.json(); })
      .then(function (data) {
        var articles = Array.isArray(data.articles) ? data.articles : [];
        pagesList.replaceChildren();
        if (articles.length === 0) {
          pagesList.appendChild(el('li', 'empty', 'No comments yet on any page.'));
          return;
        }
        articles.forEach(function (a) {
          var row = el('li', 'page-row');
          row.append(el('span', 'path', a.article_path));
          var counts = el('div', 'counts');
          counts.append(
            el('span', 'count-pill total', a.total + ' total'),
            el('span', 'count-pill pending', a.pending + ' pending'),
            el('span', 'count-pill approved', a.approved + ' approved')
          );
          row.append(counts);
          pagesList.appendChild(row);
        });
      })
      .catch(function () { /* non-fatal: queue still loads */ });
  }

  function loadPublished() {
    if (!publishedList) return;
    showStatus(pubStatus, 'Loading…');
    fetch('/api/admin/comments?status=approved', { credentials: 'same-origin' })
      .then(function (res) { if (!res.ok) throw new Error('request failed'); return res.json(); })
      .then(function (data) {
        var comments = Array.isArray(data.comments) ? data.comments : [];
        publishedList.replaceChildren();
        if (comments.length === 0) {
          publishedList.appendChild(el('li', 'empty', 'No published comments yet.'));
          showStatus(pubStatus, '');
          return;
        }
        comments.forEach(function (c) {
          var nick = (c.nickname && c.nickname.trim()) || 'Anonymous';
          var li = el('li', 'comment');
          var avatar = el('div', 'avatar', nick.charAt(0).toUpperCase());
          var main = el('div', 'main');
          var head = el('div', 'head');
          head.append(el('span', 'nick', nick), el('span', 'time', new Date(c.created_at * 1000).toLocaleString()));
          if (c.article_path) head.append(el('span', 'page-chip', c.article_path));
          var body = el('p', 'body', c.body); // textContent only — XSS-safe
          var actions = el('div', 'actions');
          var unapproveBtn = el('button', null, 'Unapprove');
          var deleteBtn = el('button', 'danger', 'Delete');
          unapproveBtn.addEventListener('click', function () { moderate(c.id, 'unapprove'); });
          deleteBtn.addEventListener('click', function () { moderate(c.id, 'delete'); });
          actions.append(unapproveBtn, deleteBtn);
          main.append(head, body, actions);
          li.append(avatar, main);
          publishedList.appendChild(li);
        });
        showStatus(pubStatus, '');
      })
      .catch(function (err) { showStatus(pubStatus, 'Error: ' + err.message, true); });
  }

  function loadPending() {
    showStatus(listStatus, 'Loading…');
    fetch('/api/admin/comments?status=pending', { credentials: 'same-origin' })
      .then(function (res) { if (!res.ok) throw new Error('request failed'); return res.json(); })
      .then(function (data) {
        var comments = Array.isArray(data.comments) ? data.comments : [];
        pendingList.replaceChildren();
        if (comments.length === 0) {
          pendingList.appendChild(el('li', 'empty', 'No comments awaiting approval. 🎉'));
          showStatus(listStatus, '');
          return;
        }
        comments.forEach(function (c) {
          var nick = (c.nickname && c.nickname.trim()) || 'Anonymous';
          var li = el('li', 'comment');
          var avatar = el('div', 'avatar', nick.charAt(0).toUpperCase());
          var main = el('div', 'main');
          var head = el('div', 'head');
          head.append(el('span', 'nick', nick), el('span', 'time', new Date(c.created_at * 1000).toLocaleString()));
          if (c.article_path) head.append(el('span', 'page-chip', c.article_path));
          var body = el('p', 'body', c.body); // textContent only — XSS-safe
          var actions = el('div', 'actions');
          var approveBtn = el('button', null, 'Approve');
          var deleteBtn = el('button', 'danger', 'Delete');
          approveBtn.addEventListener('click', function () { moderate(c.id, 'approve'); });
          deleteBtn.addEventListener('click', function () { moderate(c.id, 'delete'); });
          actions.append(approveBtn, deleteBtn);
          main.append(head, body, actions);
          li.append(avatar, main);
          pendingList.appendChild(li);
        });
        showStatus(listStatus, '');
      })
      .catch(function (err) { showStatus(listStatus, 'Error: ' + err.message, true); });
  }

  function moderate(id, action) {
    if (!csrf) { showStatus(listStatus, 'Not authenticated', true); return; }
    var options = {
      method: action === 'approve' || action === 'unapprove' ? 'PATCH' : 'DELETE',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrf }
    };
    if (action === 'approve' || action === 'unapprove') {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify({ status: action === 'approve' ? 'approved' : 'pending' });
    }
    fetch('/api/admin/comments/' + encodeURIComponent(id), options)
      .then(function (res) {
        if (!res.ok) throw new Error('moderation failed (' + res.status + ')');
        loadPending();
        loadPublished();
        loadPages();
      })
      .catch(function (err) { showStatus(listStatus, 'Error: ' + err.message, true); });
  }
})();
