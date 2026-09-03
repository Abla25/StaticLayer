/**
 * StaticLayer public website builder — static, zero framework.
 *
 *  - Bundles JS with esbuild (main.js + lazy simulator.js).
 *  - Wraps each src/pages/*.html in a shared layout (header/nav/footer).
 *  - GitHub Pages subpath-safe: base is resolved from SITE_BASE or derived
 *    from GITHUB_REPOSITORY on GitHub Actions (e.g. /staticlayer/).
 *  - Generates sitemap.xml + robots.txt.
 *  - Prints final asset sizes (see §58 bundle validation).
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import siteConfig from './src/site.config.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const PUBLIC = join(ROOT, 'public');
const OUT = join(ROOT, 'dist');

// --- brand mark (StaticLayer icon) ------------------------------------------
// The project icon is a PNG (assets/brand/staticlayer-icon.png); a square,
// padded variant is shipped at /brand/icon-square.png and used everywhere.
const brandMark = (size) =>
  `<img src="${BASE}brand/icon-square.png" alt="" width="${size}" height="${size}" aria-hidden="true">`;

// --- resolve base path (GitHub Pages subpath support) ---------------------
function resolveBase() {
  if (process.env.SITE_BASE) {
    return `/${String(process.env.SITE_BASE).replace(/^\/+|\/+$/g, '')}/`;
  }
  if (process.env.GITHUB_REPOSITORY) {
    const repoName = process.env.GITHUB_REPOSITORY.split('/')[1] || 'staticlayer';
    return `/${repoName}/`;
  }
  return '/';
}
const BASE = resolveBase();

// Canonical domain: SITE_URL wins, else derive the GitHub Pages URL from
// GITHUB_REPOSITORY (owner.github.io), else fall back (local builds only).
const DOMAIN = (
  process.env.SITE_URL ||
  (process.env.GITHUB_REPOSITORY
    ? `https://${process.env.GITHUB_REPOSITORY.split('/')[0]}.github.io`
    : 'https://example.com')
).replace(/\/+$/, '');

// --- front matter helpers --------------------------------------------------
const FM = {
  title: /<!--\s*title:\s*(.+?)\s*-->/,
  description: /<!--\s*description:\s*(.+?)\s*-->/,
  active: /<!--\s*active:\s*(.+?)\s*-->/,
};
function fm(page, name) {
  const m = page.match(FM[name]);
  return m ? m[1].trim() : '';
}

// --- plain-text helpers (FAQ schema + llms-full.txt) -------------------------
/** Strip HTML to readable plain text (tags become line breaks, entities decoded). */
function plainText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/p>|<br\s*\/?>|<\/li>|<\/h[1-6]>|<\/tr>|<\/summary>|<\/details>|<\/div>|<\/section>|<\/article>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Page body text without the doc-sidebar / nav boilerplate. */
function pageText(rawHtml) {
  return plainText(
    rawHtml.replace(/<aside[\s\S]*?<\/aside>/gi, ' ').replace(/<nav[\s\S]*?<\/nav>/gi, ' '),
  );
}

/** Extract FAQPage Q&A pairs from the faq page's <details> blocks. */
function extractFaq(html) {
  const out = [];
  const re = /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
  let m;
  while ((m = re.exec(html))) {
    out.push({ q: plainText(m[1]), a: plainText(m[2]) });
  }
  return out;
}

