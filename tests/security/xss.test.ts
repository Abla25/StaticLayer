import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * XSS protection (SECURITY_REVIEW.md I8): the widget MUST render comments with
 * textContent only. A comment whose body/nickname contain HTML/script payloads
 * must appear as literal text — the DOM must contain NO injected elements.
 */

const WIDGET_JS = readFileSync(
  fileURLToPath(new URL('../../packages/widget/dist/widget.js', import.meta.url)),
  'utf8',
);

const XSS_BODY = '"><img src=x onerror=alert(1)>';
const XSS_NICK = '<script>alert("xss")</script>';

interface Comment {
  id: string;
  nickname: string;
  body: string;
  created_at: number;
}

function renderWidget(comments: Comment[]) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <div id="host" data-staticlayer
            data-endpoint="https://comments.example.com"
            data-article-path="/blog/x"></div>
     </body></html>`,
    { url: 'https://site.example.com/post/1', runScripts: 'outside-only' },
  );
  const { window } = dom;

  // Minimal fetch stub (jsdom has no fetch): plain object is enough for the
  // widget render path (it uses res.ok + res.json()).
  window.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ comments }),
  }) as unknown as typeof fetch;

  window.eval(WIDGET_JS);

  return dom;
}

async function flushAsync(): Promise<void> {
  // Let the widget's async fetch + render settle (microtasks + macrotask).
  await new Promise((r) => setTimeout(r, 20));
}

describe('widget XSS safety (I8)', () => {
  it('renders an XSS payload as literal text with NO injected <img>/<script> nodes', async () => {
    const dom = renderWidget([
      { id: '1', nickname: XSS_NICK, body: XSS_BODY, created_at: 1700000000 },
    ]);
    await flushAsync();

    const host = dom.window.document.getElementById('host');
    expect(host).not.toBeNull();

    // No element nodes were injected — only text.
    expect(host!.querySelectorAll('img, script')).toHaveLength(0);

    // The payloads appear as literal text.
    expect(host!.textContent).toContain(XSS_BODY);
    expect(host!.textContent).toContain(XSS_NICK);

    // The body is rendered as a single TEXT node inside .sl-body.
    const bodyEl = host!.querySelector('.sl-body');
    expect(bodyEl).not.toBeNull();
    expect(bodyEl!.childNodes.length).toBe(1);
    expect(bodyEl!.childNodes[0]!.nodeType).toBe(3); // TEXT_NODE
    dom.window.close();
  });

  it('renders the empty state and normal comments without HTML parsing', async () => {
    const dom = renderWidget([
      { id: '1', nickname: 'Alice', body: 'Hello <world> & "friends"', created_at: 1700000000 },
    ]);
    await flushAsync();

    const host = dom.window.document.getElementById('host')!;
    expect(host.querySelectorAll('img, script')).toHaveLength(0);
    expect(host.textContent).toContain('Hello <world> & "friends"');
    dom.window.close();
  });
});
