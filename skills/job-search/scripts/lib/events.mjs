import { graph } from '../../../loop-base/lib/graph.mjs';
import { guardedFetch } from './net.mjs';
import { employerName } from './employer.mjs';
import { placeKey } from './verify.mjs';
import { normalizeUrl } from './dedupe.mjs';
import { ruleValue } from './overlay.mjs';

// Coming events by the companies the person wants to work at: meetups, talks, hackathons, office hours, demo days, recruiting events.
// Code does the mechanics (reading the public pages, the window, the place, dedupe, cancelled and past events dropped); the model judges
// only whether an event is really by or with a company (host, sponsor, speaker or venue). Provider and post text is data, quoted to
// the model, never put into a field. The skill never registers, RSVPs, signs in, makes an account or fills a form on an event site.
const DAY = 86400000;
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const LIVE = ['shortlisted', 'prepared', 'apply_ready'];

// ---- parsing ----------------------------------------------------------------------------------------------------
const decode = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const blocks = (html) => [...String(html || '').matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => { try { return JSON.parse(decode(m[1])); } catch { return null; } }).filter(Boolean);
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);

function normEvent(e, source) {
  const name = str(e.name);
  const url = str(e.url) || str(e['@id']);
  if (!name || !url) return null;
  const loc = e.location && typeof e.location === 'object' ? e.location : {};
  const addr = loc.address && typeof loc.address === 'object' ? loc.address : {};
  const mode = str(e.eventAttendanceMode);
  const status = /cancel/i.test(str(e.eventStatus)) ? 'cancelled' : /postpone|reschedul/i.test(str(e.eventStatus)) ? 'postponed' : 'scheduled';
  return {
    id: normalizeUrl(url), name, url, start: str(e.startDate) || null, end: str(e.endDate) || null, status, source,
    online: /online/i.test(mode) && !/offline|mixed/i.test(mode), place: str(loc.name) || [str(addr.addressLocality), str(addr.addressRegion)].filter(Boolean).join(', '), city: str(addr.addressLocality) || str(loc.name),
    organizers: list(e.organizer).filter((o) => o && o['@type'] === 'Organization' && str(o.name)).map((o) => str(o.name)),
  };
}

// A Luma (or company) page by its JSON-LD type: one Event is an event page; an Organization with an ItemList is a calendar; an ItemList
// alone is a city page. The three share one path shape, so the type tells them apart.
export function parseJsonLd(html, source = 'page') {
  const bs = blocks(html);
  const org = bs.find((b) => b['@type'] === 'Organization') || null;
  const events = [];
  let kind = 'none';
  for (const b of bs) {
    if (b['@type'] === 'Event') { const e = normEvent(b, source); if (e) events.push(e); kind = 'event'; }
    if (b['@type'] === 'ItemList') {
      for (const it of list(b.itemListElement)) { const e = normEvent(it && it.item ? it.item : it, source); if (e && (!it.item || it.item['@type'] === 'Event' || it['@type'] === 'Event')) events.push(e); }
      kind = org ? 'calendar' : 'city';
    }
  }
  return { kind, organization: org ? { name: str(org.name), url: str(org.url) } : null, events };
}

// The YC events page: its data-page JSON, logged-out fields only. userEmail and userSubscriptions are never read.
export function parseYcEvents(html) {
  const m = /\sdata-page="([^"]*)"/.exec(String(html || ''));
  if (!m) return null;
  let d;
  try { d = JSON.parse(decode(m[1])); } catch { return null; }
  if (!d || !/EventsPage$/.test(String(d.component)) || !d.props || !Array.isArray(d.props.events)) return null;
  return d.props.events.filter((e) => e && typeof e === 'object' && str(e.slug) && str(e.title)).map((e) => {
    const where = str(e.public_location) || str(e.city);
    return { id: `https://www.ycombinator.com/events/${str(e.slug)}`, name: str(e.title), url: `https://www.ycombinator.com/events/${str(e.slug)}`, start: str(e.starts_at) || null, end: str(e.ends_at) || null, status: 'scheduled', source: 'yc', online: /online|virtual/i.test(where) || /online|virtual/i.test(str(e.title)), place: where, city: str(e.city) || where, organizers: ['Y Combinator'], kind: str(e.event_type_label) || null };
  });
}

