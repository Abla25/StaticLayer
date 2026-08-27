/**
 * Widget COMMENTS v2 (Round 21.21):
 *   - thread sort (newest/oldest/best, pinned always on top)
 *   - pinned badge + relative timestamps + "Read more" for long comments
 *   - anonymous like button (PoW + per-browser guard) and visitor "Report"
 *
 * The FakeWorker mines REAL nonces with the protocol, so the full pipeline
 * (widget → worker → POST /api/comments/{vote,flag}) is exercised.
 */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  base64UrlToBytes,
  mineCommentActionNonce,
  mineNonce,
  PROTOCOL_VERSION,
  serializeNonce,
} from '@staticlayer/protocol';

const WIDGET_JS = readFileSync(
  fileURLToPath(new URL('../../packages/widget/dist/widget.js', import.meta.url)),
  'utf8',
);

const CHALLENGE = {
  challengeId: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  hostContext: 'site.example.com',
  articlePath: '/blog/x',
  difficulty: 4,
  expiresAt: Math.floor(Date.now() / 1000) + 300,
  signature: 'test-signature',
};

interface MockComment {
  id: string;
  nickname: string;
  body: string;
  created_at: number;
  parent_id: string | null;
  is_owner: number;
  pinned: boolean;
  votes: number;
  voted: boolean;
}

