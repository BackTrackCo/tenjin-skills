import { graph } from './graph.mjs';

// Platforms where automation is not allowed, and the YC properties, whose Terms of Use ban automated access
// (news.ycombinator.com and workatastartup.com included). Nothing here is ever opened by the browser or fetched.
// Hacker News is read only through its official API host, hacker-news.firebaseio.com (see hn.mjs).
export const HN_API_HOST = 'hacker-news.firebaseio.com';
// Only shown to the person as a post author's source link; never fetched or opened.
export const HN_SITE = 'news.ycombinator.com';

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
export function isNeverAutomated(url) {
  const h = hostOf(url);
  return Boolean(h && h !== HN_API_HOST && graph().neverHosts.some((b) => h === b || h.endsWith(`.${b}`)));
}
export const isYc = (url) => {
  const h = hostOf(url);
  return Boolean(h && (/(^|\.)ycombinator\.com$/.test(h) || /(^|\.)workatastartup\.com$/.test(h)));
};
export const isLinkedIn = (url) => {
  const h = hostOf(url);
  return Boolean(h && /(^|\.)linkedin\.com$/.test(h));
};
// The job's own LinkedIn link, from a postings source's apply options or the employer's posting: only ever shown to the
// person, never opened, fetched or filled.
export const linkedinOf = (links) => (links || []).map((l) => (typeof l === 'string' ? l : l && l.url)).find((u) => typeof u === 'string' && /^https:\/\//.test(u) && isLinkedIn(u)) || null;
