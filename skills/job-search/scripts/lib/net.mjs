// The only network door for the scripts. Hosts outside this list are refused.
export const ALLOWED_HOSTS = [
  'boards-api.greenhouse.io',
  'boards-api.eu.greenhouse.io', // not verified
  'api.lever.co',
  'api.eu.lever.co', // not verified
  'api.ashbyhq.com',
  'api.github.com',
  'hacker-news.firebaseio.com', // the official Hacker News API, never news.ycombinator.com
  'hn.algolia.com', // HN Search API by Algolia, the official search for the hiring thread
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