// --- layout ----------------------------------------------------------------
function layout({ title, description, body, active, withSimulator, withHeroWidget, slug, headExtra = '' }) {
  // Primary navigation (top level) + Docs dropdown.
  const primary = [
    ['Product', `${BASE}index.html`, 'product'],
    ['Demo', `${BASE}demo.html`, 'demo'],
  ];
  const DOC_PAGES = [
    ['Quick start', `${BASE}docs.html`, 'docs'],
    ['Universal install', `${BASE}install.html`, 'install'],
    ['Integrations', `${BASE}integrations.html`, 'integrations'],
    ['Comments', `${BASE}comments.html`, 'comments'],
    ['Reactions', `${BASE}reactions.html`, 'reactions'],
    ['Polls', `${BASE}polls.html`, 'polls'],
    ['Security', `${BASE}security.html`, 'security'],
    ['Privacy', `${BASE}privacy.html`, 'privacy'],
    ['FAQ', `${BASE}faq.html`, 'faq'],
    ['Alternatives', `${BASE}compare.html`, 'compare'],
  ];
  const DOCS_KEYS = DOC_PAGES.map(([, , k]) => k);
  const docsActive = DOCS_KEYS.includes(active);
  const isActive = (key) => active === key;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="keywords" content="${siteConfig.keywords.join(', ')}">
<!-- Google Search Console site verification (public by design — proves HTML ownership only). -->
<meta name="google-site-verification" content="-Z8Zf6XvXtyE8_aAlrqOTOtKQRegUoNZfTIsgbx2Vy4" />
<link rel="canonical" href="${DOMAIN}${BASE}${slug}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="StaticLayer">
<meta property="og:url" content="${DOMAIN}${BASE}${slug}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${DOMAIN}${BASE}og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${DOMAIN}${BASE}og-image.png">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "StaticLayer",
  "applicationCategory": "WebApplication",
  "applicationSubCategory": "CommentSystem",
  "operatingSystem": "Any",
  "description": ${JSON.stringify(description)},
  "url": "${DOMAIN}${BASE}",
  "image": "${DOMAIN}${BASE}og-image.png",
  "featureList": "Moderated nested comments, proof-of-work anti-spam, anonymous emoji reactions, polls, owner replies, moderation queue, GDPR data export — self-hosted in your own Cloudflare account",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "publisher": { "@type": "Organization", "name": "StaticLayer" }
}
</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "StaticLayer",
  "url": "${DOMAIN}${BASE}",
  "inLanguage": "en",
  "description": ${JSON.stringify(description)}
}
</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "StaticLayer",
  "url": "${DOMAIN}${BASE}",
  "logo": "${DOMAIN}${BASE}brand/icon-square.png",
  "description": ${JSON.stringify(siteConfig.description)},
  "sameAs": ["${siteConfig.repo}"]
}
</script>
${headExtra}
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${BASE}favicon.png" type="image/png">
<link rel="apple-touch-icon" href="${BASE}apple-touch-icon.png">
<link rel="stylesheet" href="${BASE}assets/global.css">
<script>
  // Respect reduced motion before first paint
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.documentElement.classList.add('reduce-motion');
  }
