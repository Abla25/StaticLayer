# StaticLayer × Hugo

Add the widget to your single-post template (or a partial you include there).

## Setup

`layouts/partials/staticlayer.html`:

```html
{{ $path := default .RelPermalink .Params.staticlayer_article_id }}
<div data-staticlayer
     data-api="https://comments.example.com"
     data-article-id="{{ $path }}"></div>
<script src="https://comments.example.com/widget.js" defer></script>
```

Include it at the end of `layouts/_default/single.html` (or your post layout):

```html
{{ partial "staticlayer.html" . }}
```

Per post, you can override the thread key in front matter:

```yaml
---
title: Hello world
staticlayer_article_id: /custom/thread-key
---
```

Otherwise `.RelPermalink` gives one thread per URL. Add your site origin to the
Worker's `ALLOWED_ORIGINS` (CORS) if site and Worker differ.
