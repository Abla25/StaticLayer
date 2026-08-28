/**
 * StaticLayer interactive demo — visitor widget + admin console.
 *
 * Fully client-side and deterministic: no network calls, no backend, no writes.
 * It mines a REAL nonce with @staticlayer/protocol to teach the actual
 * Proof-of-Work mechanism, then simulates submission → moderation → publish.
 *
 * Modes: try comments (with likes), reactions, polls — or everything at once.
 * The widget is restylable live (graphic templates), the embed snippet updates
 * to match, and the admin console shows login + the moderation queue. Nothing
 * is stored; no data leaves the page.
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

const THREAD_ARTICLE = '/demo';
const REACT_EDITOR_STEP = 5; // demo: +1 difficulty every 5 reactions on this page

let comments = []; // { id, nick, body, mins, cool, likes, voted, articlePath, status }
let reactions = {}; // articlePath -> { [reaction]: count }
let reactOptions = ['👍', '❤️', '🎉'];
let nextId = 1;
let adminIn = false;
let currentTheme = 'classic';
let currentMode = 'all';
let reactBusy = false;

// demo poll
let pollVotes = { Comments: 54, Reactions: 26, Polls: 20 };
let pollVoted = false;

function seed() {
  comments = [
    { id: nextId++, nick: 'Alice', body: 'This is beautifully simple.', mins: 1, cool: false, likes: 12, voted: false, articlePath: THREAD_ARTICLE, status: 'published' },
    { id: nextId++, nick: 'Bob', body: 'Exactly what static sites needed. No SaaS, no tracker.', mins: 4, cool: true, likes: 4, voted: false, articlePath: '/blog/another-post', status: 'published' },
  ];
  reactions = {
    [THREAD_ARTICLE]: { '👍': 3, '❤️': 1 },
    '/blog/another-post': { '👍': 2 },
  };
  pollVotes = { Comments: 54, Reactions: 26, Polls: 20 };
  pollVoted = false;
}

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

/* ---------------- modes ---------------- */

const MODE_HINTS = {
  all: 'Everything below is real: post, like, react and vote — all with real Proof-of-Work.',
  comments: 'Post a comment, like it, watch it land in the moderation queue — then approve it in the admin console.',
  reactions: 'Every click pays a real Proof-of-Work. Difficulty rises as the page gets busier.',
  polls: 'Vote anonymously — one Proof-of-Work, live ranked results with a leader.',
};

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.demo-mode').forEach((btn) => {
    const on = btn.dataset.mode === mode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
  const views = {
    comments: $('demo-view-comments'),
    reactions: $('demo-view-reactions'),
    poll: $('demo-view-poll'),
  };
  if (views.comments) views.comments.classList.toggle('on', mode === 'all' || mode === 'comments');
  if (views.reactions) views.reactions.classList.toggle('on', mode === 'all' || mode === 'reactions');
  if (views.poll) views.poll.classList.toggle('on', mode === 'all' || mode === 'polls');
  const hint = $('demo-mode-hint');
  if (hint) hint.textContent = MODE_HINTS[mode] || MODE_HINTS.all;
  const side = $('side-hint');
  if (side) side.textContent = mode === 'polls' ? 'A poll vote: challenge → PoW → atomic consume → ranked results.' : 'What the visitor and the system experience.';
  if (mode === 'polls' && views.poll && views.poll.classList.contains('on')) renderPoll();
  const embed = $('embed-code');
  if (embed) embed.textContent = embedSnippet(currentTheme);
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
    if (c.status === 'pending') meta.append(el('span', 'dt-badge', 'Pending'));
    main.append(meta, el('p', 'dt-body', c.body));

    if (c.status === 'published') {
      const like = el('button', 'dt-like' + (c.voted ? ' voted' : ''));
      like.type = 'button';
      like.setAttribute('aria-label', 'Like this comment');
      like.append(el('span', null, c.voted ? '❤️' : '🤍'), el('span', null, String(c.likes)));
      like.addEventListener('click', () => onLike(c, like));
      main.append(like);
    } else {
      const row = el('div', 'dt-row');
      row.style.marginTop = '8px';
      row.style.justifyContent = 'flex-end';
      const approve = el('button', 'btn btn-primary btn-sm', 'Approve (admin)');
      approve.type = 'button';
      approve.addEventListener('click', () => approveComment(c.id));
      row.append(approve);
      main.append(row);
    }
    item.append(avatar, main);
    list.append(item);
  }
  updateCount();
}

