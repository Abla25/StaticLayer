/**
 * StaticLayer interactive demo — visitor widget + admin console.
 *
 * Fully client-side and deterministic: no network calls, no backend, no writes.
 * It mines a REAL nonce with @staticlayer/protocol to teach the actual
 * Proof-of-Work mechanism, then simulates submission → moderation → publish.
 * The widget is restylable live (graphic themes), the embed snippet updates to
 * match, and the admin console shows login + the moderation queue
 * (approve/delete) with shared state. Nothing is stored; no data leaves the
 * page.
 */
import {
  base64UrlToBytes,
  bytesToBase64Url,
  mineNonce,
  PROTOCOL_VERSION,
  randomBytes,
  serializeNonce,
} from '@staticlayer/protocol';

const DIFFICULTY = 15; // fast on typical devices, still a real proof

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------------- shared state ---------------- */

const THREAD_ARTICLE = '/demo'; // the page the visitor is on
const REACT_EDITOR_STEP = 5; // demo: +1 difficulty every 5 reactions on this page
let reactOptions = ['👍', '❤️', '🎉']; // editable in the demo (like data-reactions)

let comments = []; // { id, nick, body, mins, cool, articlePath, status: 'published' | 'pending' }
let reactions = {}; // articlePath -> { [reaction]: count }
let nextId = 1;
let adminIn = false;
let currentTheme = 'classic';
let reactBusy = false;

function seed() {
  comments = [
    { id: nextId++, nick: 'Alice', body: 'This is beautifully simple.', mins: 1, cool: false, articlePath: THREAD_ARTICLE, status: 'published' },
    { id: nextId++, nick: 'Bob', body: 'Exactly what static sites needed. No SaaS, no tracker.', mins: 4, cool: true, articlePath: '/blog/another-post', status: 'published' },
  ];
  reactions = {
    [THREAD_ARTICLE]: { '👍': 3, '❤️': 1 },
    '/blog/another-post': { '👍': 2 },
  };
}

/** The visitor only ever sees their own page's thread. */
function threadComments() {
  return comments.filter((c) => c.articlePath === THREAD_ARTICLE);
}

function timeAgo(mins) {
  if (mins <= 0) return 'just now';
  if (mins === 1) return '1 min ago';
  return `${mins} min ago`;
}

function publishedCount() { return comments.filter((c) => c.status === 'published').length; }
function pendingCount() { return comments.filter((c) => c.status === 'pending').length; }

function updateCount() {
  const total = threadComments().length;
  for (const elm of document.querySelectorAll('.dt-count')) {
    elm.textContent = `${total} comment${total === 1 ? '' : 's'}`;
  }
}

/* ---------------- render: visitor thread ---------------- */

function renderVisitor() {
  const list = $('dt-list');
  if (!list) return;
  list.replaceChildren();
  const thread = threadComments();
  if (thread.length === 0) {
    list.append(el('div', 'dt-empty', 'No comments yet — be the first.'));
    updateCount();
    return;
  }
  for (const c of thread) {
    const item = el('div', 'dt-item' + (c.status === 'pending' ? ' pending' : ''));
    const avatar = el('span', 'dt-avatar' + (c.cool ? ' cool' : ''), (c.nick || 'A').charAt(0).toUpperCase());
    avatar.setAttribute('aria-hidden', 'true');
    const main = el('div', 'dt-main');
    const meta = el('div', 'dt-meta');
    meta.append(el('span', 'dt-nick', c.nick || 'Anonymous'), el('span', 'dt-time', timeAgo(c.mins)));
    if (c.status === 'pending') {
      meta.append(el('span', 'dt-badge', 'Pending'));
    }
    main.append(meta, el('p', 'dt-body', c.body));
    item.append(avatar, main);

    if (c.status === 'pending') {
      const row = el('div', 'dt-row');
      row.style.marginTop = '8px';
      row.style.justifyContent = 'flex-end';
      const approve = el('button', 'btn btn-primary btn-sm', 'Approve (admin)');
      approve.type = 'button';
      approve.addEventListener('click', () => approveComment(c.id));
      row.append(approve);
      item.append(row);
    }
    list.append(item);
  }
  updateCount();
}

