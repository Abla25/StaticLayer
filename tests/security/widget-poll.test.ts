/**
 * Widget POLLS v2 (Round 21.20):
 *   - total votes chip in the heading
 *   - ranked results (#1, #2, …) + leader highlight + "Leads by N votes"
 *   - multi-select UI (checkbox-style toggles + "Vote (N)") sending ONE payload
 *     with an `options` array (single PoW), and "Change your votes" (revoke)
 *
 * The FakeWorker mines REAL nonces with the protocol (single or multi schema),
 * so the full pipeline (widget → worker → POST) is exercised.
 */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  base64UrlToBytes,
  minePollNonce,
  minePollNonceMulti,
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

interface PollState {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  singleVote: boolean;
  status: string;
  counts: Record<string, number>;
  total: number;
  voted: boolean;
}

function makeDom(initial: Partial<PollState> = {}, pollId = 'poll-1') {
  const poll: PollState = {
    id: pollId,
    question: 'Best option?',
    options: ['A', 'B', 'C'],
    multi: false,
    singleVote: false,
    status: 'open',
    counts: {},
    total: 0,
    voted: false,
    ...initial,
  };
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <div id="host" data-staticlayer
            data-endpoint="https://comments.example.com"
            data-article-path="/blog/x"
            data-poll-id="${pollId}"
            data-time-gate-ms="0"></div>
     </body></html>`,
    { url: 'https://site.example.com/blog/x', runScripts: 'outside-only', pretendToBeVisual: true },
  );
  const { window } = dom;

  const postedVotes: Array<Record<string, unknown>> = [];
  const revoked: Array<Record<string, unknown>> = [];

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://comments.example.com/api/polls?') || url.startsWith('https://comments.example.com/api/polls?id=')) {
      return { ok: true, status: 200, json: async () => ({ polls: [poll] }) } as Response;
    }
    if (url.startsWith('https://comments.example.com/api/polls/challenge')) {
      return { ok: true, status: 200, json: async () => CHALLENGE } as Response;
    }
    if (url === 'https://comments.example.com/api/polls/vote' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      postedVotes.push(body);
      const opts = Array.isArray(body.options) ? (body.options as string[]) : [body.option as string];
      opts.forEach((o) => { poll.counts[o] = (poll.counts[o] || 0) + 1; });
      poll.total = Object.values(poll.counts).reduce((a, b) => a + b, 0);
      // REALISTIC server shape: `voted` is TOP-LEVEL, the poll object itself
      // carries NO voted flag. The widget must mirror it to render results.
      const respPoll = JSON.parse(JSON.stringify(poll)) as PollState;
      delete respPoll.voted;
      return { ok: true, status: 200, json: async () => ({ ok: true, poll: respPoll, voted: true, voterToken: 'tok.abc' }) } as Response;
    }
    if (url === 'https://comments.example.com/api/polls/revoke' && init?.method === 'POST') {
      revoked.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      poll.counts = {};
      poll.total = 0;
      poll.voted = false;
      return { ok: true, status: 200, json: async () => ({ ok: true, revoked: 1, poll, voted: false }) } as Response;
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
      pollId?: string;
      option?: string;
      options?: string[];
    }): void {
      const c = data.challenge;
      const base = {
        version: PROTOCOL_VERSION,
        hostContext: c.hostContext,
        articlePath: c.articlePath,
        pollId: data.pollId as string,
        challengeId: base64UrlToBytes(c.challengeId),
      };
      const work =
        data.options && data.options.length > 1
          ? minePollNonceMulti({ ...base, options: data.options }, c.difficulty)
          : minePollNonce({ ...base, option: data.option as string }, c.difficulty);
      work.then((nonce) => {
        if (this.onmessage) {
          this.onmessage({ data: { type: 'nonce', nonce: serializeNonce(nonce) } });
        }
      });
    }
    terminate(): void {}
  } as unknown as typeof Worker;

  window.eval(WIDGET_JS);
  return { dom, postedVotes, revoked };
}

async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 40));
}

function names(host: Element, sel: string): string[] {
  return Array.from(host.querySelectorAll(sel)).map((n) => n.textContent?.trim() ?? '');
}

describe('widget polls v2 — total, ranking, leader', () => {
  it('shows the total chip and ranked results with leader gap after voting', async () => {
    const { dom } = makeDom({ counts: { A: 5, B: 3, C: 1 }, total: 9, voted: true });
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;

    expect(host.querySelector('.sl-poll-count')?.textContent).toBe('9 votes');
    expect(names(host, '.sl-poll-opt-name')).toEqual(['A', 'B', 'C']);
    expect(names(host, '.sl-poll-rank')).toEqual(['#1', '#2', '#3']);
    expect(host.querySelector('.sl-poll-lead-info')?.textContent).toBe('Leads by 2 votes');

    const first = host.querySelector('.sl-poll-option');
    expect(first?.classList.contains('sl-poll-leader')).toBe(true);
    expect(first?.querySelector('.sl-poll-opt-name')?.textContent).toBe('A');
  });

  it('sorts results by votes desc regardless of the poll option order', async () => {
    const { dom } = makeDom({ counts: { A: 1, B: 5, C: 2 }, total: 8, voted: true });
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;
    expect(names(host, '.sl-poll-opt-name')).toEqual(['B', 'C', 'A']);
    expect(host.querySelector('.sl-poll-lead-info')?.textContent).toBe('Leads by 3 votes');
  });

  it('shows no leader line on a tie for first place', async () => {
    const { dom } = makeDom({ counts: { A: 4, B: 4, C: 1 }, total: 9, voted: true });
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;
    expect(host.querySelector('.sl-poll-lead-info')).toBeNull();
    expect(host.querySelectorAll('.sl-poll-option.sl-poll-leader').length).toBe(0);
  });
});

describe('widget polls v2 — single vs multi voting', () => {
  it('single poll: clicking an option posts a single `option` after real PoW', async () => {
    const { dom, postedVotes } = makeDom({});
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;
    const btnA = Array.from(host.querySelectorAll('.sl-poll-btn')).find((b) => b.textContent === 'A') as HTMLElement;
    btnA.click();
    await flushAsync();

    expect(postedVotes.length).toBe(1);
    expect(postedVotes[0].option).toBe('A');
    expect(postedVotes[0].options).toBeUndefined();
    // After the vote the widget renders the results (ranked).
    expect(host.querySelector('.sl-poll-rank')).not.toBeNull();
  });

  it('multi poll: checkbox UI, Vote (N) enabled only with a selection, one options payload', async () => {
    const { dom, postedVotes } = makeDom({ multi: true });
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;

    const checks = host.querySelectorAll('.sl-poll-check');
    expect(checks.length).toBe(3);
    const voteBtn = host.querySelector('.sl-poll-vote-btn') as HTMLButtonElement;
    expect(voteBtn.disabled).toBe(true);
    expect(voteBtn.textContent).toBe('Vote (0)');

    // Select A then C.
    (Array.from(checks).find((b) => b.textContent === 'A') as HTMLButtonElement).click();
    (Array.from(checks).find((b) => b.textContent === 'C') as HTMLButtonElement).click();
    expect(voteBtn.disabled).toBe(false);
    expect(voteBtn.textContent).toBe('Vote (2)');

    voteBtn.click();
    await flushAsync();

    expect(postedVotes.length).toBe(1);
    expect([...(postedVotes[0].options as string[])].sort()).toEqual(['A', 'C']);
    expect(postedVotes[0].option).toBeUndefined();
    // After voting the widget lands on the ranked results (voted flag mirrored).
    expect(host.querySelector('.sl-poll-rank')).not.toBeNull();
    expect(host.querySelector('.sl-poll-status')?.textContent).toContain('voted');
  });

  it('multi + single-vote guard: shows "Change your votes" and revokes', async () => {
    const { dom, revoked } = makeDom({ multi: true, singleVote: true, counts: { A: 2, B: 1 }, total: 3, voted: true });
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;

    const changeBtn = host.querySelector('.sl-poll-vote-btn') as HTMLButtonElement;
    expect(changeBtn.textContent).toBe('Change your votes');
    changeBtn.click();
    await flushAsync();

    expect(revoked.length).toBe(1);
    expect(revoked[0].pollId).toBe('poll-1');
    // Back to the voting UI (checkbox) with 0 votes.
    expect(host.querySelector('.sl-poll-count')?.textContent).toBe('0 votes');
    expect(host.querySelectorAll('.sl-poll-check').length).toBe(3);
  });

  it('shows a "View results" link and reveals the results without voting', async () => {
    const { dom } = makeDom({ counts: { A: 5, B: 3, C: 1 }, total: 9, voted: false });
    await flushAsync();
    const host = dom.window.document.getElementById('host')!;

    // Before voting: voting buttons + the "View results" link, no ranking yet.
    const link = host.querySelector('.sl-poll-results-link') as HTMLButtonElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toBe('View results');
    expect(host.querySelector('.sl-poll-rank')).toBeNull();

    link.click();
    await flushAsync();

    // Ranked results are now visible without having voted.
    expect(names(host, '.sl-poll-rank')).toEqual(['#1', '#2', '#3']);
    expect(host.querySelector('.sl-poll-lead-info')?.textContent).toBe('Leads by 2 votes');
    expect(host.querySelector('.sl-poll-status')?.textContent).toContain('Live results');

    // Back to the voting buttons.
    const back = host.querySelector('.sl-poll-results-link') as HTMLButtonElement;
    expect(back.textContent).toBe('Vote');
    back.click();
    await flushAsync();
    expect(host.querySelector('.sl-poll-rank')).toBeNull();
  });
});
