/**
 * Widget attribute aliases + programmatic API (Phase F).
 *
 * The widget must support the documented attributes:
 *   - `data-endpoint` / `data-api` (alias)
 *   - `data-article-path` / `data-article-id` (alias)
 *   - article-id defaults to `location.pathname` when omitted
 * and the programmatic API:
 *   - `window.StaticLayer.mount(el, { endpoint, articlePath, hostContext })`
 *   - `window.StaticLayer.unmount(el)`
 */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WIDGET_JS = readFileSync(
  fileURLToPath(new URL('../../packages/widget/dist/widget.js', import.meta.url)),
  'utf8',
);

interface Comment {
  id: string;
  nickname: string;
  body: string;
  created_at: number;
}

function makeDom(html: string, url = 'https://site.example.com/post/1') {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ comments: [] as Comment[] }),
  }) as unknown as typeof fetch;
  window.eval(WIDGET_JS);
  return dom;
}

async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe('widget attribute aliases', () => {
  it('supports data-api as an alias of data-endpoint', async () => {
    const dom = makeDom(
      `<div id="host" data-staticlayer
            data-api="https://comments.example.com"
            data-article-id="/blog/hello"></div>`,
    );
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;
    expect(host.classList.contains('sl-root')).toBe(true);
    // The widget fetched from the data-api endpoint (rendered list exists).
    expect(host.querySelector('.sl-heading')).not.toBeNull();
  });

  it('supports data-article-id as an alias of data-article-path', async () => {
    const dom = makeDom(
      `<div id="host" data-staticlayer
            data-endpoint="https://comments.example.com"
            data-article-id="/blog/hello"></div>`,
    );
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;
    expect(host.classList.contains('sl-root')).toBe(true);
    expect(host.querySelector('.sl-form')).not.toBeNull();
  });

  it('defaults article id to location.pathname when omitted', async () => {
    const dom = makeDom(
      `<div id="host" data-staticlayer
            data-endpoint="https://comments.example.com"></div>`,
      'https://site.example.com/blog/from-url',
    );
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;
    expect(host.classList.contains('sl-root')).toBe(true);
    expect(host.querySelector('.sl-list')).not.toBeNull();
  });
});

describe('widget programmatic API', () => {
  it('exposes window.StaticLayer.mount / unmount', async () => {
    const dom = makeDom('<div id="host"></div>');
    const w = dom.window as unknown as {
      StaticLayer: { mount: (el: Element, opts: object) => void; unmount: (el: Element) => void };
    };
    await flushAsync(); // let DOMContentLoaded fire (jsdom loads async)
    expect(w.StaticLayer).toBeTruthy();
    expect(typeof w.StaticLayer.mount).toBe('function');
    expect(typeof w.StaticLayer.unmount).toBe('function');

    const host = dom.window.document.getElementById('host')!;
    w.StaticLayer.mount(host, {
      endpoint: 'https://comments.example.com',
      articlePath: '/programmatic',
    });
    await flushAsync();
    expect(host.classList.contains('sl-root')).toBe(true);
    expect(host.querySelector('.sl-heading')).not.toBeNull();

    w.StaticLayer.unmount(host);
    expect(host.classList.contains('sl-root')).toBe(false);
    expect(host.childNodes.length).toBe(0);
  });

  it('mount is idempotent (no double-mount)', async () => {
    const dom = makeDom(
      `<div id="host" data-staticlayer
            data-endpoint="https://comments.example.com"
            data-article-path="/x"></div>`,
    );
    const w = dom.window as unknown as {
      StaticLayer: { mount: (el: Element, opts: object) => void };
    };
    await flushAsync(); // let DOMContentLoaded fire (jsdom loads async)
    const host = dom.window.document.getElementById('host')!;
    w.StaticLayer.mount(host, { endpoint: 'https://comments.example.com', articlePath: '/y' });
    w.StaticLayer.mount(host, { endpoint: 'https://comments.example.com', articlePath: '/y' });
    await flushAsync();
    // Only ONE heading + one form were built.
    expect(host.querySelectorAll('.sl-heading').length).toBe(1);
    expect(host.querySelectorAll('.sl-form').length).toBe(1);
  });
});