/* ---------------- render: admin console ---------------- */

function adminItem(c) {
  const item = el('div', 'admin-item');
  const avatar = el('span', 'dt-avatar' + (c.cool ? ' cool' : ''), (c.nick || 'A').charAt(0).toUpperCase());
  avatar.setAttribute('aria-hidden', 'true');
  const main = el('div', 'dt-main');
  const meta = el('div', 'dt-meta');
  meta.append(el('span', 'dt-nick', c.nick || 'Anonymous'), el('span', 'dt-time', timeAgo(c.mins)));
  if (c.articlePath) meta.append(el('span', 'page-chip', c.articlePath));
  main.append(meta, el('p', 'dt-body', c.body));
  item.append(avatar, main);
  return item;
}

function renderPages() {
  const panel = $('admin-pages');
  if (!panel) return;
  panel.replaceChildren();
  const byPath = new Map();
  for (const c of comments) {
    if (!byPath.has(c.articlePath)) byPath.set(c.articlePath, { path: c.articlePath, total: 0, pending: 0, approved: 0 });
    const a = byPath.get(c.articlePath);
    a.total += 1;
    if (c.status === 'pending') a.pending += 1;
    else a.approved += 1;
  }
  const rows = [...byPath.values()].sort((a, b) => b.total - a.total);
  if (rows.length === 0) {
    panel.append(el('div', 'dt-empty', 'No comments on any page yet.'));
    return;
  }
  for (const a of rows) {
    const row = el('div', 'page-row');
    row.append(el('span', 'page-path', a.path));
    const counts = el('span', 'page-counts');
    const rxn = reactions[a.path] || {};
    const rxnTotal = Object.values(rxn).reduce((x, y) => x + y, 0);
    counts.append(
      el('span', 'page-count total', `${a.total} comments`),
      el('span', 'page-count pending', `${a.pending} pending`),
      el('span', 'page-count ok', `${a.approved} approved`),
    );
    if (rxnTotal > 0) counts.append(el('span', 'page-count react', `${rxnTotal} reactions`));
    row.append(counts);
    panel.append(row);
  }
}

function renderAdmin() {
  const queue = $('admin-queue');
  const pub = $('admin-published');
  if (!queue || !pub) return;
  renderPages();
  queue.replaceChildren();
  pub.replaceChildren();

  const pending = comments.filter((c) => c.status === 'pending');
  if (pending.length === 0) {
    queue.append(el('div', 'dt-empty', 'Queue is empty — no comments awaiting moderation.'));
  } else {
    for (const c of pending) {
      const item = adminItem(c);
      const actions = el('div', 'admin-actions');
      const ok = el('button', 'btn btn-primary btn-sm', 'Approve');
      ok.type = 'button';
      ok.addEventListener('click', () => approveComment(c.id));
      const del = el('button', 'btn btn-ghost btn-sm', 'Delete');
      del.type = 'button';
      del.addEventListener('click', () => deleteComment(c.id));
      actions.append(ok, del);
      item.append(actions);
      queue.append(item);
    }
  }

  const recent = comments.filter((c) => c.status === 'published').slice(-4).reverse();
  if (recent.length === 0) {
    pub.append(el('div', 'dt-empty', 'Nothing published yet.'));
  } else {
    for (const c of recent) {
      const item = adminItem(c);
      const actions = el('div', 'admin-actions');
      actions.append(el('span', 'dt-badge ok', '✓ Published'));
      const del = el('button', 'btn btn-ghost btn-sm', 'Delete');
      del.type = 'button';
      del.addEventListener('click', () => deleteComment(c.id));
      actions.append(del);
      item.append(actions);
      pub.append(item);
    }
  }
}

