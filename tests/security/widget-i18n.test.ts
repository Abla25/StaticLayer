/**
 * Widget localization: `data-lang` selection, navigator.language
 * auto-detection, per-key `data-text` overrides, and dictionary completeness
 * (every locale must define every key the English dictionary defines, so no
 * UI string silently falls back to English or to the raw key).
 */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WIDGET_SRC = readFileSync(
  fileURLToPath(new URL('../../packages/widget/src/widget.js', import.meta.url)),
  'utf8',
);
const WIDGET_JS = readFileSync(
  fileURLToPath(new URL('../../packages/widget/dist/widget.js', import.meta.url)),
  'utf8',
);

function makeDom(html: string, navigatorLanguage?: string) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: 'https://site.example.com/post/1',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  if (navigatorLanguage !== undefined) {
    Object.defineProperty(window.navigator, 'language', { value: navigatorLanguage });
  }
  window.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ comments: [] }),
  }) as unknown as typeof fetch;
  window.eval(WIDGET_JS);
  return dom;
}

async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

function uiText(dom: JSDOM) {
  const host = dom.window.document.getElementById('host')!;
  return {
    title: host.querySelector('.sl-heading h3')?.textContent,
    submit: host.querySelector('.sl-submit')?.textContent,
  };
}

const HOST = (attrs = '') =>
  `<div id="host" data-staticlayer data-endpoint="https://comments.example.com" ${attrs}></div>`;

describe('widget localization', () => {
  it('renders German copy with data-lang="de"', async () => {
    const dom = makeDom(HOST('data-lang="de"'), 'en-US');
    await flushAsync();
    expect(uiText(dom)).toEqual({ title: 'Kommentare', submit: 'Kommentar senden' });
  });

  it('auto-detects German from a regional navigator.language (de-AT)', async () => {
    const dom = makeDom(HOST(), 'de-AT');
    await flushAsync();
    expect(uiText(dom).title).toBe('Kommentare');
  });

  it('still auto-detects Italian', async () => {
    const dom = makeDom(HOST(), 'it-IT');
    await flushAsync();
    expect(uiText(dom).title).toBe('Commenti');
  });

  it('falls back to English for unsupported languages', async () => {
    const dom = makeDom(HOST(), 'fr-FR');
    await flushAsync();
    expect(uiText(dom).title).toBe('Comments');
  });

  it('lets data-text overrides win over the German dictionary', async () => {
    const dom = makeDom(HOST(`data-lang="de" data-text='{"title":"Diskussion"}'`), 'de-DE');
    await flushAsync();
    expect(uiText(dom)).toEqual({ title: 'Diskussion', submit: 'Kommentar senden' });
  });
});

describe('widget dictionaries', () => {
  // Extract `<lang>: { key: '…', … }` blocks from the widget source.
  function dictKeys(lang: string): string[] {
    const match = WIDGET_SRC.match(new RegExp(`\\n    ${lang}: \\{([\\s\\S]*?)\\n    \\}`));
    expect(match, `dictionary "${lang}" not found`).not.toBeNull();
    return [...match![1].matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).sort();
  }

  it.each(['it', 'de'])('"%s" defines exactly the English keys', (lang) => {
    expect(dictKeys(lang)).toEqual(dictKeys('en'));
  });
});
