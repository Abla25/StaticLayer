# Contributing to StaticLayer

Thanks for considering contributing! StaticLayer is source-available under the
Elastic License 2.0 and we welcome issues, bug reports and pull requests.

## Code of conduct

Be respectful, constructive and inclusive. Harassment of any kind is not
tolerated.

## Development setup

```sh
npm install
npm run build
npm test          # full suite (protocol + security + CLI + installer + demo)
npm run typecheck
```

## Project layout (quick map)

```
packages/protocol         canonical binary PoW protocol
packages/runtime          the Cloudflare Worker + D1 (public API, admin, cron)
packages/widget           public widget + PoW Web Worker (vanilla JS)
packages/deployment-core  library-first Desired State Engine + Cloudflare API client
packages/cli              CLI shell (init / status / repair)
apps/installer            Web Installer (OAuth + DSE deploy + wizard)
apps/demo                 public demo worker (data purged daily)
tests/security            integration tests (Miniflare + D1 + jsdom)
```

Read **[MASTER_HANDOFF.md](MASTER_HANDOFF.md)** first — it is the single source
of truth (architecture, invariants, decisions, gotchas).

## Rules for every change

1. **No scope creep.** Keep the runtime dependency-free and the attack surface
   minimal. Security-critical constraints (see below) are non-negotiable.
2. **Verification mandate:** before relying on any Cloudflare-specific API,
   binding, Wrangler config or D1 behavior, verify it against the current
   official docs and record the fact in `docs/cloudflare-assumptions.md`.
   Never infer from memory.
3. **Never use `innerHTML`** for comment data; comments are plain text only.
4. **Prepared statements only** (`.prepare().bind()`); no SQL interpolation.
5. **No tracking:** the public widget must never set cookies or use
   `localStorage`/`sessionStorage`, and the application must never persist IP
   addresses.
6. **Tests are the contract.** Every invariant has an enforcement test. Keep
   the full suite green (`npm test`) and `npm run typecheck` clean.

## Before opening a PR

- Branch from `main`; keep the change focused and small.
- Run `npm test` and `npm run typecheck` locally — they must pass.
- If you touched the widget or any UI, rebuild (`npm run build`) so
  `static-content.ts` is regenerated.
- Add tests for new behavior; document platform assumptions in
  `docs/cloudflare-assumptions.md`.

## Security

Please do not open a public issue for security vulnerabilities. Report them
privately to the maintainers so they can be fixed before disclosure.
