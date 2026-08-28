/**
 * StaticLayer homepage — interactive hero widget (v2).
 *
 * A tiny, real client-side simulation that shows the FULL engagement surface:
 * comments with likes + pin + sort, anonymous reactions, and a mini poll —
 * all with real Proof-of-Work (low difficulty so it stays snappy). No network,
 * no storage, no tracking, no secrets — exactly like the full simulator.
 */
import { mineNonce, PROTOCOL_VERSION, randomBytes, serializeNonce } from '@staticlayer/protocol';

const DIFFICULTY = 12; // fast on any device, still a genuine proof
const REACT_EMOJIS = ['👍', '❤️', '🎉'];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function init() {
  const root = document.querySelector('.widget-demo');
  if (!root) return;
  const nickInput = root.querySelector('#hero-nick');
  const bodyInput = root.querySelector('#hero-body');
  const post = root.querySelector('#hero-post');
  const list = root.querySelector('.wd-list');
  const count = root.querySelector('.wd-count');
  const status = root.querySelector('#hero-status');
  const sortNewest = root.querySelector('#sort-newest');
  const sortBest = root.querySelector('#sort-best');
  if (!nickInput || !bodyInput || !post || !list || !count) return;

  let busy = false;

  /* ---------- data ---------- */
  let comments = [
    { id: 1, nick: 'Alice', body: 'This is beautifully simple. 3 lines of HTML and it works.', mins: 1, cool: false, pinned: true, likes: 12, voted: false },
    { id: 2, nick: 'Bob', body: 'Exactly what static sites needed. No SaaS, no tracker — and my readers can vote now.', mins: 4, cool: true, pinned: false, likes: 4, voted: false },
  ];
  let sortMode = 'newest';
  const reactCounts = { '👍': 3, '❤️': 1 };
  let reactBusy = false;
  let pollVoted = false;

  /* ---------- poll state ---------- */
  const poll = { q: 'Which do you use most?', options: [
    { label: 'Comments', votes: 54 },
    { label: 'Reactions', votes: 26 },
    { label: 'Polls', votes: 20 },
  ] };

  function pollTotal() { return poll.options.reduce((a, o) => a + o.votes, 0); }

  function renderPoll() {
    const box = root.querySelector('#hero-poll');
    if (!box) return;
    box.replaceChildren();
    const head = el('div', 'wd-poll-head');
    head.append(el('h4', null, '📊 ' + poll.q), el('span', 'wd-count', pollTotal() + ' votes'));
    box.append(head);
    const total = pollTotal() || 1;
    poll.options.forEach(function (o, i) {
      const btn = el('button', 'poll-option' + (pollVoted ? ' show' : ''));
      btn.type = 'button';
      btn.style.setProperty('--w', String((o.votes / total) * 100) + '%');
      if (pollVoted) btn.setAttribute('aria-label', o.label + ' ' + Math.round((o.votes / total) * 100) + '%');
      else btn.setAttribute('aria-label', 'Vote for ' + o.label);
      const bar = el('span', 'poll-bar');
      const row = el('span', 'row');
      row.append(
        el('span', 'label', (pollVoted ? '' : '▸ ') + o.label),
        el('span', 'pct', pollVoted ? Math.round((o.votes / total) * 100) + '%' : ''),
      );
      btn.append(bar, row);
      if (!pollVoted) {
        btn.addEventListener('click', function () { onPollVote(i); });
      }
      box.append(btn);
      // stagger the reveal
      setTimeout(function () { btn.classList.add('show'); }, 150 + i * 120);
    });
    const note = el('p', 'wd-poll-note', pollVoted ? '✓ Your vote counted — results update live.' : 'Anonymous · PoW-protected · try it');
    box.append(note);
  }

  function onPollVote(i) {
    if (pollVoted) return;
    pollVoted = true;
    poll.options[i].votes += 1;
    // tiny mining feel, keep it snappy
    setPollNote('Verifying proof…');
    setTimeout(function () { renderPoll(); }, 350);
  }

  function setPollNote(msg) {
    const note = root.querySelector('.wd-poll-note');
    if (note) note.textContent = msg;
  }

  /* ---------- comments ---------- */
  function bumpCount() {
    const n = list.querySelectorAll('.wd-item').length;
    count.textContent = `${n} comment${n === 1 ? '' : 's'}`;
    count.classList.remove('tick-pop');
    void count.offsetWidth;
    count.classList.add('tick-pop');
  }

  function sorted() {
    const arr = comments.slice();
    if (sortMode === 'best') arr.sort(function (a, b) { return b.likes - a.likes; });
    else arr.sort(function (a, b) { return a.mins - b.mins; });
    return arr;
  }

  function renderComments() {
    list.replaceChildren();
    const items = sorted();
    for (const c of items) {
      const item = el('div', 'wd-item' + (c.pinned ? ' pinned' : ''));
      item.style.animation = 'pop-in 0.35s cubic-bezier(.22,1,.36,1)';
      const avatar = el('span', 'wd-avatar' + (c.cool ? ' cool' : ''), (c.nick || 'A').charAt(0).toUpperCase());
      avatar.setAttribute('aria-hidden', 'true');
      const main = el('div', 'wd-main');
      const meta = el('div', 'wd-meta');
      meta.append(el('span', 'wd-nick', c.nick));
      if (c.pinned) meta.append(el('span', 'wd-pin', '📌 Pinned'));
      meta.append(el('span', 'wd-time', c.mins === 1 ? '1 min ago' : c.mins + ' min ago'));
      main.append(meta, el('p', 'wd-body', c.body));

      const like = el('button', 'wd-like' + (c.voted ? ' voted' : ''));
      like.type = 'button';
      like.setAttribute('aria-label', 'Like this comment');
      like.append(el('span', 'heart', c.voted ? '❤️' : '🤍'));
      const ctr = el('span', 'count', String(c.likes));
      like.append(ctr);
      like.addEventListener('click', function () { onLike(c, like); });
      main.append(like);

      item.append(avatar, main);
      list.append(item);
    }
    bumpCount();
  }

  async function onLike(c, btn) {
    if (c.voted) {
      c.voted = false; c.likes -= 1;
    } else {
      c.voted = true; c.likes += 1;
    }
    btn.classList.add('bump');
    const ctr = btn.querySelector('.count');
    if (ctr) {
      ctr.textContent = String(c.likes);
      ctr.classList.remove('tick-pop'); void ctr.offsetWidth; ctr.classList.add('tick-pop');
    }
    setTimeout(function () { btn.classList.remove('bump'); }, 420);
  }

  function setSort(mode) {
    sortMode = mode;
    if (sortNewest) sortNewest.classList.toggle('active', mode === 'newest');
    if (sortBest) sortBest.classList.toggle('active', mode === 'best');
    renderComments();
  }

  /* ---------- reactions ---------- */
  const reactBar = root.querySelector('#hero-reactions');
  const reactStatus = root.querySelector('#hero-react-status');

  function renderReactions() {
    if (!reactBar) return;
    reactBar.replaceChildren();
    REACT_EMOJIS.forEach(function (r) {
      const btn = el('button', 'wd-reaction');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'React with ' + r);
      btn.append(el('span', null, r), el('span', 'wd-reaction-count', String(reactCounts[r] || 0)));
      btn.addEventListener('click', function () { onReact(r, btn); });
      reactBar.append(btn);
    });
  }

  function setReactStatus(msg, kind) {
    if (!reactStatus) return;
    reactStatus.textContent = msg;
    reactStatus.classList.toggle('ok', kind === 'ok');
  }

  async function onReact(r, btn) {
    if (reactBusy) return;
    reactBusy = true;
    document.querySelectorAll('.wd-reaction').forEach(function (b) { b.disabled = true; });
    setReactStatus('Solving proof-of-work…');
    try {
      const base = {
        version: PROTOCOL_VERSION,
        hostContext: 'demo.local',
        articlePath: '/',
        nickname: '',
        body: '',
        challengeId: randomBytes(32),
      };
      const t0 = performance.now();
      const nonce = await mineNonce(base, DIFFICULTY);
      const ms = Math.max(1, Math.round(performance.now() - t0));
      reactCounts[r] = (reactCounts[r] || 0) + 1;
      btn.querySelector('.wd-reaction-count').textContent = String(reactCounts[r]);
      setReactStatus(`✓ ${r} recorded · difficulty ${DIFFICULTY} · proof in ${ms} ms`, 'ok');
    } catch {
      setReactStatus('Something went wrong in the simulation — try again.');
    } finally {
      reactBusy = false;
      document.querySelectorAll('.wd-reaction').forEach(function (b) { b.disabled = false; });
    }
  }

  /* ---------- post ---------- */
  function setStatus(msg, kind) {
    if (!status) return;
    status.textContent = msg;
    status.classList.toggle('ok', kind === 'ok');
    status.classList.toggle('err', kind === 'err');
    status.hidden = false;
  }

  async function onPost() {
    if (busy) return;
    const nick = (nickInput.value || '').trim();
    const body = (bodyInput.value || '').trim();
    if (!body) {
      setStatus('Write a comment first, then press “Post comment”.');
      return;
    }
    busy = true;
    post.disabled = true;
    setStatus('Solving proof-of-work…');
    try {
      const base = {
        version: PROTOCOL_VERSION,
        hostContext: 'demo.local',
        articlePath: '/',
        nickname: nick,
        body,
        challengeId: randomBytes(32),
      };
      const t0 = performance.now();
      const nonce = await mineNonce(base, DIFFICULTY);
      const ms = Math.max(1, Math.round(performance.now() - t0));
      comments.push({ id: Date.now(), nick: nick || 'Anonymous', body, mins: 0, cool: false, pinned: false, likes: 0, voted: false });
      renderComments();
      nickInput.value = '';
      bodyInput.value = '';
      setStatus(`✓ Published · proof verified in ${ms} ms (nonce ${serializeNonce(nonce)})`, 'ok');
    } catch {
      setStatus('Something went wrong in the simulation — please try again.', 'err');
    } finally {
      busy = false;
      post.disabled = false;
    }
  }

  /* ---------- skeleton → live ---------- */
  function showSkeleton() {
    const skel = root.querySelector('#hero-skeleton');
    const live = root.querySelector('#hero-live');
    if (!skel || !live) return;
    skel.hidden = false;
    live.hidden = true;
    setTimeout(function () {
      skel.hidden = true;
      live.hidden = false;
      renderComments();
      renderReactions();
      renderPoll();
    }, 650);
  }

  post.addEventListener('click', onPost);
  bodyInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') onPost(); });
  if (sortNewest) sortNewest.addEventListener('click', function () { setSort('newest'); });
  if (sortBest) sortBest.addEventListener('click', function () { setSort('best'); });

  showSkeleton();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
