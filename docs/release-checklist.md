# StaticLayer — Release Checklist

> Gate used before any public release. Nothing is "production-ready" merely
> because tests pass — each item below must have concrete evidence.
> A blank line means "not yet verified for this release".

## Security

- [ ] `npm test` passes (full suite)
- [ ] Anti-replay concurrency test passes (exactly 1 of N accepted)
- [ ] Secrets absent from repository (secret scan clean)
- [ ] Dependency audit reviewed (`npm audit`)
- [ ] OAuth implementation reviewed against current Cloudflare docs
- [ ] CORS allowlist reviewed and tested (public + admin routes)
- [ ] XSS reviewed (plain text only, `textContent`)
- [ ] CSRF reviewed (session-bound token, constant-time)
- [ ] Admin session cookie flags reviewed (`__Host-`, `Secure; HttpOnly; SameSite=Strict`)
- [ ] No secrets in logs / error messages / URLs / HTML / JS / browser storage

## Cloudflare (verified against current official docs — `docs/cloudflare-assumptions.md`)

- [ ] Worker deployment tested
- [ ] Worker routes / custom domains documented and tested
- [ ] D1 creation + bindings tested
- [ ] D1 `batch()` semantics verified
- [ ] Workers Rate Limiting binding tested
- [ ] Bulk Secrets API tested
- [ ] OAuth endpoints + scope IDs verified
- [ ] Workers API permissions (least privilege) verified
- [ ] **Remote D1 concurrency** tested via `wrangler dev --remote` OR explicitly
      documented as pending

## Product

- [ ] Fresh install tested from a clean clone
- [ ] Uninstall / reinstall tested
- [ ] `repair` tested (drift recovery)
- [ ] Update tested
- [ ] GitHub Pages deployment tested
- [ ] Astro example tested
- [ ] Hugo example tested
- [ ] Jekyll example tested
- [ ] Next.js static export example tested
- [ ] Vanilla HTML example tested
- [ ] Mobile viewport tested
- [ ] Accessibility (keyboard, focus, labels, reduced motion) reviewed

## Documentation

- [ ] Quick start (≤ 5 minutes, from `README.md` only)
- [ ] Security documentation current
- [ ] Privacy documentation current
- [ ] Troubleshooting current
- [ ] Architecture current
- [ ] Examples current
- [ ] Simulator works on the public site
- [ ] Website build succeeds on GitHub Pages

## Release gate (all must be green)

1. `npm test`
2. `npm run typecheck`
3. `npm run build`
4. Security review updated
5. Cloudflare assumptions current
6. OAuth assumptions verified
7. Clean-room installation succeeds
8. GitHub Pages build succeeds
9. Simulator works
10. At least one real Cloudflare deployment succeeds
11. Remote D1 concurrency tested or explicitly documented as pending
12. Repository contains no secrets / private data
