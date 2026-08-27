# Threat Model — StaticLayer v1

> Companion to [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) (full evidence) and
> [`SECURITY_AUDIT_REPORT.md`](SECURITY_AUDIT_REPORT.md) (claim-by-claim
> matrix). This file summarizes the threat model for a public release.
> Verified platform facts live in
> [`docs/cloudflare-assumptions.md`](docs/cloudflare-assumptions.md).

## Trust boundaries

```
Browser (visitor)                Customer Cloudflare Worker            Customer D1
  - user-controlled nickname/body   - verifies PoW + signature          - single writer
  - solves PoW in a Web Worker      - consumes challenge atomically     - anti-replay source of truth
  - never sees secrets              - holds the 3 secrets               - stores no IP/UA/ref/fingerprint
```

- The client is fully untrusted.
- The Worker trusts only: its own secrets, the verified HMAC signature, the
  verified PoW, and D1 results.
- D1 is the single source of truth for the anti-replay invariant.

## Threats (summary)

| ID | Threat | Primary defense |
| --- | --- | --- |
| T1 | Spam / automated flooding | Client PoW + anti-replay + route rate limit |
| T2 | Challenge forgery / replay across articles | Signed stateless challenge (`POW_SECRET` HMAC) bound to host + article path |
| T3 | Same challenge used twice (race) | D1 `batch()` + `INSERT OR IGNORE` + conditional insert + `meta.changes` |
| T4 | SQL injection | Prepared statements + `bind()` only |
| T5 | Stored/reflected XSS | `textContent` only; strict UTF-8; plain-text comments |
| T6 | CSRF on admin mutations | Session-bound double-submit token, constant-time |
| T7 | Admin session forgery/tampering | HMAC-signed stateless session, absolute TTL, `__Host-` cookie |
| T8 | Session cookie theft | `Secure; HttpOnly; SameSite=Strict`, no `Domain` |
| T9 | Protocol replay of old proofs | `used_challenges` keyed by `challenge_id`; expiry inside signature |
| T10 | Malformed/oversized payloads | Strict canonical encoding, fail-closed, byte limits |
| T11 | Client weakening PoW difficulty/expiry | `difficulty` + `expiresAt` inside the signed challenge |
| T12 | Rate-limit bypass via IP rotation | Rate limit is edge-local only; never IP-only; PoW + anti-replay are the boundary |
| T13 | Third-party SaaS exfiltration | Zero runtime deps; no outbound calls except D1 binding |
| T14 | Secret misuse/mixing | Exactly 3 secrets, strictly separated roles |
| T15 | Cross-origin abuse (public API) | Origin allowlist on the Worker (Phase F implementation) |
| T16 | Admin over cross-origin | Admin stays same-origin; no cross-origin cookie sessions |

## Invariants

1. **Challenge single-use** — one valid challenge consumed at most once.
2. **Session authenticity** — admin session is signed, TTL-bounded, `__Host-`.
3. **CSRF binding** — mutations require the session-bound token.
4. **No raw HTML rendering** — comments are plain text, `textContent` only.
5. **Prepared SQL** — no string interpolation.
6. **Secret separation** — 3 secrets, disjoint roles.
7. **No visitor tracking** — no cookies/localStorage/sessionStorage/fingerprinting
   in the public widget; **no application-level IP persistence**.
8. **Never silent** — the deploy engine re-verifies live state after apply.

## Operational controls

- Route-scoped rate limiting (challenge/comments/login).
- Request size caps (`MAX_REQUEST_BYTES`, default 64 KB).
- Retention: challenge TTL 5 min; `used_challenges` purge 24 h.
- Daily cron; failures propagate.

## Out of scope (documented)

- PoW is **not** "spam-proof"; it raises the cost of automated submissions.
- Rate limiting is per-location and eventually consistent (Cloudflare-documented);
  it is a backstop, not a security boundary.
- Remote D1 concurrency requires empirical validation via `wrangler dev --remote`
  before commercial launch (see `SECURITY_REVIEW.md §14.4`).