</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-nav" id="site-nav">
  <div class="container nav-inner">
    <a class="brand" href="${BASE}index.html" aria-label="StaticLayer home">
      <span class="brand-mark" aria-hidden="true">${brandMark(30)}</span>
      <span class="brand-name">StaticLayer</span>
    </a>
    <nav class="nav-links" aria-label="Primary">
      ${primary.map(([label, href, key]) => `<a href="${href}" ${isActive(key) ? 'class="active" aria-current="page"' : ''}>${label}</a>`).join('')}
      <details class="nav-drop" ${docsActive ? 'data-current' : ''}>
        <summary class="${docsActive ? 'active' : ''}">Docs<span class="caret" aria-hidden="true"></span></summary>
        <div class="drop-menu" role="menu">
          ${DOC_PAGES.map(([label, href, key]) => `<a href="${href}" role="menuitem" ${isActive(key) ? 'class="active" aria-current="page"' : ''}>${label}</a>`).join('')}
        </div>
      </details>
      <a href="${siteConfig.repo}" class="nav-github" target="_blank" rel="noopener">GitHub ↗</a>
    </nav>
    <div class="nav-actions">
      <a class="btn btn-primary btn-sm" href="${BASE}docs.html">Get started</a>
      <button class="nav-burger" id="nav-burger" aria-label="Menu" aria-expanded="false" aria-controls="mobile-nav">
        <span></span><span></span>
      </button>
    </div>
  </div>
  <nav class="mobile-nav" id="mobile-nav" aria-label="Mobile">
    ${primary.map(([label, href, key]) => `<a href="${href}" ${isActive(key) ? 'class="active"' : ''}>${label}</a>`).join('')}
    ${DOC_PAGES.map(([label, href, key]) => `<a href="${href}" ${isActive(key) ? 'class="active"' : ''}>${label}</a>`).join('')}
    <a href="${siteConfig.repo}" target="_blank" rel="noopener">GitHub ↗</a>
    <a class="btn btn-primary" href="${BASE}docs.html">Get started</a>
  </nav>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="container footer-inner">
    <div>
      <p class="footer-brand"><span class="brand-mark" aria-hidden="true">${brandMark(26)}</span>StaticLayer</p>
      <p class="footer-tag">Comments for static sites — without the comment SaaS.</p>
    </div>
    <div class="footer-links">
      <a href="${BASE}index.html">Product</a>
      <a href="${BASE}demo.html">Demo</a>
      <a href="${BASE}docs.html">Docs</a>
      <a href="${BASE}security.html">Security</a>
      <a href="${BASE}privacy.html">Privacy</a>
      <a href="${BASE}faq.html">FAQ</a>
    </div>
    <div class="footer-links">
      <a href="${siteConfig.repo}" target="_blank" rel="noopener">GitHub</a>
      <a href="${siteConfig.repo}/blob/main/SECURITY.md" target="_blank" rel="noopener">Report a vulnerability</a>
      <a href="${BASE}docs.html#quick-start">Quick start</a>
    </div>
    <p class="footer-legal">Source-available (Elastic License 2.0) · BYOC · <a href="${siteConfig.repo}/blob/main/TERMS.md" target="_blank" rel="noopener">Terms</a><span class="gh-pulse" id="gh-pulse" hidden data-repo="${siteConfig.repo}"></span></p>
  </div>
