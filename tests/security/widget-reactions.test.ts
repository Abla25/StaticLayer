/**
 * Widget reactions bar (Phase reactions).
 *
 * With `data-reactions="👍,❤️"` the widget renders a themed reaction bar,
 * loads counts from GET /api/reactions, and each click runs a REAL
 * Proof-of-Work (Web Worker stub in jsdom) before POSTing the reaction.
 */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { base64UrlToBytes, mineNonce, PROTOCOL_VERSION, serializeNonce } from '@staticlayer/protocol';

const WIDGET_JS = readFileSync(
  fileURLToPath(new URL('../../packages/widget/dist/widget.js', import.meta.url)),
  'utf8',
);

interface PostedReaction {
  challengeId: string;
  articlePath: string;
  reaction: string;
  difficulty: number;
  nonce: string;
}

function makeDom() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <div id="host" data-staticlayer
            data-endpoint="https://comments.example.com"
            data-article-path="/blog/x"
            data-reactions="👍,❤️"></div>
     </body></html>`,
    { url: 'https://site.example.com/blog/x', runScripts: 'outside-only' },
  );
  const { window } = dom;

  const posted: PostedReaction[] = [];

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://comments.example.com/api/comments')) {
      return { ok: true, status: 200, json: async () => ({ comments: [] }) } as Response;
    }
    if (url.startsWith('https://comments.example.com/api/reactions?article_path')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ reactions: [{ reaction: '👍', count: 3 }] }),
      } as Response;
    }
    if (url.startsWith('https://comments.example.com/api/reactions/challenge')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          challengeId: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          hostContext: 'site.example.com',
          articlePath: '/blog/x',
          difficulty: 4,
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          signature: 'test-signature',
        }),
      } as Response;
    }
    if (url === 'https://comments.example.com/api/reactions' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as PostedReaction;
      posted.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, reaction: body.reaction, reactions: [{ reaction: '👍', count: 4 }] }),
      } as Response;
    }
    throw new Error('unexpected fetch: ' + url);
  };

  // Web Worker stub: actually mines a nonce with the real protocol.
  window.Worker = class FakeWorker {
    onmessage: ((e: { data: { type: string; nonce?: string } }) => void) | null = null;
    onerror: (() => void) | null = null;
    postMessage(data: { challenge: { hostContext: string; articlePath: string; challengeId: string; difficulty: number }; nickname: string; body: string }): void {
      const c = data.challenge;
      mineNonce(
        {
          version: PROTOCOL_VERSION,
          hostContext: c.hostContext,
          articlePath: c.articlePath,
          nickname: data.nickname,
          body: data.body,
          challengeId: base64UrlToBytes(c.challengeId),
        },
        c.difficulty,
      ).then((nonce) => {
        if (this.onmessage) {
          this.onmessage({ data: { type: 'nonce', nonce: serializeNonce(nonce) } });
        }
      });
    }
    terminate(): void {}
  } as unknown as typeof Worker;

  window.eval(WIDGET_JS);
  return { dom, posted };
}

async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 40));
}

describe('widget reactions bar', () => {
  it('renders the bar with counts and posts a reaction after real PoW', async () => {
    const { dom, posted } = makeDom();
    await flushAsync(); // DOMContentLoaded → load counts

    const host = dom.window.document.getElementById('host')!;
    const buttons = host.querySelectorAll('.sl-reaction');
    expect(buttons.length).toBe(2);

    const labels = Array.from(buttons).map((b) => b.textContent);
    expect(labels).toContain('👍3'); // count from GET
    expect(labels).toContain('❤️0');

    // click 👍 → challenge → PoW (worker stub) → POST
    const like = Array.from(buttons).find((b) => b.textContent!.startsWith('👍')) as HTMLButtonElement;
    like.click();
    await flushAsync();

    expect(posted.length).toBe(1);
    expect(posted[0].reaction).toBe('👍');
    expect(posted[0].articlePath).toBe('/blog/x');
    expect(posted[0].difficulty).toBe(4);
    // serializeNonce returns number | string depending on magnitude
    expect(['string', 'number']).toContain(typeof posted[0].nonce);
    expect(String(posted[0].nonce)).toMatch(/^[0-9]+$/); // real mined nonce

    // counts updated from the POST response
    const likeCount = host.querySelector('.sl-reaction .sl-reaction-count')?.textContent;
    expect(likeCount).toBe('4');
    const status = host.querySelector('.sl-reaction-status')?.textContent;
    expect(status).toContain('Reaction recorded');
  });

  it('renders no bar when data-reactions is absent', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>
         <div id="host" data-staticlayer
              data-endpoint="https://comments.example.com"
              data-article-path="/blog/x"></div>
       </body></html>`,
      { url: 'https://site.example.com/blog/x', runScripts: 'outside-only' },
    );
    const { window } = dom;
    window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ comments: [] }) }) as Response;
    window.eval(WIDGET_JS);
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;
    expect(host.querySelectorAll('.sl-reaction').length).toBe(0);
    expect(host.querySelector('.sl-form')).not.toBeNull(); // comments still render
  });

  it('data-reactions-only renders a standalone bar with NO comment UI', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>
         <div id="host" data-staticlayer
              data-endpoint="https://comments.example.com"
              data-article-path="/blog/x"
              data-reactions="👍,❤️"
              data-reactions-only></div>
       </body></html>`,
      { url: 'https://site.example.com/blog/x', runScripts: 'outside-only' },
    );
    const { window } = dom;
    window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ comments: [] }) }) as Response;
    window.eval(WIDGET_JS);
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;
    expect(host.querySelectorAll('.sl-reaction').length).toBe(2);
    expect(host.querySelector('.sl-form')).toBeNull(); // no comment form
    expect(host.querySelector('.sl-heading')).toBeNull(); // no comment heading
    expect(host.querySelector('.sl-list')).toBeNull(); // no comment list
    expect(host.classList.contains('sl-root')).toBe(true);
  });

  it('mount({ reactionsOnly: true }) renders a standalone bar', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><div id="host"></div></body></html>`,
      { url: 'https://site.example.com/blog/x', runScripts: 'outside-only' },
    );
    const { window } = dom;
    window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ comments: [] }) }) as Response;
    window.eval(WIDGET_JS);
    await flushAsync();
    const w = window as unknown as {
      StaticLayer: { mount: (el: Element, opts: object) => void };
    };
    const host = window.document.getElementById('host')!;
    w.StaticLayer.mount(host, {
      endpoint: 'https://comments.example.com',
      articlePath: '/blog/x',
      reactions: ['🔥'],
      reactionsOnly: true,
    });
    await flushAsync();
    expect(host.querySelectorAll('.sl-reaction').length).toBe(1);
    expect(host.querySelector('.sl-form')).toBeNull();
  });
});