function makeDom(html: string, comments: MockComment[]) {
  const dom = new JSDOM(html, { url: 'https://site.example.com/blog/x', runScripts: 'outside-only' });
  const { window } = dom;

  const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
  let votes = comments.map((c) => c.votes);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://comments.example.com/api/comments?article_path')) {
      return { ok: true, status: 200, json: async () => ({ comments }) } as Response;
    }
    if (url.startsWith('https://comments.example.com/api/comments/challenge')) {
      return { ok: true, status: 200, json: async () => CHALLENGE } as Response;
    }
    if (url === 'https://comments.example.com/api/comments/vote' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push({ url, body });
      const idx = comments.findIndex((c) => c.id === body.commentId);
      votes[idx] = (votes[idx] || 0) + 1;
      comments[idx].voted = true;
      return { ok: true, status: 200, json: async () => ({ ok: true, votes: votes[idx], voted: true, voterToken: 'tok.abc' }) } as Response;
    }
    if (url === 'https://comments.example.com/api/comments/flag' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push({ url, body });
      return { ok: true, status: 200, json: async () => ({ ok: true, flagged: true }) } as Response;
    }
    if (url.endsWith('pow-worker.js')) {
      return { ok: true, status: 200, blob: async () => new Blob(['// mock pow worker'], { type: 'application/javascript' }) } as Response;
    }
    throw new Error('unexpected fetch: ' + url);
  };

  window.URL.createObjectURL = (() => 'blob:staticlayer-mock') as typeof URL.createObjectURL;
  window.URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

  window.Worker = class FakeWorker {
    onmessage: ((e: { data: { type: string; nonce?: string } }) => void) | null = null;
    onerror: (() => void) | null = null;
    postMessage(data: {
      challenge: typeof CHALLENGE;
      nickname?: string;
      body?: string;
      action?: string;
      commentId?: string;
    }): void {
      const c = data.challenge;
      const work =
        typeof data.action === 'string' && typeof data.commentId === 'string'
          ? mineCommentActionNonce(
              {
                version: PROTOCOL_VERSION,
                action: data.action === 'vote' ? 'vote' : 'flag',
                hostContext: c.hostContext,
                articlePath: c.articlePath,
                commentId: data.commentId,
                challengeId: base64UrlToBytes(c.challengeId),
              },
              c.difficulty,
            )
          : mineNonce(
              {
                version: PROTOCOL_VERSION,
                hostContext: c.hostContext,
                articlePath: c.articlePath,
                nickname: data.nickname ?? '',
                body: data.body ?? '',
                challengeId: base64UrlToBytes(c.challengeId),
              },
              c.difficulty,
            );
      work.then((nonce) => {
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

function names(host: Element, sel: string): string[] {
  return Array.from(host.querySelectorAll(sel)).map((n) => n.textContent?.trim() ?? '');
}

const LONG_BODY = 'x'.repeat(450);

describe('widget comments v2 — sort, pin, time, read-more', () => {
  const base = [
    { id: 'c1', nickname: 'Alice', body: 'oldest', created_at: 100, parent_id: null, is_owner: 0, pinned: false, votes: 0, voted: false },
    { id: 'c2', nickname: 'Bob', body: 'middle', created_at: 300, parent_id: null, is_owner: 0, pinned: false, votes: 0, voted: false },
    { id: 'c3', nickname: 'Carol', body: 'newest', created_at: 500, parent_id: null, is_owner: 0, pinned: false, votes: 0, voted: false },
  ];

  it('default sort is newest-first', async () => {
    const { dom } = makeDom(
      `<div id="host" data-staticlayer data-endpoint="https://comments.example.com" data-article-path="/blog/x" data-time-gate-ms="0"></div>`,
      base as MockComment[],
    );
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;
    expect(names(host, '.sl-nick')).toEqual(['Carol', 'Bob', 'Alice']);
  });

  it('data-comments-sort="oldest" reverses the order and the selector is shown', async () => {
    const { dom } = makeDom(
      `<div id="host" data-staticlayer data-endpoint="https://comments.example.com" data-article-path="/blog/x" data-time-gate-ms="0" data-comments-sort="oldest"></div>`,
      base as MockComment[],
    );
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;
    expect(names(host, '.sl-nick')).toEqual(['Alice', 'Bob', 'Carol']);
    expect((host.querySelector('.sl-sort') as HTMLSelectElement).value).toBe('oldest');
  });

  it('data-comments-sort="best" orders by votes and keeps pinned on top', async () => {
    const comments: MockComment[] = [
      { id: 'c1', nickname: 'Alice', body: 'a', created_at: 100, parent_id: null, is_owner: 0, pinned: false, votes: 1, voted: false },
      { id: 'c2', nickname: 'Bob', body: 'b', created_at: 200, parent_id: null, is_owner: 0, pinned: true, votes: 0, voted: false },
      { id: 'c3', nickname: 'Carol', body: 'c', created_at: 300, parent_id: null, is_owner: 0, pinned: false, votes: 5, voted: false },
    ];
    const { dom } = makeDom(
      `<div id="host" data-staticlayer data-endpoint="https://comments.example.com" data-article-path="/blog/x" data-time-gate-ms="0" data-comments-sort="best"></div>`,
      comments,
    );
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;
    // Pinned first, then by votes desc. `.sl-nick` may embed the pin badge,
    // so read the first text node only.
    const order = Array.from(host.querySelectorAll('.sl-nick'))
      .map((n) => (n.firstChild?.textContent ?? '').trim());
    expect(order).toEqual(['Bob', 'Carol', 'Alice']);
    expect(host.querySelector('.sl-pin-badge')?.textContent).toContain('Pinned');
  });

  it('renders relative time and "Read more" for long comments', async () => {
    const comments: MockComment[] = [
      { id: 'c1', nickname: 'Alice', body: LONG_BODY, created_at: Math.floor(Date.now() / 1000) - 120, parent_id: null, is_owner: 0, pinned: false, votes: 0, voted: false },
    ];
    const { dom } = makeDom(
      `<div id="host" data-staticlayer data-endpoint="https://comments.example.com" data-article-path="/blog/x" data-time-gate-ms="0"></div>`,
      comments,
    );
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;
    expect(host.querySelector('.sl-time')?.textContent).toMatch(/min ago|h ago/);
    const moreBtn = host.querySelector('.sl-more-btn') as HTMLButtonElement;
    expect(moreBtn).not.toBeNull();
    expect(moreBtn.textContent).toBe('Read more');
    moreBtn.click();
    expect(moreBtn.textContent).toBe('Show less');
  });
});

describe('widget comments v2 — like and report', () => {
  it('likes a comment with real PoW and reflects the new count', async () => {
    const comments: MockComment[] = [
      { id: 'c1', nickname: 'Alice', body: 'hello', created_at: 100, parent_id: null, is_owner: 0, pinned: false, votes: 3, voted: false },
    ];
    const { dom, posted } = makeDom(
      `<div id="host" data-staticlayer data-endpoint="https://comments.example.com" data-article-path="/blog/x" data-time-gate-ms="0"></div>`,
      comments,
    );
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;
    const voteBtn = host.querySelector('.sl-vote-btn') as HTMLButtonElement;
    expect(voteBtn.textContent).toBe('▲ 3');
    voteBtn.click();
    await flushAsync();

    expect(posted.length).toBe(1);
    expect(posted[0].url).toContain('/api/comments/vote');
    expect(posted[0].body.commentId).toBe('c1');
    expect(voteBtn.textContent).toBe('✓ 4');
    expect(voteBtn.classList.contains('liked')).toBe(true);
  });

  it('reports a comment with real PoW and shows the confirmation', async () => {
    const comments: MockComment[] = [
      { id: 'c1', nickname: 'Alice', body: 'hello', created_at: 100, parent_id: null, is_owner: 0, pinned: false, votes: 0, voted: false },
    ];
    const { dom, posted } = makeDom(
      `<div id="host" data-staticlayer data-endpoint="https://comments.example.com" data-article-path="/blog/x" data-time-gate-ms="0"></div>`,
      comments,
    );
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;
    const flagBtn = host.querySelector('.sl-flag-btn') as HTMLButtonElement;
    flagBtn.click();
    await flushAsync();

    expect(posted.length).toBe(1);
    expect(posted[0].url).toContain('/api/comments/flag');
    expect(posted[0].body.commentId).toBe('c1');
    expect(flagBtn.textContent).toBe('Thanks — report sent');
    expect(flagBtn.classList.contains('done')).toBe(true);
  });
});
