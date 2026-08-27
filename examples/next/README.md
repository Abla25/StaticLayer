# StaticLayer × Next.js (static export)

StaticLayer is designed for static output — no server runtime required. Use a
client component that renders the host element, then load the widget script.

## Setup

`components/Comments.tsx` (client component):

```tsx
'use client';

export default function Comments({ articleId }: { articleId?: string }) {
  return (
    <div
      data-staticlayer
      data-api={process.env.NEXT_PUBLIC_STATICLAYER_API!}
      data-article-id={articleId ?? undefined}
    />
  );
}
```

`app/layout.tsx` — load the widget script once, before `</body>`:

```tsx
import Script from 'next/script';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Script
          src={`${process.env.NEXT_PUBLIC_STATICLAYER_API}/widget.js`}
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
```

`app/posts/[slug]/page.tsx`:

```tsx
import Comments from '@/components/Comments';

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <article>
      <h1>Post</h1>
      <Comments articleId={`/posts/${slug}`} />
    </article>
  );
}
```

## Build

```bash
# .env.local
NEXT_PUBLIC_STATICLAYER_API=https://comments.example.com
```

```bash
npm run build    # with output: 'export' in next.config
```

Deploy the `out/` folder as a static site. Add your site origin to the Worker's
`ALLOWED_ORIGINS` (CORS) if site and Worker differ.
