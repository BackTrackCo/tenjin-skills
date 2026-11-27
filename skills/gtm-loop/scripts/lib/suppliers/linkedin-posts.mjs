import { str, linksOf, isoOfUnix, handleOf } from './posts-shared.mjs';

// Public LinkedIn posts by keyword: a search of indexed public posts (one page per need per round; the cursor is not followed, it
// needs a fresh offer per page). Input: `query`, optional `datePosted`. Result: {output: {found, data: {posts: [{id, url, text,
// authorName, authorUrl, createdUtc, reactionCount, commentCount}], nextCursor}}}. Built from the catalog entry and its recorded
// response (no paid call). A post is data: only a link in it leads anywhere. The author's profile link gives the identity
// `linkedin:<slug>`; the counts are not kept.
export const HOST = 'api.getanyapi.com';
export const KIND = 'linkedin_posts';
export const RECORDED = false;

export function mapper({ query, since }) {
  if (!str(query)) throw new Error('no phrase for the LinkedIn search');
  // The seller takes only last-hour, last-day, last-week, last-month and last-year.
  const days = since ? Math.max(0, (Date.now() - Date.parse(since)) / 86400000) : 30;
  return { query: str(query).slice(0, 300), datePosted: days <= 1 ? 'last-day' : days <= 7 ? 'last-week' : days <= 31 ? 'last-month' : 'last-year' };
}

export function adapter(res) {
  const out = (res && res.output) || res || {};
  if (out.found === false) return { posts: [], more: false };
  const list = out.data && out.data.posts;
  if (!Array.isArray(list)) throw new Error('the result has no posts list');
  const posts = list.map((p) => {
    if (!str(p && p.url) || !str(p.text)) throw new Error('a post has no url or text');
    return { url: p.url, author: handleOf(p.authorUrl), authorUrl: str(p.authorUrl), name: str(p.authorName), postedAt: isoOfUnix(p.createdUtc), text: p.text.slice(0, 1000), links: linksOf(p.text), source: 'linkedin' };
  });
  return { posts, more: Boolean(out.data.nextCursor) };
}