/* ---------------- reactions (anonymous, escalating PoW) ---------------- */

function reactionDifficulty(article) {
  const counts = reactions[article] || {};
  const votes = Object.values(counts).reduce((a, b) => a + b, 0);
  const base = 12; // fast demo; production defaults to 16
  const step = 5; // +1 difficulty every 5 votes on this page
  const ceiling = 15;
  return Math.min(base + Math.floor(votes / step), ceiling);
}

function renderReactions() {
  const bar = $('dt-reactions');
  if (!bar) return;
  bar.replaceChildren();
  const counts = reactions[THREAD_ARTICLE] || {};
  const hint = $('dt-react-hint');
  if (hint) {
    hint.textContent =
      `Anonymous reactions · PoW difficulty ${reactionDifficulty(THREAD_ARTICLE)} · ` +
      `+1 every ${REACT_EDITOR_STEP} reactions on this page`;
  }
  for (const r of reactOptions) {
    const btn = el('button', 'dt-reaction');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'React with ' + r);
    btn.append(
      el('span', 'dt-reaction-emoji', r),
      el('span', 'dt-reaction-count', String(counts[r] || 0)),
    );
    btn.addEventListener('click', () => submitReaction(r));
    bar.append(btn);
  }
}

function applyReactionEditor() {
  const input = $('demo-reactions');
  if (!input) return;
  const parsed = input.value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 8);
  if (parsed.length === 0) return; // keep the last valid set
  reactOptions = parsed;
  renderReactions();
  setReactStatus(`Reaction set updated: ${reactOptions.join(' ')}`, 'ok');
}

function applyReactionsOnly() {
  const cb = $('demo-reactions-only');
  if (!cb) return;
  const thread = $('demo-thread');
  if (thread) thread.classList.toggle('reacts-only', cb.checked);
}

function setReactStatus(msg, kind) {
  const s = $('dt-react-status');
  if (!s) return;
  s.textContent = msg;
  s.classList.toggle('ok', kind === 'ok');
}

async function submitReaction(r) {
  if (reactBusy) return;
  reactBusy = true;
  document.querySelectorAll('.dt-reaction').forEach((b) => { b.disabled = true; });
  setReactStatus('Solving proof-of-work…');
  try {
    const difficulty = reactionDifficulty(THREAD_ARTICLE);
    const base = {
      version: PROTOCOL_VERSION,
      hostContext: 'demo.local',
      articlePath: THREAD_ARTICLE,
      nickname: '',
      body: '',
      challengeId: randomBytes(32),
    };
    const t0 = performance.now();
    const nonce = await mineNonce(base, difficulty);
    const ms = Math.max(1, Math.round(performance.now() - t0));

    const counts = (reactions[THREAD_ARTICLE] = reactions[THREAD_ARTICLE] || {});
    counts[r] = (counts[r] || 0) + 1;
    renderReactions();
    renderAdmin();
    setReactStatus(`✓ ${r} recorded · difficulty ${difficulty} · proof in ${ms} ms`, 'ok');
  } catch {
    setReactStatus('Something went wrong in the simulation — try again.');
  } finally {
    reactBusy = false;
    document.querySelectorAll('.dt-reaction').forEach((b) => { b.disabled = false; });
  }
}

/* ---------------- actions ---------------- */

function approveComment(id) {
  const c = comments.find((x) => x.id === id);
  if (!c || c.status !== 'pending') return;
  c.status = 'published';
  c.mins = 0;
  setStatus('✓ Comment published. Try it again with your own text.', 'ok');
  setStep('moderation', 'done');
  setStep('published', 'done');
  logLine('admin', 'approved → comment is public');
  renderVisitor();
  renderAdmin();
}