function onLike(c, btn) {
  if (c.voted) { c.voted = false; c.likes -= 1; }
  else { c.voted = true; c.likes += 1; }
  btn.classList.add('bump');
  const ctr = btn.querySelectorAll('span')[1];
  if (ctr) {
    ctr.textContent = String(c.likes);
    ctr.classList.remove('tick-pop'); void ctr.offsetWidth; ctr.classList.add('tick-pop');
  }
  setTimeout(() => btn.classList.remove('bump'), 420);
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
  const base = 12;
  const step = 5;
  const ceiling = 15;
  return Math.min(base + Math.floor(votes / step), ceiling);
}

function renderReactions() {
  const bar = $('dt-reactions');
  if (!bar) return;
  bar.replaceChildren();
  const counts = reactions[THREAD_ARTICLE] || {};
  const hint = $('demo-reactions');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const ctr = $('dt-react-count');
  if (ctr) ctr.textContent = `${total} reaction${total === 1 ? '' : 's'}`;
  if (hint) hint.value = reactOptions.join(',');
  for (const r of reactOptions) {
    const btn = el('button', 'dt-reaction');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'React with ' + r);
    btn.append(el('span', null, r), el('span', 'dt-reaction-count', String(counts[r] || 0)));
    btn.addEventListener('click', () => submitReaction(r, btn));
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
  if (parsed.length === 0) return;
  reactOptions = parsed;
  renderReactions();
  setReactStatus(`Reaction set updated: ${reactOptions.join(' ')}`, 'ok');
}

function setReactStatus(msg, kind) {
  const s = $('dt-react-status');
  if (!s) return;
  s.textContent = msg;
  s.classList.toggle('ok', kind === 'ok');
}

async function submitReaction(r, btn) {
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
    btn.querySelector('.dt-reaction-count').textContent = String(counts[r]);
    const ctr = $('dt-react-count');
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (ctr) {
      ctr.textContent = `${total} reaction${total === 1 ? '' : 's'}`;
      ctr.classList.remove('tick-pop'); void ctr.offsetWidth; ctr.classList.add('tick-pop');
    }
    renderAdmin();
    setReactStatus(`✓ ${r} recorded · difficulty ${difficulty} · proof in ${ms} ms`, 'ok');
  } catch {
    setReactStatus('Something went wrong in the simulation — try again.');
  } finally {
    reactBusy = false;
    document.querySelectorAll('.dt-reaction').forEach((b) => { b.disabled = false; });
  }
}

/* ---------------- poll (anonymous, PoW, ranked results) ---------------- */

function pollTotal() { return Object.values(pollVotes).reduce((a, b) => a + b, 0); }

function renderPoll() {
  const box = $('dt-poll');
  if (!box) return;
  box.replaceChildren();
  const head = el('div', 'dt-poll-head');
  head.append(el('h4', null, '📊 Which do you use most on your site?'), el('span', 'dt-count', pollTotal() + ' votes'));
  box.append(head);
  const total = pollTotal() || 1;
  const entries = Object.entries(pollVotes).sort((a, b) => b[1] - a[1]);
  entries.forEach(([label, votes], i) => {
    const pct = Math.round((votes / total) * 100);
    const opt = el('button', 'poll-option' + (pollVoted ? ' voted show' : ''));
    opt.type = 'button';
    opt.style.setProperty('--w', pct + '%');
    opt.setAttribute('aria-label', pollVoted ? `${label}: ${pct}%` : `Vote for ${label}`);
    const bar = el('span', 'poll-bar');
    const row = el('span', 'row');
    row.append(
      el('span', 'label', (pollVoted && i === 0 ? '👑 ' : '') + label),
      el('span', 'pct', pollVoted ? pct + '%' : ''),
    );
    opt.append(bar, row);
    if (!pollVoted) opt.addEventListener('click', () => submitPollVote(label));
    box.append(opt);
    setTimeout(() => opt.classList.add('show'), 120 + i * 110);
  });
  const note = el('p', 'dt-note', pollVoted ? '✓ Vote counted — live ranked results. Leader highlighted.' : 'Anonymous · one Proof-of-Work per vote · optional one-vote-per-browser');
  box.append(note);
}

