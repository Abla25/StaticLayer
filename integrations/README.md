# StaticLayer — framework integrations

Drop-in components for the most common static-site frameworks. Every template
renders the exact same widget: a `<div data-staticlayer>` plus the script tag,
with the attributes you configure. Nothing else — no tracking, no extra
dependencies, no server-side code.

**Ready-made component files** (copy them into your project):
`astro/Comment.astro`, `react/Comment.tsx`, `vue/Comment.vue`,
`hugo/comments.html`, `jekyll/comments.html`. The snippets below are the same
code inline for quick reference.

| Framework | File | Usage |
|---|---|---|
| [Astro](#astro) | `astro/Comment.astro` | `<Comment endpoint="https://comments.example.com" />` |
| [React / Next.js](#react--nextjs) | `react/Comment.tsx` | `<Comments endpoint="https://comments.example.com" />` |
| [Vue / Nuxt](#vue--nuxt) | `vue/Comment.vue` | `<Comments endpoint="https://comments.example.com" />` |
| [Hugo](#hugo) | `hugo/comments.html` | `{{ partial "comments.html" (dict "endpoint" "https://comments.example.com") }}` |
| [Jekyll](#jekyll) | `jekyll/comments.html` | `{% include comments.html endpoint="https://comments.example.com" %}` |

## Shared options

All templates accept the same options (see the main widget docs in
`docs/` and on the site):

- `endpoint` — your Worker URL (required, e.g. `https://comments.example.com`)
- `articlePath` — optional; default = the page's own URL
- `reactions` — optional emoji set, e.g. `👍,❤️,🎉` (renders the reaction bar)
- `reactionsOnly` — optional; renders a standalone reaction bar
- `pollId` — optional; renders a standalone poll instead of comments
- `pollStyle` / `pollResults` — poll display options
- `sort` — `newest | oldest | best` (default `newest`)
- `reactionsPosition` — `top | bottom` (default `bottom`)
- `lang` — `en | it | auto` (default `auto`)
- `theme` — `auto | light | dark`
- `accent` / `accent2` — brand colors
- `radius` — corner radius in px (default 14)
- `maxWidth` — container width in px (default 640)

## Astro

```astro
---
// integrations/astro/Comment.astro
interface Props {
  endpoint: string;
  articlePath?: string;
  reactions?: string;
  pollId?: string;
  pollStyle?: string;
  pollResults?: string;
  sort?: string;
  reactionsPosition?: string;
  lang?: string;
  theme?: string;
  accent?: string;
  radius?: string;
  maxWidth?: string;
}
const { endpoint, articlePath, reactions, pollId, pollStyle, pollResults, sort, reactionsPosition, lang, theme, accent, radius, maxWidth } = Astro.props;
const attrs = [
  'data-staticlayer',
  `data-endpoint="${endpoint}"`,
  articlePath && `data-article-path="${articlePath}"`,
  reactions && `data-reactions="${reactions}"`,
  pollId && `data-poll-id="${pollId}"`,
  pollStyle && `data-poll-style="${pollStyle}"`,
  pollResults && `data-poll-results="${pollResults}"`,
  sort && `data-comments-sort="${sort}"`,
  reactionsPosition && `data-reactions-position="${reactionsPosition}"`,
  lang && lang !== 'auto' && `data-lang="${lang}"`,
  theme && theme !== 'auto' && `data-theme="${theme}"`,
  accent && `data-accent="${accent}"`,
  radius && `data-radius="${radius}"`,
  maxWidth && `data-max-width="${maxWidth}"`,
].filter(Boolean).join(' ');
---
<div set:html={`<div ${attrs}></div>`} />
<script src={`${endpoint}/widget.js`} defer />
```

Usage:

```astro
---
import Comment from '../components/Comment.astro';
---
<Comment endpoint="https://comments.example.com" reactions="👍,❤️,🎉" />
```

## React / Next.js

```tsx
// integrations/react/Comment.tsx
type CommentProps = {
  endpoint: string;
  articlePath?: string;
  reactions?: string;
  reactionsOnly?: boolean;
  pollId?: string;
  pollStyle?: 'bars' | 'percent' | 'counts' | 'minimal';
  pollResults?: 'after' | 'always';
  sort?: 'newest' | 'oldest' | 'best';
  reactionsPosition?: 'top' | 'bottom';
  lang?: 'en' | 'it' | 'auto';
  theme?: 'auto' | 'light' | 'dark';
  accent?: string;
  radius?: string;
  maxWidth?: string;
};

export function Comments(props: CommentProps) {
  const { endpoint, reactionsOnly, pollId, ...rest } = props;
  const attrs = {
    'data-staticlayer': '',
    'data-endpoint': endpoint,
    ...(rest.articlePath && { 'data-article-path': rest.articlePath }),
    ...(rest.reactions && { 'data-reactions': rest.reactions }),
    ...(reactionsOnly && { 'data-reactions-only': '' }),
    ...(rest.reactionsPosition && { 'data-reactions-position': rest.reactionsPosition }),
    ...(pollId && { 'data-poll-id': pollId }),
    ...(rest.pollStyle && { 'data-poll-style': rest.pollStyle }),
    ...(rest.pollResults && { 'data-poll-results': rest.pollResults }),
    ...(rest.sort && { 'data-comments-sort': rest.sort }),
    ...(rest.lang && rest.lang !== 'auto' && { 'data-lang': rest.lang }),
    ...(rest.theme && rest.theme !== 'auto' && { 'data-theme': rest.theme }),
    ...(rest.accent && { 'data-accent': rest.accent }),
    ...(rest.radius && { 'data-radius': rest.radius }),
    ...(rest.maxWidth && { 'data-max-width': rest.maxWidth }),
  };
  return (
    <>
      <div {...attrs} />
      <script src={`${endpoint}/widget.js`} defer />
    </>
  );
}
```

Usage (Next.js app router — must render client-side or as a plain script):

```tsx
import { Comments } from '@/components/Comment';

export default function Post() {
  return <Comments endpoint="https://comments.example.com" reactions="👍,❤️,🎉" sort="best" />;
}
```

## Vue / Nuxt

```vue
<!-- integrations/vue/Comment.vue -->
<script setup>
defineProps({
  endpoint: { type: String, required: true },
  articlePath: { type: String, default: '' },
  reactions: { type: String, default: '' },
  pollId: { type: String, default: '' },
  pollStyle: { type: String, default: '' },
  pollResults: { type: String, default: '' },
  sort: { type: String, default: '' },
  reactionsPosition: { type: String, default: '' },
  lang: { type: String, default: '' },
  theme: { type: String, default: '' },
  accent: { type: String, default: '' },
  radius: { type: String, default: '' },
  maxWidth: { type: String, default: '' },
});

function attrs(p) {
  const a = { 'data-staticlayer': '', 'data-endpoint': p.endpoint };
  if (p.articlePath) a['data-article-path'] = p.articlePath;
  if (p.reactions) a['data-reactions'] = p.reactions;
  if (p.pollId) a['data-poll-id'] = p.pollId;
  if (p.pollStyle) a['data-poll-style'] = p.pollStyle;
  if (p.pollResults) a['data-poll-results'] = p.pollResults;
  if (p.sort) a['data-comments-sort'] = p.sort;
  if (p.reactionsPosition) a['data-reactions-position'] = p.reactionsPosition;
  if (p.lang && p.lang !== 'auto') a['data-lang'] = p.lang;
  if (p.theme && p.theme !== 'auto') a['data-theme'] = p.theme;
  if (p.accent) a['data-accent'] = p.accent;
  if (p.radius) a['data-radius'] = p.radius;
  if (p.maxWidth) a['data-max-width'] = p.maxWidth;
  return a;
}
</script>

<template>
  <div>
    <div v-bind="attrs($props)"></div>
    <script :src="endpoint + '/widget.js'" defer />
  </div>
</template>
```

## Hugo

```html
<!-- integrations/hugo/comments.html -->
<!-- Usage: {{ partial "comments.html" (dict "endpoint" "https://comments.example.com" "reactions" "👍,❤️,🎉") }} -->
{{ $attrs := slice "data-staticlayer" }}
{{ $attrs = $attrs | append (printf "data-endpoint=\"%s\"" .endpoint) }}
{{ with .articlePath }}{{ $attrs = $attrs | append (printf "data-article-path=\"%s\"" .) }}{{ end }}
{{ with .reactions }}{{ $attrs = $attrs | append (printf "data-reactions=\"%s\"" .) }}{{ end }}
{{ with .pollId }}{{ $attrs = $attrs | append (printf "data-poll-id=\"%s\"" .) }}{{ end }}
{{ with .sort }}{{ $attrs = $attrs | append (printf "data-comments-sort=\"%s\"" .) }}{{ end }}
{{ with .reactionsPosition }}{{ $attrs = $attrs | append (printf "data-reactions-position=\"%s\"" .) }}{{ end }}
{{ with .lang }}{{ if ne . "auto" }}{{ $attrs = $attrs | append (printf "data-lang=\"%s\"" .) }}{{ end }}{{ end }}
{{ with .theme }}{{ if ne . "auto" }}{{ $attrs = $attrs | append (printf "data-theme=\"%s\"" .) }}{{ end }}{{ end }}
{{ with .accent }}{{ $attrs = $attrs | append (printf "data-accent=\"%s\"" .) }}{{ end }}
<div {{ delimit $attrs " " }}></div>
<script src="{{ .endpoint }}/widget.js" defer></script>
```

## Jekyll

```html
<!-- integrations/jekyll/comments.html -->
<!-- Usage: {% include comments.html endpoint="https://comments.example.com" reactions="👍,❤️,🎉" %} -->
{% assign attrs = "data-staticlayer" %}
{% assign attrs = attrs | append: ' data-endpoint="' | append: include.endpoint | append: '"' %}
{% if include.articlePath %}{% assign attrs = attrs | append: ' data-article-path="' | append: include.articlePath | append: '"' %}{% endif %}
{% if include.reactions %}{% assign attrs = attrs | append: ' data-reactions="' | append: include.reactions | append: '"' %}{% endif %}
{% if include.pollId %}{% assign attrs = attrs | append: ' data-poll-id="' | append: include.pollId | append: '"' %}{% endif %}
{% if include.sort %}{% assign attrs = attrs | append: ' data-comments-sort="' | append: include.sort | append: '"' %}{% endif %}
{% if include.reactionsPosition %}{% assign attrs = attrs | append: ' data-reactions-position="' | append: include.reactionsPosition | append: '"' %}{% endif %}
<div {{ attrs }}></div>
<script src="{{ include.endpoint }}/widget.js" defer></script>
```