function deleteComment(id) {
  const c = comments.find((x) => x.id === id);
  if (!c) return;
  comments = comments.filter((x) => x.id !== id);
  setStatus('Comment deleted from the queue.');
  logLine('admin', 'deleted → comment removed');
  renderVisitor();
  renderAdmin();
}

/* ---------------- status / timeline / log ---------------- */

function setStep(key, state) {
  const li = document.querySelector(`[data-step="${key}"]`);
  if (!li) return;
  li.classList.remove('active', 'done');
  if (state) li.classList.add(state);
}

function logLine(bold, text) {
  const log = $('sim-log');
  if (!log) return;
  const line = el('div', 'line');
  line.append(el('b', null, bold), el('span', null, text));
  log.append(line);
}

function setStatus(msg, kind) {
  const s = $('sim-status-text');
  if (!s) return;
  s.textContent = msg;
  s.classList.toggle('ok', kind === 'ok');
}

const steps = ['challenge', 'pow', 'submission', 'moderation', 'published'];

function resetTimeline() {
  for (const k of steps) setStep(k, null);
  const log = $('sim-log');
  if (log) { log.classList.remove('open'); log.replaceChildren(); }
}

/* ---------------- themes ---------------- */

const THEME_META = {
  classic: { label: 'Classic', endpoint: 'https://comments.yourdomain.com' },
  ink: { label: 'Ink', endpoint: 'https://comments.yourdomain.com' },
  glass: { label: 'Glass', endpoint: 'https://comments.yourdomain.com' },
  ocean: { label: 'Ocean', endpoint: 'https://comments.yourdomain.com' },
  sunset: { label: 'Sunset', endpoint: 'https://comments.yourdomain.com' },
};

function embedSnippet(theme) {
  const comment = `<!-- StaticLayer · theme: ${theme} (${THEME_META[theme].label}) -->`;
  const div = `<div data-staticlayer data-endpoint="${THEME_META[theme].endpoint}"\n     data-article-path="/demo"></div>`;
  const script = `<script src="${THEME_META[theme].endpoint}/widget.js" defer><\/script>`;
  return `${comment}\n${div}\n${script}`;
}

function setTheme(theme) {
  currentTheme = theme;
  const thread = $('demo-thread');
  if (thread) thread.dataset.theme = theme;
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    const on = btn.dataset.theme === theme;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
  const pre = $('embed-code');
  if (pre) pre.textContent = embedSnippet(theme);
}

/* ---------------- main flow ---------------- */

async function run() {
  const nick = ($('sim-nick').value || '').trim();
  const body = ($('sim-body').value || '').trim();
  if (!body) { setStatus('Please write a comment first.'); return; }

  $('sim-post').disabled = true;
  resetTimeline();
  logLine('step', '0 · Visitor submits a plain-text comment');

  /* 1 · challenge */
  setStep('challenge', 'active');
  setStatus('Requesting a challenge…');
  await delay(320);
  const challenge = {
    challengeId: bytesToBase64Url(randomBytes(32)),
    hostContext: 'demo.local',
    articlePath: '/demo',
    difficulty: DIFFICULTY,
    expiresAt: Date.now() + 300000,
    signature: 'simulated-client-side',
  };
  logLine('GET', '/api/comments/challenge → signed challenge (HMAC, 5-min TTL)');
  setStep('challenge', 'done');

  /* 2 · proof of work (real mining) */
  setStep('pow', 'active');
  setStatus('Generating proof…');
  const base = {
    version: PROTOCOL_VERSION,
    hostContext: challenge.hostContext,
    articlePath: challenge.articlePath,
    nickname: nick,
    body,
    challengeId: base64UrlToBytes(challenge.challengeId),
  };
  const t0 = performance.now();
  const nonce = await mineNonce(base, challenge.difficulty);
  const ms = Math.max(1, Math.round(performance.now() - t0));
  logLine('pow', `browser computed a nonce in ${ms} ms (difficulty ${DIFFICULTY})`);
  setStatus(`Proof found in ${ms} ms — nonce ${serializeNonce(nonce)}`);
  setStep('pow', 'done');
  await delay(260);

  /* 3 · submission — comment lands in the moderation queue */
  setStep('submission', 'active');
  setStatus('Submitting to the Worker…');
  await delay(320);
  comments.push({ id: nextId++, nick, body, mins: 0, cool: false, articlePath: THREAD_ARTICLE, status: 'pending' });
  logLine('POST', '/api/comments → Worker verifies signature + proof');
  logLine('d1', 'challenge consumed atomically (D1 batch) → comment stored as pending');
  setStatus('Comment submitted — it is now in the moderation queue. Open the Admin console to approve it.');
  setStep('submission', 'done');
  setStep('moderation', 'active');
  renderVisitor();
  renderAdmin();
  $('sim-nick').value = '';
  $('sim-body').value = '';
  $('sim-post').disabled = false;
}

