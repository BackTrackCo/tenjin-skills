import { graph } from './graph.mjs';

// X, LinkedIn and Reddit never get a fetch, a script or a browser action from this skill. Hacker News is read only through its
// search API host (see hn.mjs); its item page is only shown to the person and opened by them.
export const HN_SITE = 'news.ycombinator.com';

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
}
const under = (h, d) => h === d || h.endsWith(`.${d}`);
export function isNeverAutomated(url) {
  const h = hostOf(url);
  return Boolean(h && graph().neverHosts.some((b) => under(h, b)));
}
// x | reddit | linkedin | hn | null
export function platformOf(url) {
  const h = hostOf(url);
  if (!h) return null;
  if (under(h, 'x.com') || under(h, 'twitter.com')) return 'x';
  if (under(h, 'reddit.com') || under(h, 'redd.it')) return 'reddit';
  if (under(h, 'linkedin.com')) return 'linkedin';
  if (h === HN_SITE) return 'hn';
  return null;
}
export const tweetIdOf = (url) => (/\/status(?:es)?\/(\d{5,25})/.exec(String(url)) || [])[1] || null;
export const handleOfXUrl = (url) => {
  const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(String(url));
  return m && !['i', 'intent', 'home', 'search', 'hashtag'].includes(m[1].toLowerCase()) ? m[1] : null;
};
export const linkedinSlugOf = (url) => (/linkedin\.com\/in\/([^/?#\s]+)/i.exec(String(url)) || [])[1] || null;
