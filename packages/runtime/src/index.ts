import type { ExportedHandler, ScheduledController, ExecutionContext } from '@cloudflare/workers-types';
import { handleAdminLogin } from './admin.ts';
import { handleAdminDeleteComment, handleAdminListArticles, handleAdminListComments, handleAdminPatchComment } from './admin-comments.ts';
import { handleChallenge } from './challenge.ts';
import { handleListComments } from './comments-read.ts';
import { handleSubmitComment } from './comments.ts';
import { decideCors, handlePreflight, parseAllowedOrigins, withCors } from './cors.ts';
import type { Env } from './env.ts';
import { json, SECURITY_HEADERS } from './http.ts';
import { purgeUsedChallenges } from './retention.ts';
import { handleListReactions, handlePostReaction, handleReactionChallenge } from './reactions.ts';
import { handleStatic } from './static.ts';
import { healthPayload } from './version.ts';

/**
 * StaticLayer v1 — Cloudflare Worker (Phase 2).
 *
 * Public API:
 *   GET  /api/comments            list approved comments for an article
 *   GET  /api/comments/challenge  issue a signed PoW challenge
 *   POST /api/comments            verify PoW + atomic anti-replay + store
 *   GET  /api/reactions           aggregate reaction counts (cacheable)
 *   GET  /api/reactions/challenge signed PoW challenge (escalating difficulty)
 *   POST /api/reactions           verify PoW + store one anonymous reaction
 *   GET  /api/health              runtime + schema version (no data)
 *
 * Admin API (session + CSRF protected):
 *   POST   /api/admin/login                  timing-safe login, session cookie
 *   GET    /api/admin/comments               moderation queue (default pending)
 *   GET    /api/admin/articles               pages with comments + counts
 *   PATCH  /api/admin/comments/:id           approve/reject (+ X-CSRF-Token)
 *   DELETE /api/admin/comments/:id           delete (+ X-CSRF-Token)
 *
 * Static assets:
 *   /widget.js, /pow-worker.js, /admin.html, /admin.js
 *
 * CORS: explicit `ALLOWED_ORIGINS` allowlist, fail-closed (see cors.ts).
 *
 * No tracking, no external calls, no SaaS: everything runs in the customer's
 * Cloudflare account (Worker + D1). Comments are plain text.
 */
const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    // CORS: explicit allowlist, fail-closed (see cors.ts).
    const allowedOrigins = parseAllowedOrigins(env);
    const cors = decideCors(request, allowedOrigins);

    // Preflight for any API/admin path.
    if (method === 'OPTIONS' && pathname.startsWith('/api/')) {
      return handlePreflight(request, cors) ?? json({ error: 'not found' }, 404);
    }

    const respond = (r: Response | Promise<Response>): Promise<Response> =>
      Promise.resolve(r).then((res) => {
        let out = withCors(res, cors);
        // Defense in depth: hardening headers on every API response.
        const headers = new Headers(out.headers);
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
          if (!headers.has(k)) headers.set(k, v);
        }
        return new Response(out.body, {
          status: out.status,
          statusText: out.statusText,
          headers,
        });
      });

    if (pathname === '/api/comments' && method === 'GET') {
      return respond(handleListComments(request, env));
    }
    if (pathname === '/api/comments/challenge' && method === 'GET') {
      return respond(handleChallenge(request, env));
    }
    if (pathname === '/api/comments' && method === 'POST') {
      return respond(handleSubmitComment(request, env));
    }
    if (pathname === '/api/reactions' && method === 'GET') {
      return respond(handleListReactions(request, env));
    }
    if (pathname === '/api/reactions/challenge' && method === 'GET') {
      return respond(handleReactionChallenge(request, env));
    }
    if (pathname === '/api/reactions' && method === 'POST') {
      return respond(handlePostReaction(request, env));
    }
    if (pathname === '/api/admin/login' && method === 'POST') {
      return respond(handleAdminLogin(request, env));
    }
    if (pathname === '/api/admin/comments' && method === 'GET') {
      return respond(handleAdminListComments(request, env));
    }
    if (pathname === '/api/admin/articles' && method === 'GET') {
      return respond(handleAdminListArticles(request, env));
    }
    const adminMatch = pathname.match(/^\/api\/admin\/comments\/([^/]+)$/);
    if (adminMatch && method === 'PATCH') {
      return respond(handleAdminPatchComment(request, env, adminMatch[1] as string));
    }
    if (adminMatch && method === 'DELETE') {
      return respond(handleAdminDeleteComment(request, env, adminMatch[1] as string));
    }

    if (pathname === '/api/health') {
      return respond(json(healthPayload()));
    }

    const staticResponse = handleStatic(pathname);
    if (staticResponse) return respond(staticResponse);

    if (pathname === '/') {
      return respond(json(healthPayload()));
    }
    return respond(json({ error: 'not found' }, 404));
  },

  /**
   * Daily maintenance (cron "0 3 * * *", see wrangler.jsonc): purge
   * `used_challenges` rows older than 24h. Failures propagate (never silent):
   * the cron retries per platform policy.
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await purgeUsedChallenges(env.DB, Date.now());
  },
};

export default worker;
