import { ADMIN_HTML, ADMIN_JS, POW_WORKER_JS, WIDGET_JS } from './static-content.ts';
import { BRAND_ICON_BASE64 } from './static/brand-icon.ts';
import { SECURITY_HEADERS } from './http.ts';

/**
 * Static assets served by the Worker (Phase 2):
 *
 *   /widget.js       public widget bundle      Cache-Control: public, max-age=3600
 *   /pow-worker.js   PoW Web Worker bundle     Cache-Control: public, max-age=3600
 *   /admin.html      admin UI (CSP, no-store)
 *   /admin.js        admin UI logic (no-store)
 *   /icon.png        brand icon (96×96, base64-inlined)
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

let iconBody: ArrayBuffer | null = null;

/** Decode the inlined base64 PNG once, then reuse the buffer. */
function iconArrayBuffer(): ArrayBuffer {
  if (iconBody) return iconBody;
  const bin = atob(BRAND_ICON_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  iconBody = out.buffer;
  return iconBody;
}

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
    case '/icon.png':
      return new Response(iconArrayBuffer(), {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=3600',
          ...SECURITY_HEADERS,
          ...PUBLIC_ASSET_HEADERS,
        },
      });
    default:
      return null;
  }
}
