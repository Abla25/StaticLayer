// StaticLayer — React component (works in Next.js, Vite, Astro islands…).
// Usage:
//   <Comments endpoint="https://comments.example.com" reactions="👍,❤️,🎉" sort="best" />
type CommentsProps = {
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
  accent2?: string;
  radius?: string;
  maxWidth?: string;
};

export function Comments(props: CommentsProps) {
  const { endpoint, reactionsOnly, pollId, ...rest } = props;
  const attrs: Record<string, string> = {
    'data-staticlayer': '',
    'data-endpoint': endpoint,
  };
  if (rest.articlePath) attrs['data-article-path'] = rest.articlePath;
  if (rest.reactions) attrs['data-reactions'] = rest.reactions;
  if (reactionsOnly) attrs['data-reactions-only'] = '';
  if (reactionsOnly && rest.reactionsPosition) attrs['data-reactions-position'] = rest.reactionsPosition;
  if (pollId) {
    attrs['data-poll-id'] = pollId;
    if (rest.pollStyle) attrs['data-poll-style'] = rest.pollStyle;
    if (rest.pollResults) attrs['data-poll-results'] = rest.pollResults;
  }
  if (rest.sort) attrs['data-comments-sort'] = rest.sort;
  if (rest.lang && rest.lang !== 'auto') attrs['data-lang'] = rest.lang;
  if (rest.theme && rest.theme !== 'auto') attrs['data-theme'] = rest.theme;
  if (rest.accent) attrs['data-accent'] = rest.accent;
  if (rest.accent2) attrs['data-accent-2'] = rest.accent2;
  if (rest.radius) attrs['data-radius'] = rest.radius;
  if (rest.maxWidth) attrs['data-max-width'] = rest.maxWidth;

  return (
    <>
      <div {...attrs} />
      <script src={`${endpoint}/widget.js`} defer />
    </>
  );
}
