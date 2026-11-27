import { str, linksOf, isoOfUnix } from './posts-shared.mjs';

// The public posts of one key person, found by the profile link the contacts flow stored. One page per need per round. Input: `url`
// (https://www.linkedin.com/in/<handle>). Result: {output: {found, data: {items: [{id, url, text, createdUtc, author, engagement,
// repostUrl, repostText, articleUrl, videoUrl}], nextCursor}}}. Built from the catalog entry and its recorded response (no paid call).
// A post and a repost are data; only a link in them leads anywhere. Engagement and the author object are not kept.
export const TOOL = 'anyapi-linkedin-author-posts';
export const HOST = 'api.getanyapi.com';
export const RECORDED = false;

export function mapper({ url }) {
  if (!/^https:\/\/(?:[a-zA-Z0-9-]+\.)?linkedin\.com\/in\/[^/?#\s]+/.test(str(url))) throw new Error('not a LinkedIn profile link');
  return { url };
}

export function adapter(res) {
  const out = (res && res.output) || res || {};
  if (out.found === false) return { posts: [], more: false };
  const list = out.data && out.data.items;
  if (!Array.isArray(list)) throw new Error('the result has no items list');
  const posts = list.map((p) => {
    if (!str(p && p.url)) throw new Error('a post has no url');
    const text = [str(p.text), str(p.repostText)].filter(Boolean).join('\n');
    return { url: p.url, author: '', postedAt: isoOfUnix(p.createdUtc), text: text.slice(0, 1000), links: linksOf(text, p.articleUrl), source: 'linkedin' };
  });
  return { posts, more: Boolean(out.data.nextCursor) };
}
