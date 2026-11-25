import dns from 'node:dns';
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

// Does a resolved address point inside: loopback, private, link-local, unique-local or unspecified, IPv4 or IPv6, and an
// IPv4-mapped IPv6 address by the IPv4 inside it.
export function isPrivateAddress(addr) {
  const a = String(addr).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return isLocalHost(mapped[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return isLocalHost([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  if (a.includes(':')) return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('::ffff:');
  return isLocalHost(a);
}

// The host is resolved before each hop, and the hop is refused when any address it resolves to is inside, or when the
// lookup fails. Known gap in v0: `fetch` resolves the name again when it connects, so a DNS rebinding between this check
// and the connect is not caught.
export async function assertPublicName(host, lookup = (h, o) => dns.promises.lookup(h, o)) {
  if (isLocalHost(host)) throw new Error(`local or private address refused: ${host}`);
  if (/^[\d.]+$/.test(host) || host.includes(':')) return; // a literal IP was checked above
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch (e) {
    throw new Error(`the name did not resolve: ${host}`);
  }
  const list = Array.isArray(addrs) ? addrs : [addrs];
  if (!list.length) throw new Error(`the name did not resolve: ${host}`);
  for (const a of list) if (isPrivateAddress(a.address || a)) throw new Error(`${host} resolves to a local or private address: refused`);
}

// The one narrow exception to the never-automated list: code may read a few public Y Combinator pages, logged out, for discovery
// only. These paths on one host and nothing else (no query, no other Y Combinator host).
const YC_PATHS = [
  /^\/robots\.txt$/,
  /^\/jobs\/role\/[a-z0-9-]+(\/[a-z0-9-]+)?$/,
  /^\/companies\/[a-z0-9-]+$/,
  /^\/companies\/[a-z0-9-]+\/jobs\/[A-Za-z0-9-]+$/,
];
export function assertYcRead(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== graph().ycRead.host || u.search || u.hash || u.username || u.password || u.port) throw new Error(`not a readable Y Combinator page: ${url}`);
  if (!YC_PATHS.some((re) => re.test(u.pathname))) throw new Error(`not a readable Y Combinator page: ${u.pathname}`);
}

// `allowUrl` names one exact URL that may be read once, outside the fixed host list (the resume link the person gave). It
// never lifts the never-automated list or the local and private addresses, and it is https only.
export function assertAllowed(url, { allowUrl = null, yc = false } = {}) {
  if (yc) return assertYcRead(url);
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

export async function guardedFetch(url, opts = {}, fetchImpl = globalThis.fetch, { allowUrl = null, lookup, yc = false } = {}) {
  assertAllowed(url, { allowUrl, yc });
  if (yc) {
    // Logged out by construction: no cookie, no credentials, and a redirect is never followed.
    return fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit', headers: { 'user-agent': 'tenjin-skills-job-search', accept: 'text/html' } });
  }
  if (allowUrl) await assertPublicName(new URL(url).hostname, lookup); // before every hop, redirects included
  const res = await fetchImpl(url, {
    ...opts,
    headers: { 'user-agent': 'tenjin-skills-job-search', accept: 'application/json', ...(opts.headers || {}) },
  });
  return res;
}
