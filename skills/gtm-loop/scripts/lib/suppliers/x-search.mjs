import { str, linksOf, isoOfUnix } from './posts-shared.mjs';

// The X search shape of the service that leads several reads (built from its catalog entry and the shape of its recorded body, no
// paid call). Input: `query` (keywords plus operators such as since:), `queryType` Latest|Top. Result:
// {output: {found, data: {items: [{text, url, authorUsername, createdUtc, ...counts}], nextCursor}}}. It has no expanded-links
// field, so the links come from the post text. One page per need per round. Picked by host like every adapter.
export const HOST = 'api.getanyapi.com';
export const KIND = 'x_posts';
export const RECORDED = false;

export function mapper({ query, since }) {
  if (!str(query)) throw new Error('no query for the X search');
  return { query: `${str(query)}${since ? ` since:${since}` : ''}`, queryType: 'Latest' };
}

export function adapter(res) {
  const out = (res && res.output) || res || {};
  if (out.found === false) return { posts: [] };
  const list = out.data && out.data.items;
  if (!Array.isArray(list)) throw new Error('the result has no items list');
  const posts = list.map((t) => {
    if (!str(t && t.url) || !str(t.text)) throw new Error('a tweet has no url or text');
    return { url: t.url, author: str(t.authorUsername), postedAt: isoOfUnix(t.createdUtc), text: t.text.slice(0, 1000), links: linksOf(t.text), source: 'x' };
  });
  return { posts, more: Boolean(out.data.nextCursor) };
}
