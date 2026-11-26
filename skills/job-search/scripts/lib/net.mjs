import { graph } from '../../../loop-base/lib/graph.mjs';
import { extendApp } from '../../../loop-base/lib/app.mjs';
import * as guard from '../../../loop-base/lib/netguard.mjs';
import './paths.mjs';

// The guard itself (address checks, the allowed and never lists, read modes, the one-URL exception) is the loop base's. This file keeps
// Job Search's hosts and the two narrow read modes with their path rules.
export const { isLocalHost, isPrivateAddress, assertPublicName } = guard;
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

// The one narrow exception to the never-automated list: code may read a few public Y Combinator pages, logged out, for discovery
// only. These paths on one host and nothing else (no query, no other Y Combinator host).
export const YC_PATHS = [
  /^\/jobs\/role\/[a-z0-9-]+(\/[a-z0-9-]+)?$/,
  /^\/companies\/[a-z0-9-]+$/,
  /^\/companies\/[a-z0-9-]+\/jobs\/[A-Za-z0-9-]+$/,
];
// Public event pages, read in code, logged out, for discovery only: a Luma event, calendar or city page (one path segment, none of the
// people, company, share, session, sign-in, RSVP or API paths), and the one Y Combinator events listing. The YC robots.txt rules were
// checked when /events was chosen (the recorded copy is in the tests); an event's own YC page is not read until its path is curated.
const LUMA_REFUSED = new Set(['user', 'in', 'company', 'social-share', 'signin', 'sign-in', 'login', 'log-in', 'signup', 'sign-up', 'rsvp', 'api', 'auth', 'oauth', 'account', 'settings', 'calendar', 'discover', 'home', 'checkout', 'ticket', 'tickets']);
export const LUMA_PATH = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
export const YC_EVENT_PATHS = [/^\/events$/];
export function assertEventRead(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.search || u.hash || u.username || u.password || u.port) throw new Error(`not a readable event page: ${url}`);
  const host = u.hostname.toLowerCase();
  if (host === graph().events.lumaHost) {
    const m = LUMA_PATH.exec(u.pathname);
    if (!m || LUMA_REFUSED.has(m[1].toLowerCase()) || /^session-/i.test(m[1])) throw new Error(`not a readable event page: ${u.pathname}`);
    return;
  }
  if (host === graph().ycRead.host && YC_EVENT_PATHS.some((re) => re.test(u.pathname))) return;
  throw new Error(`not a readable event page: ${host}${u.pathname}`);
}

export function assertYcRead(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== graph().ycRead.host || u.search || u.hash || u.username || u.password || u.port) throw new Error(`not a readable Y Combinator page: ${url}`);
  if (!YC_PATHS.some((re) => re.test(u.pathname))) throw new Error(`not a readable Y Combinator page: ${u.pathname}`);
}

const readMode = ({ events = false, yc = false } = {}) => (events ? 'events' : yc ? 'yc' : null);

// `allowUrl` names one exact URL that may be read once, outside the fixed host list (the resume link the person gave). It
// never lifts the never-automated list or the local and private addresses, and it is https only.
export const assertAllowed = (url, { allowUrl = null, yc = false, events = false } = {}) => guard.assertAllowed(url, { allowUrl, mode: readMode({ events, yc }) });

export const guardedFetch = (url, opts = {}, fetchImpl = globalThis.fetch, { allowUrl = null, lookup, yc = false, events = false } = {}) => guard.guardedFetch(url, opts, fetchImpl, { allowUrl, lookup, mode: readMode({ events, yc }) });

// The never-automated hosts (job platforms, Y Combinator sites, X) are refused by name before the allow list is read: the skill never
// fetches, opens or scripts them. Reading X posts goes through the router's supplier, not through here.
extendApp({ hosts: { allowed: ALLOWED_HOSTS, never: () => graph().neverHosts, userAgent: 'tenjin-skills-job-search', readModes: { yc: { assert: assertYcRead }, events: { assert: assertEventRead } } } });
