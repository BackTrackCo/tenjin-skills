import { graph } from './graph.mjs';

// Platforms where automation is not allowed, and the YC properties, whose Terms of Use ban automated access
// (news.ycombinator.com and workatastartup.com included). Nothing here is ever opened by the browser or fetched.
// Hacker News is read only through its official API host, hacker-news.firebaseio.com (see hn.mjs).
export const HN_API_HOST = 'hacker-news.firebaseio.com';

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