</footer>
<script src="${BASE}assets/main.js" defer></script>
${withSimulator ? `<script type="module" src="${BASE}assets/simulator.js" defer></script>` : ''}
${withHeroWidget ? `<script type="module" src="${BASE}assets/hero-widget.js" defer></script>` : ''}
</body>
</html>`;
}

// --- build steps -----------------------------------------------------------
mkdirSync(OUT, { recursive: true });

// JS bundles
await Promise.all([
  build({
    entryPoints: [join(SRC, 'scripts', 'main.js')],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    outfile: join(OUT, 'assets', 'main.js'),
    minify: process.env.NODE_ENV === 'production',
    logLevel: 'silent',
  }),
  build({
    entryPoints: [join(SRC, 'scripts', 'simulator.js')],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    outfile: join(OUT, 'assets', 'simulator.js'),
    minify: process.env.NODE_ENV === 'production',
    logLevel: 'silent',
  }),
  build({
    entryPoints: [join(SRC, 'scripts', 'hero-widget.js')],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    outfile: join(OUT, 'assets', 'hero-widget.js'),
    minify: process.env.NODE_ENV === 'production',
    logLevel: 'silent',
  }),
]);

// CSS (single design-system file, copied verbatim)
cpSync(join(SRC, 'styles', 'global.css'), join(OUT, 'assets', 'global.css'));

// Public assets (favicon, OG, etc.)
if (existsSync(PUBLIC)) cpSync(PUBLIC, OUT, { recursive: true });

// Pages
const pagesDir = join(SRC, 'pages');
const pages = readdirSync(pagesDir).filter((f) => f.endsWith('.html')).sort();
const sitemap = [];
const slugs = [];
const pagesMeta = [];
for (const file of pages) {
  let raw = readFileSync(join(pagesDir, file), 'utf8');
  raw = raw.replaceAll('{{BASE}}', BASE);
  raw = raw.replaceAll('{{REPO}}', siteConfig.repo);
  const title = fm(raw, 'title') || siteConfig.title;
  const description = fm(raw, 'description') || siteConfig.description;
  const active = fm(raw, 'active') || '';
  const withSimulator = /<!--\s*simulator:\s*true\s*-->/.test(raw);
  const withHeroWidget = /class="widget-demo"/.test(raw);
  const slug = file === 'index.html' ? '' : file.replace(/\.html$/, '');

  // FAQ page: emit FAQPage JSON-LD derived from the page's own <details> blocks
  // (single source of truth — the schema can never drift from the content).
  let headExtra = '';
  if (slug === 'faq') {
    const faq = extractFaq(raw);
    if (faq.length > 0) {
      headExtra = `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      })}</script>`;
    }
  }

  const html = layout({ title, description, body: raw, active, withSimulator, withHeroWidget, slug, headExtra });
  writeFileSync(join(OUT, file), html);
  slugs.push({ slug, title });
  pagesMeta.push({ slug, title, description, text: pageText(raw) });
  sitemap.push(`${BASE}${slug}`);
  console.log(`site: ${file} → ${slug || '(home)'}`);
}

// sitemap.xml + robots.txt
const today = new Date().toISOString().slice(0, 10);
const domain = DOMAIN;
writeFileSync(
  join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${slugs
    .map((s) => `  <url><loc>${domain}${BASE}${s.slug}</loc><lastmod>${today}</lastmod></url>`)
    .join('\n')}\n</urlset>\n`,
);
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${domain}${BASE}sitemap.xml\n`);

// --- llms.txt + llms-full.txt (AI crawler discovery) ------------------------
// https://llmstxt.org — a curated index + full plain-text of the site so LLM
// crawlers (GPTBot, ClaudeBot, PerplexityBot, etc.) can cite StaticLayer.
const abs = (slug) => `${domain}${BASE}${slug}`;
const bySlug = Object.fromEntries(pagesMeta.map((p) => [p.slug, p]));
const get = (k) => bySlug[k] ?? { slug: k, title: k, description: '' };
const productPages = [get(''), get('demo')];
const docPages = ['docs', 'install', 'integrations', 'comments', 'reactions', 'polls', 'compare'].map(get);
const trustPages = ['security', 'privacy', 'faq'].map(get);
const bullet = (p) => `- [${p.title}](${abs(p.slug)}): ${p.description}`;

const llmsTxt = [
  '# StaticLayer',
  '',
  `> ${siteConfig.description}`,
  '',
  '## What is StaticLayer?',
  '',
  'StaticLayer is a source-available, Cloudflare-native comment system for static sites. It runs entirely inside your own Cloudflare account (Worker + D1): no centralized comment SaaS, no trackers, no cookies. Visitors get moderated nested comments, anonymous PoW-protected emoji reactions and polls.',
  '',
  '## Product',
  ...productPages.map(bullet),
  '',
  '## Documentation',
  ...docPages.map(bullet),
  '',
  '## Trust & legal',
  ...trustPages.map(bullet),
  '',
  '## Links',
  `- [GitHub repository](${siteConfig.repo})`,
  `- [License — Elastic License 2.0](${siteConfig.repo}/blob/main/LICENSE)`,
  '',
].join('\n');

const llmsFullTxt = [
  '# StaticLayer',
  '',
  `> ${siteConfig.description}`,
  '',
  ...pagesMeta.flatMap((p) => [
    '',
    `# ${p.title}`,
    '',
    `URL: ${abs(p.slug)}`,
    '',
    p.text,
  ]),
  '',
].join('\n');

writeFileSync(join(OUT, 'llms.txt'), `${llmsTxt}\n`);
writeFileSync(join(OUT, 'llms-full.txt'), `${llmsFullTxt}\n`);
console.log(`llms.txt: ${(llmsTxt.length / 1024).toFixed(1)} KB · llms-full.txt: ${(llmsFullTxt.length / 1024).toFixed(1)} KB`);


// Asset size report
console.log('\n— site assets —');
for (const asset of ['assets/main.js', 'assets/simulator.js', 'assets/global.css']) {
  const p = join(OUT, asset);
  if (existsSync(p)) {
    const bytes = readFileSync(p).length;
    console.log(`  ${asset}: ${(bytes / 1024).toFixed(1)} KB`);
  }
}
console.log(`\nsite built → ${OUT} (base "${BASE}")`);