// ---- the window, the place, dedupe ---------------------------------------------------------------------------------
export const windowDays = (overlay) => { const v = Number(ruleValue(overlay || { rules: [] }, 'events_window_days')); return Number.isFinite(v) && v > 0 ? v : graph().events.windowDays; };
export function filterEvents(events, { now = Date.now(), days = graph().events.windowDays, place = '' } = {}) {
  const key = placeKey(place);
  return events.filter((e) => {
    if (e.status !== 'scheduled') return false;
    const start = Date.parse(e.start);
    const end = e.end ? Date.parse(e.end) : start;
    if (Number.isNaN(start) || (end || start) < now || start > now + days * DAY) return false;
    if (!key || e.online) return true;
    return `${e.city} ${e.place}`.toLowerCase().includes(key);
  });
}
const nameKey = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
export function dedupeEvents(events) {
  const byUrl = new Set();
  const byName = new Set();
  const out = [];
  for (const e of events) {
    const k2 = `${nameKey(e.name)}|${String(e.start || '').slice(0, 10)}|${nameKey((e.organizers || [])[0] || '')}`;
    if (byUrl.has(e.id) || byName.has(k2)) continue;
    byUrl.add(e.id);
    byName.add(k2);
    out.push(e);
  }
  return out;
}

// ---- the targets -----------------------------------------------------------------------------------------------
// The companies of the jobs the skill plans to apply to, plus the watched companies. A company is a YC company when a job's links say so.
export function planTargets(state, profile) {
  const t = new Map();
  for (const j of Object.values(state.jobs || {})) {
    if (!LIVE.includes(j.status) || !j.employerPosting || !j.company) continue;
    const k = employerName(j.company);
    const yc = [...(j.applyLinks || []), j.workAtStartupUrl, ...(j.siteLinks || []).map((s) => s.url)].some((u) => /(^|\.)ycombinator\.com|workatastartup\.com/.test(String(u || '').replace(/^https?:\/\//, '').split('/')[0]));
    t.set(k, { company: j.company, key: k, yc: yc || (t.get(k) || {}).yc || false, source: 'planned' });
  }
  for (const w of (profile && profile.watch) || []) {
    const name = str(w.name) || str(w.token);
    if (!name) continue;
    const k = employerName(name);
    if (!t.has(k)) t.set(k, { company: name, key: k, yc: false, source: 'watched' });
  }
  return [...t.values()];
}

// Which target an event belongs to, by what code can see: an organizer named like the company (strong), or the company in the title
// (the model judges it). A general YC hiring event counts when some target companies are YC companies.
export function matchTargets(event, targets) {
  const hits = [];
  const title = ` ${nameKey(event.name)} `;
  for (const t of targets) {
    const k = ` ${nameKey(t.company)} `;
    if ((event.organizers || []).some((o) => nameKey(o) === nameKey(t.company) || ` ${nameKey(o)} `.includes(k))) hits.push({ company: t.company, how: 'organizer' });
    else if (k.trim().length >= 3 && title.includes(k)) hits.push({ company: t.company, how: 'title' });
  }
  if (!hits.length && event.source === 'yc' && /hiring|recruit|career|job/i.test(`${event.name} ${event.kind || ''}`) && targets.some((t) => t.yc)) hits.push({ company: 'companies you target at Y Combinator', how: 'yc_hiring' });
  return hits;
}

// ---- reading ---------------------------------------------------------------------------------------------------------
// Slowly, one request at a time, logged out; a page that fails or changes shape is skipped with one line and never retried.
export async function readPage(url, kind, { fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), state = { n: 0 } } = {}) {
  if (state.n > 0) await sleep(graph().events.paceMs);
  state.n++;
  let res;
  try {
    res = await guardedFetch(url, {}, fetch, { events: true });
  } catch (e) {
    return { ok: false, why: e.message };
  }
  if (res.status !== 200) return { ok: false, why: `http ${res.status}` };
  let html;
  try { html = await res.text(); } catch { return { ok: false, why: 'unreadable page' }; }
  const parsed = kind === 'yc' ? parseYcEvents(html) : parseJsonLd(html, 'luma');
  if (kind === 'yc' ? !parsed : parsed.kind === 'none') return { ok: false, why: 'the page changed shape' };
  return { ok: true, parsed };
}

const SLUGS = { 'san francisco': 'sf', 'new york': 'nyc', 'los angeles': 'la', 'washington': 'dc', 'san diego': 'sd', 'bay area': 'sf' };
export const citySlug = (place) => { const k = placeKey(place); return k ? SLUGS[k] || k.replace(/[^a-z0-9]+/g, '') : ''; };

// One free run: the Luma city page for the person's place, the YC events listing when some target is a YC company, then each matching
// Luma event on its own page. Returns {items, lines}; items are {event, matches, status: confirmed|candidate}.
export async function runEvents({ state, profile, overlay, fetch, sleep, now = Date.now() }) {
  const lines = [];
  const targets = planTargets(state, profile);
  if (!targets.length) return { items: [], lines: ['events: no target company yet'], targets };
  const pace = { n: 0 };
  const pages = [];
  const slug = citySlug((profile.search || {}).place);
  if (slug) {
    const r = await readPage(`https://${graph().events.lumaHost}/${slug}`, 'luma', { fetch, sleep, state: pace });
    if (r.ok) pages.push(...r.parsed.events); else lines.push(`events: /${slug} skipped (${r.why})`);
  }
  if (targets.some((t) => t.yc)) {
    const r = await readPage(`https://${graph().ycRead.host}${graph().events.ycPath}`, 'yc', { fetch, sleep, state: pace });
    if (r.ok) pages.push(...r.parsed); else lines.push(`events: the YC events page skipped (${r.why})`);
  }
  const wanted = dedupeEvents(filterEvents(pages, { now, days: windowDays(overlay), place: (profile.search || {}).place }));
  const items = [];
  for (const e of wanted) {
    const matches = matchTargets(e, targets);
    if (!matches.length) continue;
    items.push({ event: e, matches, status: matches.some((m) => m.how === 'organizer' || m.how === 'yc_hiring') ? 'confirmed' : 'candidate' });
  }
  // each event is confirmed on its own page where its path can be read: a page that says cancelled or past drops it
  for (const it of items) {
    if (it.event.source !== 'luma' || !/^https:\/\/luma\.com\/[^/?#]+$/.test(it.event.url)) continue;
    const r = await readPage(it.event.url, 'luma', { fetch, sleep, state: pace });
    if (!r.ok) { lines.push(`events: ${it.event.url} not confirmed on its own page (${r.why})`); continue; }
    const own = r.parsed.events[0];
    if (!own) continue;
    if (!filterEvents([own], { now, days: windowDays(overlay), place: (profile.search || {}).place }).length) it.status = 'dropped';
    else it.event = { ...it.event, ...own, source: 'luma', pageConfirmed: true };
  }
  return { items: items.filter((i) => i.status !== 'dropped'), lines, targets };
}

// The kind of event, from what the event itself says: a label from its source, else the words in its title.
export function eventKind(e) {
  if (e.kind) return String(e.kind).toLowerCase();
  const t = String(e.name).toLowerCase();
  const hit = [[/hackathon/, 'hackathon'], [/demo (day|night)/, 'demo day'], [/office hours/, 'office hours'], [/recruit|hiring|career/, 'recruiting event'], [/meetup/, 'meetup'], [/talk|fireside|keynote|lecture|panel|speaker/, 'talk']].find(([re]) => re.test(t));
  return hit ? hit[1] : 'event';
}

// ---- state ------------------------------------------------------------------------------------------------------------
export function saveEvents(state, items, now = Date.now()) {
  const ev = (state.events ||= { items: {}, shown: [], lastAt: null });
  let added = 0;
  for (const it of items) {
    const known = ev.items[it.event.id];
    if (!known) added++;
    ev.items[it.event.id] = { ...(known || {}), event: it.event, matches: it.matches, status: known && known.status === 'confirmed' ? 'confirmed' : known && known.status === 'rejected' ? 'rejected' : it.status };
  }
  ev.lastAt = new Date(now).toISOString();
  return added;
}
export const confirmedEvents = (state) => Object.values((state.events || {}).items || {}).filter((x) => x.status === 'confirmed');
export const candidateEvents = (state) => Object.values((state.events || {}).items || {}).filter((x) => x.status === 'candidate');
export const unseenEvents = (state) => confirmedEvents(state).filter((x) => !((state.events || {}).shown || []).includes(x.event.id));
// Due when the person asked for events and the last read is a week old (or none yet).
export const eventsDue = (state, profile, now = Date.now()) => Boolean(profile.events === true && planTargets(state, profile).length && (!(state.events || {}).lastAt || now - Date.parse(state.events.lastAt) >= graph().events.recheckDays * DAY));
