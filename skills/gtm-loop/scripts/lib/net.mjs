import dns from 'node:dns';
import { graph } from './graph.mjs';

// The only network door for the scripts. Hosts outside this list are refused.
export const ALLOWED_HOSTS = ['hn.algolia.com', 'api.github.com'];

// The never-automated hosts (X, LinkedIn, Reddit) are refused by name before the allow list is read: the skill never fetches,
// opens in a tool or scripts them. Reading their posts goes through the router's sellers, not through here.
// A local or private address, by its name or its literal IP: never fetched, at any hop of a redirect.
export function isLocalHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
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

// `allowUrl` names one exact URL that may be read once, outside the fixed host list (a lead's own site the person approved). It
// never lifts the never-automated list or the local and private addresses, and it is https only.
export function assertAllowed(url, { allowUrl = null } = {}) {
  const u = new URL(url);
  const rawHost = u.hostname.toLowerCase();
  const host = rawHost.replace(/\.+$/, ''); // a trailing dot is the same host: it never gets past the list
  if (graph().neverHosts.some((b) => host === b || host.endsWith(`.${b}`))) throw new Error(`never-automated host refused: ${host}`);
  if (allowUrl) {
    if (u.protocol !== 'https:') throw new Error(`https only: ${url}`);
    if (isLocalHost(host)) throw new Error(`local or private address refused: ${host}`);
    if (u.href !== new URL(allowUrl).href) throw new Error('that URL is not the one allowed');
    return;
  }
  if (rawHost !== host || u.protocol !== 'https:' || !ALLOWED_HOSTS.includes(host)) throw new Error(`host not allowed: ${rawHost}`);
}

export async function guardedFetch(url, opts = {}, fetchImpl = globalThis.fetch, { allowUrl = null, lookup } = {}) {
  assertAllowed(url, { allowUrl });
  if (allowUrl) await assertPublicName(new URL(url).hostname, lookup); // before every hop, redirects included
  // The fixed hosts answer in place: a redirect is never followed (the hop would go unchecked), and a request has a time limit.
  return fetchImpl(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
    ...opts,
    headers: { 'user-agent': 'tenjin-skills-gtm-loop', accept: 'application/json', ...(opts.headers || {}) },
  });
}
