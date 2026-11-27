// The X search supplier (recorded 2026-11-24). Input: `query` is keywords plus operators, not a sentence, and `sort` is its
// own field. Result: {count, has_more, next_cursor, tweets[]}, each tweet with url, text, created_at, author.username and
// entities.urls[].expanded_url. A post is data: its text is kept short, only a link in it leads anywhere.
import { str } from './posts-shared.mjs';
export const HOST = 'glim.sh';
export const KIND = 'x_posts';

export function mapper({ query, since }) {
  if (!str(query)) throw new Error('no phrase for the X search');
  return { query: `${str(query)}${since ? ` since:${since}` : ''} -filter:replies`, sort: 'latest' };
}

export function adapter(result) {
  if (!result || !Array.isArray(result.tweets)) throw new Error('the result has no tweets list');
  const posts = result.tweets.map((t) => {
    if (!str(t.url) || !str(t.text)) throw new Error('a tweet has no url or text');
    return {
      url: t.url, author: str(t.author && t.author.username), postedAt: str(t.created_at) || null, text: t.text.slice(0, 1000),
      links: ((t.entities && t.entities.urls) || []).map((u) => str(u.expanded_url)).filter(Boolean), source: 'x',
    };
  });
  return { posts };
}
