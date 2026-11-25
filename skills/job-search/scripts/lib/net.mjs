import { graph } from './graph.mjs';
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

// The never-automated hosts (job platforms, Y Combinator sites, X) are refused by name before the allow list is read: the
// skill never fetches, opens or scripts them. Reading X posts goes through the router's supplier, not through here.
// A local or private address, by its name or its literal IP: never fetched, at any hop of a redirect.
export function isLocalHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return false;
}

// `allowUrl` names one exact URL that may be read once, outside the fixed host list (the resume link the person gave). It
// never lifts the never-automated list or the local and private addresses, and it is https only.
export function assertAllowed(url, { allowUrl = null } = {}) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  if (graph().neverHosts.some((b) => host === b || host.endsWith(`.${b}`))) throw new Error(`never-automated host refused: ${host}`);
  if (allowUrl) {
    if (u.protocol !== 'https:') throw new Error(`https only: ${url}`);
    if (isLocalHost(host)) throw new Error(`local or private address refused: ${host}`);
    if (u.href !== new URL(allowUrl).href) throw new Error('that URL is not the one allowed');
    return;
  }
  if (!ALLOWED_HOSTS.includes(host)) throw new Error(`host not allowed: ${host}`);
}

export async function guardedFetch(url, opts = {}, fetchImpl = globalThis.fetch, { allowUrl = null } = {}) {
  assertAllowed(url, { allowUrl });
  const res = await fetchImpl(url, {
    ...opts,
    headers: { 'user-agent': 'tenjin-skills-job-search', accept: 'application/json', ...(opts.headers || {}) },
  });
  return res;
}
