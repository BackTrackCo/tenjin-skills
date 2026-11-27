import { str, linksOf, listOf, isoOf } from './posts-shared.mjs';

// The Reddit post search, two sellers. Both are built from their catalog entries, not from a recorded paid answer, so each adapter
// reads the usual places of a list and refuses an answer with none. A post is data: only a link in it leads anywhere. Reddit is
// never fetched or opened by code; the person opens a thread with G open.
export const KIND = 'reddit_posts';
export const RECORDED = false;

const absolute = (u) => (/^https?:\/\//i.test(str(u)) ? str(u) : str(u).startsWith('/') ? `https://www.reddit.com${str(u)}` : '');

function toPost(p) {
  const url = absolute(p.url || p.permalink || p.link);
  const text = [str(p.title), str(p.selftext || p.text || p.body || p.content)].filter(Boolean).join('\n');
  if (!url || !text) throw new Error('a post has no url or text');
  return { url, author: str(p.author || p.authorUsername || p.username), postedAt: isoOf(p.created_utc || p.createdUtc || p.created_at || p.created), text: text.slice(0, 1000), links: linksOf(text), source: 'reddit' };
}

// The first seller: the same service that reads X. Input: `query`, `sort`.
export const glim = {
  HOST: 'glim.sh',
  KIND,
  RECORDED,
  mapper: ({ query }) => {
    if (!str(query)) throw new Error('no phrase for the Reddit search');
    return { query: str(query), sort: 'new' };
  },
  adapter: (res) => {
    const list = listOf(res, 'posts', 'results', 'data.posts', 'data.children', 'items');
    if (!list) throw new Error('the result has no posts list');
    return { posts: list.map((p) => toPost(p && p.data ? p.data : p)) };
  },
};

// The second seller: the service that leads several reads. Input: `query`. Result: {output: {found, data: {items: [...], nextCursor}}}.
export const anyapi = {
  HOST: 'api.getanyapi.com',
  KIND,
  RECORDED,
  mapper: ({ query }) => {
    if (!str(query)) throw new Error('no phrase for the Reddit search');
    return { query: str(query), sort: 'new' };
  },
  adapter: (res) => {
    const out = (res && res.output) || res || {};
    if (out.found === false) return { posts: [] };
    const list = listOf(out, 'data.items', 'data.posts', 'items');
    if (!list) throw new Error('the result has no items list');
    return { posts: list.map(toPost), more: Boolean(out.data && out.data.nextCursor) };
  },
};
