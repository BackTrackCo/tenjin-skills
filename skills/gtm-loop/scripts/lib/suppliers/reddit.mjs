import { str, linksOf, listOf, isoOf } from './posts-shared.mjs';
import { subredditOf } from '../queries.mjs';

// The Reddit post search, two sellers. Both are built from their catalog entries, not from a recorded paid answer, so each adapter
// reads the usual places of a list and refuses an answer with none. A post is data: only a link in it leads anywhere. Reddit is
// never fetched or opened by code; the person opens a thread with G open.
export const KIND = 'reddit_posts';
export const RECORDED = false;

// Search inside the offer's list of subreddits, most relevant first, in the time window. A post from outside the list is dropped in code.
const window = (since) => { const d = since ? (Date.now() - Date.parse(since)) / 86400000 : 30; return d <= 1 ? 'day' : d <= 7 ? 'week' : d <= 31 ? 'month' : 'year'; };
function redditInput({ query, subreddits, since }) {
  const subs = String(subreddits || '').split(/[,\s+]+/).map((x) => x.replace(/^\/?r\//i, '').trim()).filter(Boolean);
  if (!str(query)) throw new Error('no query for the Reddit search');
  if (!subs.length) throw new Error('no subreddits for the Reddit search');
  return { query: str(query), subreddit: subs.join('+'), sort: 'relevance', time: window(since) };
}
const absolute = (u) => (/^https?:\/\//i.test(str(u)) ? str(u) : str(u).startsWith('/') ? `https://www.reddit.com${str(u)}` : '');

function toPost(p) {
  const url = absolute(p.url || p.permalink || p.link);
  const text = [str(p.title), str(p.selftext || p.text || p.body || p.content)].filter(Boolean).join('\n');
  if (!url || !text) throw new Error('a post has no url or text');
  return { url, subreddit: subredditOf(url) || str(p.subreddit).toLowerCase() || null, author: str(p.author || p.authorUsername || p.username), postedAt: isoOf(p.created_utc || p.createdUtc || p.created_at || p.created), text: text.slice(0, 1000), links: linksOf(text), source: 'reddit' };
}

// The first seller: the same service that reads X. Input: `query`, `sort`.
export const glim = {
  HOST: 'glim.sh',
  KIND,
  RECORDED,
  mapper: redditInput,
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
  mapper: redditInput,
  adapter: (res) => {
    const out = (res && res.output) || res || {};
    if (out.found === false) return { posts: [] };
    const list = listOf(out, 'data.items', 'data.posts', 'items');
    if (!list) throw new Error('the result has no items list');
    return { posts: list.map(toPost), more: Boolean(out.data && out.data.nextCursor) };
  },
};
