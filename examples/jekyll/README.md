# StaticLayer × Jekyll

Add the widget to your post layout (or a Liquid include).

## Setup

`_includes/comments.html`:

```html
{% assign article_id = page.staticlayer_article_id | default: page.url %}
<div data-staticlayer
     data-api="https://comments.example.com"
     data-article-id="{{ article_id }}"></div>
<script src="https://comments.example.com/widget.js" defer></script>
```

Include it in `_layouts/post.html`:

```html
---
layout: default
---
<article>{{ content }}</article>
{% include comments.html %}
```

To pin a stable thread key (useful across URL changes), set it in front matter:

```yaml
---
title: Hello world
staticlayer_article_id: /blog/hello-world
---
```

`page.url` is used by default (one thread per URL). Add your site origin to the
Worker's `ALLOWED_ORIGINS` (CORS) if site and Worker differ.
