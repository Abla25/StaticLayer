# tests/security — integration tests (Miniflare + local D1 in workerd)

- `replay-concurrency.test.ts` — **mandatory** anti-replay concurrency invariant:
  N=10 concurrent posts sharing one `challenge_id` ⇒ exactly 1×200 + 9×409, and
  the store holds exactly 1 comment + 1 consumed challenge. Also covers
  sequential replay, expired challenges, invalid PoW, tampered signatures,
  oversized bodies, and the admin-login cookie attributes.
- `worker.ts` — spawns the REAL runtime Worker (bundled with esbuild) in
  Miniflare with a fresh ephemeral D1, applying the real migration.

Planned (Phase 2): XSS widget tests, CSRF tests for PATCH/DELETE.
