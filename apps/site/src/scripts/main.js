/**
 * StaticLayer public site — main JS (vanilla, tiny).
 * Nav toggle, copy buttons, interactive architecture cards, reveal-on-view.
 * No analytics, no tracking, no external requests.
 */
(function () {
  'use strict';

  // Gate JS-dependent behavior (reveal, etc.) behind a class, so content stays
  // visible without JavaScript and under prefers-reduced-motion.
  document.documentElement.classList.add('js');

  /* Mobile nav */
  var burger = document.getElementById('nav-burger');
  var mobileNav = document.getElementById('mobile-nav');
  if (burger && mobileNav) {
    burger.addEventListener('click', function () {
      var open = mobileNav.classList.toggle('open');
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
    });
  }

  /* Copy-to-clipboard on <pre> blocks */
  document.querySelectorAll('pre').forEach(function (pre) {
    var btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-ghost';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code block');
    btn.style.cssText = 'position:absolute;top:10px;right:10px';
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    wrap.appendChild(btn);
    btn.addEventListener('click', function () {
      var text = pre.innerText;
      var done = function () {
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        done();
      }
    });
  });

  /* Interactive architecture cards */
  var archData = {
    visitor: {
      title: 'Visitor',
      text: 'Renders the widget and submits a plain-text comment. No account, no email, no tracking identifiers. The browser never sees any secret.',
      not: 'Nothing is stored about the visitor; no fingerprint, no cookie, no persistent ID.',
    },
    widget: {
      title: 'Widget',
      text: 'Fetches a signed challenge, runs the Proof-of-Work in a Web Worker (UI stays responsive), then POSTs the proof with the comment.',
      not: 'No cookies, no localStorage, no analytics. All code is public and inspectable.',
    },
    worker: {
      title: 'Cloudflare Worker',
      text: 'Verifies the HMAC challenge signature and the Proof-of-Work, consumes the challenge atomically (D1 batch), and stores the comment as pending.',
      not: 'No outbound calls to third parties; no IP, User-Agent or fingerprint persisted.',
    },
    d1: {
      title: 'D1',
      text: 'Stores application data such as nickname, comment text, status and timestamps in the customer\u2019s database. Anti-replay uses used_challenges.',
      not: 'Network identifiers (IP, UA, Referer, CF-Ray) are not stored in the application database.',
    },
  };

  var cards = document.querySelectorAll('[data-arch]');
  var detail = document.getElementById('arch-detail');
  cards.forEach(function (card) {
    card.addEventListener('click', function () {
      cards.forEach(function (c) { c.classList.remove('active'); });
      card.classList.add('active');
      var key = card.getAttribute('data-arch');
      var d = archData[key];
      if (detail && d) {
        detail.innerHTML =
          '<h4>' + d.title + '</h4>' +
          '<p>' + d.text + '</p>' +
          '<p class="not"><b>Not stored:</b> ' + d.not + '</p>';
      }
    });
  });
  if (cards.length && detail) cards[0].click();

  /* GitHub pulse — aggregate stars/watchers/forks (only when the repo is
     public). No cookies, no personal data, no tracking; the badge simply
     stays hidden if the repo is private or the API is unreachable. */
  (function () {
    var el = document.getElementById('gh-pulse');
    if (!el) return;
    var repo = (el.getAttribute('data-repo') || '').replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    if (!repo) return;
    fetch('https://api.github.com/repos/' + repo, { headers: { accept: 'application/vnd.github+json' } })
      .then(function (r) { if (!r.ok) throw new Error('not public'); return r.json(); })
      .then(function (d) {
        if (!d || typeof d.stargazers_count !== 'number') return;
        var s = '\u2605 ' + d.stargazers_count + ' \u00b7 \ud83d\udc40 ' + d.watchers_count + ' \u00b7 \ud83c\udf54 ' + d.forks_count;
        el.textContent = s;
        el.hidden = false;
      })
      .catch(function () { /* private repo or offline — keep hidden */ });
  })();

  /* Reveal on view (subtle, respects reduced motion via CSS transitions) */
  if ('IntersectionObserver' in window) {
    var reveals = document.querySelectorAll('[data-reveal]');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('revealed'); io.unobserve(e.target); }
      });
    }, { threshold: 0.15 });
    reveals.forEach(function (el) { io.observe(el); });
  }
})();
