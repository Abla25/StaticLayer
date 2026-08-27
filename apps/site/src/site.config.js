/**
 * StaticLayer public website — central config.
 *
 * `repo` is resolved dynamically so every GitHub link on the site is correct
 * on GitHub Actions (GITHUB_REPOSITORY is set automatically) and locally
 * (override with STATICLAYER_REPO_URL). `base` is resolved at build time
 * (see build.mjs): from SITE_BASE env var or GITHUB_REPOSITORY (subpath).
 */
function resolveRepo() {
  if (process.env.STATICLAYER_REPO_URL) return process.env.STATICLAYER_REPO_URL;
  if (process.env.GITHUB_REPOSITORY) return `https://github.com/${process.env.GITHUB_REPOSITORY}`;
  return 'https://github.com/Abla25/StaticLayer';
}

export default {
  title: 'StaticLayer',
  description:
    'Source-available, Cloudflare-native comments for static sites. Your Worker. Your database. No centralized comment platform.',
  repo: resolveRepo(),
  keywords: [
    'static site comments',
    'source-available comments',
    'Cloudflare comments',
    'self-hosted comments',
    'GitHub Pages comments',
    'BYOC comments',
  ],
};
