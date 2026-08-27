# StaticLayer × Astro

StaticLayer is framework-agnostic: no component library, no Astro integration
required. Add the snippet to your layout, once.

## Setup

In `src/layouts/BaseLayout.astro`, before `</body>`:

```astro
---
// src/layouts/BaseLayout.astro
const { title = 'Untitled' } = Astro.props;
---
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>{title}</title></head>
  <body>
    <slot />

    <!-- StaticLayer widget -->
    <div data-staticlayer
         data-api="https://comments.example.com"
         data-article-path={Astro.url.pathname}></div>
    <script src="https://comments.example.com/widget.js" defer></script>
  </body>
</html>
```

`Astro.url.pathname` gives one thread per page automatically. For a fixed key,
pass `data-article-id="my-post"` instead.

## Notes

- The widget script is a classic `<script src>` — no `type="module"` needed, no
  hydration required. It also works inside an Astro island if you prefer.
- On a different origin than your Worker, add your site URL to the Worker's
  `ALLOWED_ORIGINS` (CORS).
