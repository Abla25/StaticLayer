<script setup>
// StaticLayer — Vue component (works in Vue 3 / Nuxt).
// Usage: <Comments endpoint="https://comments.example.com" reactions="👍,❤️,🎉" />
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
  accent2: { type: String, default: '' },
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
  if (p.accent2) a['data-accent-2'] = p.accent2;
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
