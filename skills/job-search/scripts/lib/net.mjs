import { isNeverAutomated } from './platforms.mjs';
// The only network door for the scripts. Hosts outside this list are refused.
export const ALLOWED_HOSTS = [
  'boards-api.greenhouse.io',
  'boards-api.eu.greenhouse.io', // not verified
  'api.lever.co',
  'api.eu.lever.co', // not verified
  'api.ashbyhq.com',
  'api.github.com',
  'hacker-news.firebaseio.com', // the official Hacker News API, never news.ycombinator.com
];

export function assertAllowed(url) {
  const host = new URL(url).hostname;
  if (!ALLOWED_HOSTS.includes(host)) throw new Error(`host not allowed: ${host}`);
}

export async function guardedFetch(url, opts = {}, fetchImpl = globalThis.fetch) {
  assertAllowed(url);
  const res = await fetchImpl(url, {
    ...opts,
    headers: { 'user-agent': 'tenjin-skills-job-search', accept: 'application/json', ...(opts.headers || {}) },
  });
  return res;
}

// The employer's own careers page, read for free. It is any public https page, so it is checked, not trusted:
// https only, no address literal or local name, never a never-automated platform, at most 1 MB of text.
export async function fetchPublicPage(url, fetchImpl = globalThis.fetch) {
  const u = new URL(url);
  const h = u.hostname.toLowerCase();
  if (u.protocol !== 'https:') throw new Error('only https pages are read');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) throw new Error('not a public host');
  if (isNeverAutomated(url)) throw new Error('a platform that bans automated access is never fetched');
  const res = await fetchImpl(url, { headers: { 'user-agent': 'tenjin-skills-job-search', accept: 'text/html' } });
  const text = (await res.text()).slice(0, 1_000_000);
  return { status: res.status, finalUrl: res.url || url, text };
}
