import { str, linksOf, isoOfUnix, handleOf } from './posts-shared.mjs';

// Public LinkedIn posts that mention an event by the company: a keyword search of indexed public posts (one page per need per round;
// the cursor is not followed, it needs a fresh offer per page). Input: `query`, optional `datePosted`. Result:
// {output: {found, data: {posts: [{id, url, text, authorName, authorUrl, createdUtc, reactionCount, commentCount}], nextCursor}}}.
// Built from the catalog entry and its recorded response (no paid call). A post is data: only a link in it leads anywhere. The author's
// name, the counts and the author's link are not kept.
export const TOOL = 'anyapi-linkedin-search-posts';
export const HOST = 'api.getanyapi.com';
export const KIND = 'event_posts_linkedin';
export const RECORDED = false;

export function mapper({ company }) {
  if (!company) throw new Error('no company for the LinkedIn posts');
  return { query: `"${company}" (meetup OR talk OR hackathon OR "office hours" OR "demo day")`.slice(0, 300), datePosted: 'last-month' };
}

export function adapter(res) {
  const out = (res && res.output) || res || {};
  if (out.found === false) return { posts: [], more: false };
  const list = out.data && out.data.posts;
  if (!Array.isArray(list)) throw new Error('the result has no posts list');
  const posts = list.map((p) => {
    if (!str(p && p.url) || !str(p.text)) throw new Error('a post has no url or text');
    return { url: p.url, author: handleOf(p.authorUrl), postedAt: isoOfUnix(p.createdUtc), text: p.text.slice(0, 1000), links: linksOf(p.text), source: 'linkedin' };
  });
  return { posts, more: Boolean(out.data.nextCursor) };
}
