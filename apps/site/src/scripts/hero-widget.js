/**
 * StaticLayer homepage — interactive hero widget.
 *
 * A tiny, real client-side simulation: it mines an actual proof-of-work with
 * @staticlayer/protocol (low difficulty so it stays snappy) and publishes the
 * comment straight into the hero preview. No network, no storage, no tracking,
 * no secrets — exactly like the full simulator on /demo.
 */
import { mineNonce, PROTOCOL_VERSION, randomBytes, serializeNonce } from '@staticlayer/protocol';

const DIFFICULTY = 12; // fast on any device, still a genuine proof

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
  if (!nickInput || !bodyInput || !post || !list || !count) return;

  let busy = false;

  /* -------- reactions (client-side simulation, real PoW) -------- */
  const REACT_EMOJIS = ['👍', '❤️', '🎉'];
  const reactBar = root.querySelector('#hero-reactions');
  const reactStatus = root.querySelector('#hero-react-status');
  const reactCounts = {};
  let reactBusy = false;

  function renderReactions() {
    if (!reactBar) return;
    reactBar.replaceChildren();
    REACT_EMOJIS.forEach(function (r) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wd-reaction';
      btn.setAttribute('aria-label', 'React with ' + r);
      const emoji = document.createElement('span');
      emoji.textContent = r;
      const cnt = document.createElement('span');
      cnt.className = 'wd-reaction-count';
      cnt.textContent = String(reactCounts[r] || 0);
      btn.append(emoji, cnt);
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
      renderReactions();
      setReactStatus(`✓ ${r} recorded · difficulty ${DIFFICULTY} · proof in ${ms} ms`, 'ok');
    } catch {
      setReactStatus('Something went wrong in the simulation — try again.');
    } finally {
      reactBusy = false;
      document.querySelectorAll('.wd-reaction').forEach(function (b) { b.disabled = false; });
    }
  }

  renderReactions();

  function bumpCount() {
    const n = list.querySelectorAll('.wd-item').length;
    count.textContent = `${n} comment${n === 1 ? '' : 's'}`;
  }

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

      // publish into the preview — textContent only, never innerHTML
      const item = el('div', 'wd-item');
      item.style.animation = 'pop-in 0.35s cubic-bezier(.22,1,.36,1)';
      const avatar = el('span', 'wd-avatar', (nick || 'A').charAt(0).toUpperCase());
      avatar.setAttribute('aria-hidden', 'true');
      const main = el('div', 'wd-main');
      const meta = el('div', 'wd-meta');
      meta.append(el('span', 'wd-nick', nick || 'Anonymous'), el('span', 'wd-time', 'just now'));
      main.append(meta, el('p', 'wd-body', body));
      item.append(avatar, main);
      list.append(item);
      bumpCount();
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

  post.addEventListener('click', onPost);
  bodyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onPost();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