async function submitPollVote(label) {
  if (pollVoted) return;
  pollVoted = true;
  const note = boxNote('Solving proof-of-work…');
  try {
    const base = {
      version: PROTOCOL_VERSION,
      hostContext: 'demo.local',
      articlePath: THREAD_ARTICLE,
      nickname: '',
      body: '',
      challengeId: randomBytes(32),
    };
    const t0 = performance.now();
    await mineNonce(base, 12);
    const ms = Math.max(1, Math.round(performance.now() - t0));
    pollVotes[label] = (pollVotes[label] || 0) + 1;
    renderPoll();
    logLine('pow', `poll vote → proof in ${ms} ms, atomic consume, ranked results`);
  } catch {
    if (note) note.textContent = 'Something went wrong — try again.';
  }
}

function boxNote(msg) {
  const box = $('dt-poll');
  if (!box) return null;
  const note = el('p', 'dt-note', msg);
  box.append(note);
  return note;
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

/* ---------------- themes / embed ---------------- */

const THEME_META = {
  classic: { label: 'Classic', endpoint: 'https://comments.yourdomain.com' },
  ink: { label: 'Ink', endpoint: 'https://comments.yourdomain.com' },
  glass: { label: 'Glass', endpoint: 'https://comments.yourdomain.com' },
  ocean: { label: 'Ocean', endpoint: 'https://comments.yourdomain.com' },
  sunset: { label: 'Sunset', endpoint: 'https://comments.yourdomain.com' },
};

function embedSnippet(theme) {
  const meta = THEME_META[theme];
  const endpoint = meta.endpoint;
  const comment = `<!-- StaticLayer · theme: ${theme} (${meta.label}) -->`;
  const parts = [];
  if (currentMode === 'polls') {
    parts.push(`<div data-staticlayer data-endpoint="${endpoint}"\n     data-article-path="/demo" data-poll-id="demo-poll"></div>`);
  } else if (currentMode === 'reactions') {
    parts.push(`<div data-staticlayer data-endpoint="${endpoint}"\n     data-article-path="/demo" data-reactions-only\n     data-reactions="${reactOptions.join(',')}"></div>`);
  } else {
    const reactions = currentMode === 'all' ? `\n     data-reactions="${reactOptions.join(',')}"` : '';
    parts.push(`<div data-staticlayer data-endpoint="${endpoint}"\n     data-article-path="/demo"${reactions}></div>`);
  }
  parts.push(`<script src="${endpoint}/widget.js" defer><\/script>`);
  return `${comment}\n${parts.join('\n')}`;
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

  setStep('submission', 'active');
  setStatus('Submitting to the Worker…');
  await delay(320);
  comments.push({ id: nextId++, nick, body, mins: 0, cool: false, likes: 0, voted: false, articlePath: THREAD_ARTICLE, status: 'pending' });
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
  const thread = $('demo-thread');
  if (thread) thread.classList.remove('reacts-only');
  const nick = $('sim-nick'); if (nick) nick.value = '';
  const body = $('sim-body'); if (body) body.value = '';
  const post = $('sim-post'); if (post) post.disabled = false;
  const pass = $('admin-pass'); if (pass) pass.value = '';
  setReactStatus('');
  resetTimeline();
  setTheme(currentTheme);
  setMode(currentMode);
  renderVisitor();
  renderReactions();
  renderPoll();
  renderAdminView();
  showTab('visitor');
  setStatus('Write a comment, then press “Post comment”.');
}

/* ---------------- init ---------------- */

function init() {
  seed();
  setTheme('classic');
  setMode('all');
  renderVisitor();
  renderReactions();
  renderPoll();
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

  document.querySelectorAll('.demo-mode').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
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
