# StaticLayer — Examples

Minimal, honest reference implementations for embedding the StaticLayer widget.
Every example is just the standard embed pattern in that framework's markup —
there is no duplicated security logic on the client.

> **Important:** replace `https://comments.example.com` with your deployed
> Worker URL, and make sure that URL is in the Worker's `ALLOWED_ORIGINS` var
> (CORS) when your site and the Worker are on different origins.

| Framework | Folder | Notes |
| --- | --- | --- |
| Vanilla HTML | [`vanilla/`](vanilla/) | Plain single page, works anywhere |
| Astro | [`astro/`](astro/) | Layout snippet (Astro islands optional) |
| Hugo | [`hugo/`](hugo/) | `single.html` partial |
| Jekyll | [`jekyll/`](jekyll/) | `_includes/comments.html` |
| Next.js (static export) | [`next/`](next/) | Client component, `output: 'export'` |

## Common embed

```html
<div data-staticlayer
     data-api="https://comments.example.com"
     data-article-id="/blog/my-post"></div>
<script src="https://comments.example.com/widget.js" defer></script>
```

- `data-api` (alias of `data-endpoint`) — your Worker base URL.
- `data-article-id` (alias of `data-article-path`) — the thread key; defaults to
  `window.location.pathname` when omitted. Each unique ID = one moderated thread.
- `data-host-context` (optional) — defaults to `location.hostname`.

### Programmatic API (optional)

```js
const host = document.getElementById('comments');
window.StaticLayer.mount(host, {
  endpoint: 'https://comments.example.com',
  articlePath: '/blog/my-post',
});
// later: window.StaticLayer.unmount(host);
```

### Modes — comments, reactions, or both (fully separable)

```html
<!-- comments only -->
<div data-staticlayer data-api="https://comments.example.com"></div>

<!-- comments + reactions -->
<div data-staticlayer data-api="https://comments.example.com"
     data-reactions="👍,❤️,🎉"></div>

<!-- reactions only (standalone, place anywhere) -->
<div data-staticlayer data-api="https://comments.example.com"
     data-reactions="👍,❤️,🎉" data-reactions-only></div>
```

Each host element is independent, so you can put reactions under the headline
and comments at the end of the article with one `widget.js`.

## Running the examples

None of these need a build step against the widget itself. Open the vanilla
`index.html` (served over HTTP, not `file://`) after you have a Worker deployed.
