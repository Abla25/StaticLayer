# Security

StaticLayer is designed with a **minimal attack surface and defense-in-depth
security controls**. It is a source-available project: the runtime, protocol,
widget, migrations and security model are all inspectable and auditable.

> StaticLayer does not claim "100% security", "zero bugs", "perfect anonymity"
> or "perfect spam prevention". Claims in the documentation describe observable
> technical behavior only.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**
If you believe you found a vulnerability:

1. Email the maintainers privately (see repository metadata / maintainers).
2. Include:
   - a description of the issue;
   - the affected component (runtime / protocol / widget / installer / CLI);
   - reproduction steps (minimal, without leaking secrets);
   - impact and suggested mitigation if known.
3. Allow time for a coordinated fix before public disclosure.

We will acknowledge receipt and keep you updated on the fix timeline.

## Security posture

### Invariants (tested)

| Invariant | Behavior |
| --- | --- |
| Challenge single-use | One valid challenge is consumed **at most once**, atomically (D1 `batch()`); N concurrent requests with the same `challenge_id` → exactly 1 accepted. |
| Session authenticity | Admin session is a stateless HMAC-signed token with absolute TTL, `__Host-` cookie (`Secure; HttpOnly; SameSite=Strict; Path=/`, no `Domain`). |
| CSRF binding | Admin mutations require a session-bound token (`X-CSRF-Token`) verified in constant time. |
| No raw HTML rendering | Comments are plain text; the widget renders exclusively with `textContent`. |
| Prepared SQL | All database access uses prepared statements + parameter binding. |
| Secret separation | Exactly 3 secrets with strictly separated roles (`ADMIN_SECRET`, `SESSION_SECRET`, `POW_SECRET`). |

### Privacy constraints

- The public widget does not use visitor tracking cookies, local storage,
  fingerprinting, or analytics.
- **No application-level IP persistence** — the application database stores no
  IP addresses, User-Agents, Referers, CF-Ray IDs or persistent visitor IDs.
- Comment data is stored in the **customer's Cloudflare infrastructure**; no
  centralized StaticLayer comment database is required.

### Operational controls

- Rate limiting (route-scoped, edge-local backstop — never the sole security
  boundary).
- Request size limits (max body bytes enforced server-side).
- Challenge retention: challenge TTL 5 minutes; `used_challenges` purged after
  24 hours.
- Daily maintenance cron (retention purge); failures propagate (never silent).

## Dependency hygiene

- The runtime has **zero external application dependencies** (`@staticlayer/protocol`
  is dependency-free).
- Build tooling (esbuild, TypeScript, wrangler, vitest) is development-scoped.

## Release discipline

We do not claim production readiness merely because tests pass. The public
release gate is documented in [`docs/release-checklist.md`](docs/release-checklist.md)
and audited in `PUBLIC_RELEASE_AUDIT.md` before each release.
