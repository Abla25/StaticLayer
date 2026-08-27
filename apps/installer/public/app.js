/* StaticLayer Web Installer — wizard UI (vanilla JS, textContent only). */
'use strict';

const $ = (id) => document.getElementById(id);

function show(step) {
  for (let i = 1; i <= 4; i++) {
    const sec = $('s' + i);
    const st = document.querySelector(`[data-step="${i}"]`);
    if (sec) sec.classList.toggle('hidden', i !== step);
    if (st) {
      st.classList.toggle('active', i === step);
      st.classList.toggle('done', i < step);
    }
  }
}

function setText(id, text) {
  const el = $(id);
  el.textContent = text;
  el.classList.remove('hidden');
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

/* ---- Step 1: start (no email needed — self-hosted or hosted) ---- */
$('continue-local').addEventListener('click', () => {
  // Local or hosted: /api/start creates a session without an email. The
  // Cloudflare consent screen (or a pasted token) is the real identity gate.
  window.location.href = '/api/start';
});

/* ---- Step 2: connect (OAuth or API token) ---- */
let accounts = [];

$('connect').addEventListener('click', () => {
  window.location.href = '/api/oauth/start';
});

$('connect-token').addEventListener('click', async () => {
  const token = $('api-token').value.trim();
  if (!token) return;
  try {
    $('connect-token').disabled = true;
    // The token is sent once, validated, kept only in the server session
    // (memory) and cleared after the deploy. Never stored locally.
    await api('/api/token/connect', {
      method: 'POST',
      body: JSON.stringify({ apiToken: token }),
    });
    $('api-token').value = '';
    await refreshMe();
  } catch (err) {
    setText('connect-state', 'Token error: ' + err.message);
  } finally {
    $('connect-token').disabled = false;
  }
});

async function refreshMe() {
  try {
    const me = await api('/api/me');
    if (me.connected && me.accounts.length > 0) {
      accounts = me.accounts;
      show(3);
      const sel = $('account');
      sel.textContent = '';
      for (const a of me.accounts) {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name;
        sel.appendChild(opt);
      }
    } else if (me.connected) {
      setText('connect-state', 'Connected, but no account is reachable with the granted scopes.');
    } else {
      $('connect').disabled = false;
      setText(
        'connect-state',
        me.email === 'local@dev'
          ? 'Local session ready. Choose a connection method below.'
          : 'Signed in as ' + me.email + '. Choose a connection method below.',
      );
      show(2);
    }
  } catch (err) {
    // No session yet (401) — stay on step 1.
    show(1);
  }
}

/* ---- Step 3: plan + deploy ---- */
async function computePlan() {
  const body = {
    accountId: $('account').value || (accounts[0] && accounts[0].id),
    workerName: $('worker-name').value.trim() || undefined,
    databaseName: $('db-name').value.trim() || undefined,
    ratelimitNamespaceId: $('rl-ns').value.trim() || undefined,
    dryRun: true,
  };
  const plan = await api('/api/deploy', { method: 'POST', body: JSON.stringify(body) });
  const box = $('plan-result');
  box.classList.remove('hidden');
  box.textContent = '';
  const title = document.createElement('p');
  title.textContent = plan.alreadyInSync
    ? 'Already in sync — no actions needed.'
    : 'Planned actions:';
  title.classList.add('muted');
  box.appendChild(title);
  const ul = document.createElement('ul');
  ul.className = 'plan-list';
  for (const action of plan.actions) {
    const li = document.createElement('li');
    li.textContent = action;
    if (plan.alreadyInSync) li.classList.add('done-item');
    ul.appendChild(li);
  }
  box.appendChild(ul);
  const deployBtn = $('deploy');
  deployBtn.classList.remove('hidden');
  deployBtn.textContent = plan.alreadyInSync ? 'Deploy anyway →' : 'Confirm & Deploy →';
}

$('plan').addEventListener('click', async () => {
  try {
    $('plan').disabled = true;
    await computePlan();
  } catch (err) {
    setText('plan-result', 'Error: ' + err.message);
  } finally {
    $('plan').disabled = false;
  }
});

$('deploy').addEventListener('click', async () => {
  const body = {
    accountId: $('account').value || (accounts[0] && accounts[0].id),
    workerName: $('worker-name').value.trim() || undefined,
    databaseName: $('db-name').value.trim() || undefined,
    ratelimitNamespaceId: $('rl-ns').value.trim() || undefined,
    dryRun: false,
  };
  try {
    $('deploy').disabled = true;
    const result = await api('/api/deploy', { method: 'POST', body: JSON.stringify(body) });
    show(4);
    // Security (Phase 4 audit): the server NEVER returns secret values. The
    // generated secrets were pushed to Cloudflare via the Bulk Secrets API
    // server-side — the user only sees the success state and the snippet.
    const snippet = [
      `<script src="${result.endpoint}/widget.js" data-staticlayer`,
      `  data-endpoint="${result.endpoint}"`,
      '  data-article-path="/your-article"',
      '  data-host-context="yourdomain.com"></script>',
    ].join('\n');
    $('snippet').textContent = snippet;
  } catch (err) {
    setText('plan-result', 'Deploy error: ' + err.message);
    $('deploy').disabled = false;
  }
});

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('snippet').textContent);
  $('copy').textContent = 'Copied ✓';
});

/* ---- bootstrap ---- */
(async () => {
  try {
    const meta = await api('/api/meta');
    if (!meta.oauthConfigured) {
      // No real OAuth client configured — only the API-token path can work.
      $('oauth-method').classList.add('hidden');
    }
  } catch {
    /* keep defaults */
  }
  refreshMe();
})();
