import { ADMIN_HTML, ADMIN_JS, POW_WORKER_JS, WIDGET_JS } from './static-content.ts';
import { SECURITY_HEADERS } from './http.ts';

/**
 * Static assets served by the Worker (Phase 2):
 *
 *   /widget.js       public widget bundle      Cache-Control: public, max-age=3600
 *   /pow-worker.js   PoW Web Worker bundle     Cache-Control: public, max-age=3600
 *   /admin.html      admin UI (CSP, no-store)
 *   /admin.js        admin UI logic (no-store)
 *
 * Content is inlined at build time by scripts/sync-static.mjs (generated
 * `static-content.ts`), so the Worker has zero external dependencies at
 * runtime.
 */

export const ADMIN_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none';";

// Public widget assets are intentionally readable from ANY origin (the widget
// runs on any site that embeds it). The CORS header is required for the
// widget's cross-origin PoW worker, which the browser fetches and re-hosts as
// a Blob URL (classic workers cannot be created cross-origin).
const PUBLIC_ASSET_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
};

function staticAsset(
  content: string,
  contentType: string,
  cacheControl: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(content, {
    headers: {
      'content-type': contentType,
      'cache-control': cacheControl,
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

export function handleStatic(pathname: string): Response | null {
  switch (pathname) {
    case '/widget.js':
      return staticAsset(WIDGET_JS, 'application/javascript; charset=utf-8', 'public, max-age=3600', PUBLIC_ASSET_HEADERS);
    case '/pow-worker.js':
      return staticAsset(POW_WORKER_JS, 'application/javascript; charset=utf-8', 'public, max-age=3600', PUBLIC_ASSET_HEADERS);
    case '/admin.html':
      return staticAsset(ADMIN_HTML, 'text/html; charset=utf-8', 'no-store', {
        'content-security-policy': ADMIN_CSP,
      });
    case '/admin.js':
      return staticAsset(ADMIN_JS, 'application/javascript; charset=utf-8', 'no-store');
    default:
      return null;
  }
}