/* ---------------- tabs + admin login ---------------- */

function showTab(which) {
  const visitor = $('view-visitor');
  const admin = $('view-admin');
  const tabV = $('tab-visitor');
  const tabA = $('tab-admin');
  if (!visitor || !admin) return;
  const showAdmin = which === 'admin';
  visitor.hidden = showAdmin;
  admin.hidden = !showAdmin;
  tabV.classList.toggle('active', !showAdmin);
  tabA.classList.toggle('active', showAdmin);
  tabV.setAttribute('aria-selected', String(!showAdmin));
  tabA.setAttribute('aria-selected', String(showAdmin));
}

function renderAdminView() {
  const login = $('admin-login');
  const panel = $('admin-panel');
  if (!login || !panel) return;
  login.hidden = adminIn;
  panel.hidden = !adminIn;
  if (adminIn) renderAdmin();
}

function adminSignIn() {
  const pass = $('admin-pass');
  if (pass) pass.value = '';
  adminIn = true;
  renderAdminView();
  logLine('admin', 'signed in → stateless HMAC session issued (demo)');
}

/* ---------------- reset ---------------- */

function resetDemo() {
  seed();
  adminIn = false;
  reactOptions = ['👍', '❤️', '🎉'];
  const editor = $('demo-reactions');
  if (editor) editor.value = reactOptions.join(',');
  const reactOnlyCb = $('demo-reactions-only');
  if (reactOnlyCb) reactOnlyCb.checked = false;
  const thread = $('demo-thread');
  if (thread) thread.classList.remove('reacts-only');
  $('sim-nick').value = '';
  $('sim-body').value = '';
  $('sim-post').disabled = false;
  $('admin-pass').value = '';
  setReactStatus('');
  resetTimeline();
  setTheme(currentTheme);
  renderVisitor();
  renderReactions();
  renderAdminView();
  showTab('visitor');
  setStatus('Write a comment, then press “Post comment”.');
}

/* ---------------- init ---------------- */

function init() {
  seed();
  setTheme('classic');
  renderVisitor();
  renderReactions();
  renderAdminView();
  showTab('visitor');
  setStatus('Write a comment, then press “Post comment”.');

  $('sim-post').addEventListener('click', run);
  $('sim-reset').addEventListener('click', resetDemo);
  $('sim-log-toggle').addEventListener('click', () => $('sim-log').classList.toggle('open'));
  $('tab-visitor').addEventListener('click', () => showTab('visitor'));
  $('tab-admin').addEventListener('click', () => showTab('admin'));
  $('admin-signin').addEventListener('click', adminSignIn);
  const reactEditor = $('demo-reactions');
  if (reactEditor) reactEditor.addEventListener('change', applyReactionEditor);
  const reactOnlyCb = $('demo-reactions-only');
  if (reactOnlyCb) reactOnlyCb.addEventListener('change', applyReactionsOnly);

  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => setTheme(btn.dataset.theme));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('sim-log').classList.remove('open');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
