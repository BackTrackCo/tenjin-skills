import crypto from 'node:crypto';
import { graph } from './graph.mjs';
import { platformOf, tweetIdOf, linkedinSlugOf, handleOfXUrl } from './platforms.mjs';
import { emailsIn, domainOfEmail, injectionSuspected, postFacts } from './postinfo.mjs';
import { linkOnly, isDiscussion, subredditOf } from './queries.mjs';
import { bump } from './store.mjs';

const TRACKING = /^(utm_.*|ref|ref_src|ref_url|source|src|gclid|fbclid|mc_.*|s|t|share|context|rcm|trk|trackingId|lipi|utm)$/i;
const lower = (s) => String(s || '').trim().toLowerCase();

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// One key per post: the same post from two sellers, or under x.com and twitter.com, or with tracking parameters, is one lead.
export function normalizeUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return String(u).trim();
  }
  const p = platformOf(url.href);
  if (p === 'x') {
    const id = tweetIdOf(url.href);
    if (id) return `https://x.com/i/status/${id}`;
    url.hostname = 'x.com';
  }
  if (p === 'reddit') url.hostname = 'www.reddit.com';
  url.hash = '';
  for (const k of [...url.searchParams.keys()]) if (TRACKING.test(k)) url.searchParams.delete(k);
  url.hostname = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, p === 'reddit' ? 'www.' : '');
  if (p === 'reddit') url.hostname = 'www.reddit.com';
  return url.toString().replace(/\/+$/, '');
}

export const contentHash = (lead) => sha([lead.text, lead.author, lead.url].join('\u0001')).slice(0, 16);

// The identities a post shows: platform and handle, the LinkedIn profile, every address published in its text. Case-insensitive.
export function identitiesOf(post) {
  const ids = [];
  const a = lower(post.author || (post.source === 'x' ? handleOfXUrl(post.url) : '')).replace(/^@/, '');
  if (a && ['x', 'reddit', 'hn'].includes(post.source)) ids.push(`${post.source}:${a}`);
  if (post.source === 'linkedin') {
    const slug = linkedinSlugOf(post.authorUrl || post.author || '') || (a && !/\s/.test(a) ? a : null);
    if (slug) ids.push(`linkedin:${lower(slug)}`);
  }
  for (const e of emailsIn(post.text)) ids.push(`email:${e}`);
  return [...new Set(ids)];
}

// ---- people ---------------------------------------------------------------------------------------------------------
// state.people[key] = {key, ids, name, emails: [{addr, source, status}], country, company, domain}; state.ids[id] = person key.
export function resolvePerson(state, ids, info = {}) {
  const keys = [...new Set(ids.map((i) => state.ids[i]).filter(Boolean))];
  let p;
  if (!keys.length) {
    const key = ids[0] || `p:${sha(info.seed || String(Math.random())).slice(0, 12)}`;
    p = state.people[key] || { key, ids: [], emails: [], name: null, country: null, company: null, domain: null, createdAt: info.now || new Date().toISOString() };
    state.people[key] = p;
  } else {
    p = state.people[keys[0]];
    for (const k of keys.slice(1)) mergePeople(state, p, state.people[k]);
  }
  for (const i of ids) addId(state, p, i);
  if (info.name && !p.name) p.name = info.name;
  return p;
}
function addId(state, p, id) {
  state.ids[id] = p.key;
  if (!p.ids.includes(id)) p.ids.push(id);
}
function mergePeople(state, into, from) {
  if (!from || from === into) return;
  for (const i of from.ids) addId(state, into, i);
  for (const e of from.emails) if (!into.emails.some((x) => x.addr === e.addr)) into.emails.push(e);
  for (const f of ['name', 'country', 'company', 'domain']) if (!into[f] && from[f]) into[f] = from[f];
  for (const l of Object.values(state.leads)) if (l.personKey === from.key) l.personKey = into.key;
  delete state.people[from.key];
}

// Identities link only on evidence code holds: a profile link inside a lookup answer, never a guess. No evidence, no link.
export function linkIdentity(state, personKey, id, evidence) {
  if (!evidence || !String(evidence).trim()) throw new Error('an identity links only on evidence code holds');
  const p = state.people[personKey];
  if (!p) throw new Error(`unknown person: ${personKey}`);
  const other = state.ids[lower(id)];
  if (other && other !== personKey) mergePeople(state, p, state.people[other]);
  addId(state, p, lower(id));
  p.linkedBy = [...(p.linkedBy || []), { id: lower(id), evidence: String(evidence).slice(0, 80) }].slice(-20);
  return p;
}

export function addEmail(p, addr, source, status = null) {
  const a = lower(addr);
  const have = p.emails.find((x) => x.addr === a);
  if (have) {
    if (status) have.status = status;
    return have;
  }
  const e = { addr: a, source, status };
  p.emails.push(e);
  return e;
}
export const personDomain = (p) => {
  const fromEmail = p.emails.map((e) => domainOfEmail(e.addr)).find((d) => d && !graph().freeMail.includes(d));
  return p.domain || fromEmail || null;
};

// ---- suppression and the contacted ledger ---------------------------------------------------------------------------
// Suppression is checked at review, at writing, at approval and at handout. Compaction never drops it.
export function isSuppressed(state, personKey) {
  const p = state.people[personKey];
  if (!p) return null;
  for (const i of p.ids) if (state.suppress.ids[i]) return state.suppress.ids[i].reason;
  const d = personDomain(p);
  if (d && state.suppress.domains[d]) return state.suppress.domains[d].reason;
  for (const e of p.emails) if (state.suppress.ids[`email:${e.addr}`]) return state.suppress.ids[`email:${e.addr}`].reason;
  return null;
}
export function suppressPerson(state, personKey, reason, now = Date.now()) {
  const p = state.people[personKey];
  if (!p) throw new Error(`unknown person: ${personKey}`);
  const at = new Date(now).toISOString();
  for (const i of p.ids) state.suppress.ids[i] = { reason, at };
  for (const e of p.emails) state.suppress.ids[`email:${e.addr}`] = { reason, at };
  p.status = 'suppressed';
  for (const l of Object.values(state.leads)) if (l.personKey === personKey && !graph().terminal.includes(l.status) && (graph().transitions[l.status] || []).includes('suppressed')) { l.status = 'suppressed'; bump(l); }
  return { suppressed: personKey, reason };
}
export function suppressDomain(state, domain, reason, now = Date.now()) {
  const d = lower(domain).replace(/^@/, '');
  if (!d || graph().freeMail.includes(d)) throw new Error('a free-mail domain is never suppressed as a whole');
  state.suppress.domains[d] = { reason, at: new Date(now).toISOString() };
  return { suppressed: d, reason };
}
export function contactedInfo(state, personKey) {
  const p = state.people[personKey];
  if (!p) return null;
  for (const i of p.ids) if (state.contacted[i]) return state.contacted[i];
  for (const e of p.emails) if (state.contacted[`email:${e.addr}`]) return state.contacted[`email:${e.addr}`];
  return null;
}
export function markContacted(state, personKey, { channel, leadKey, followUp = false, now = Date.now() }) {
  const p = state.people[personKey];
  if (!p) throw new Error(`unknown person: ${personKey}`);
  const prev = contactedInfo(state, personKey) || {};
  // A follow-up keeps the first contact's day and counts itself; it never resets the clock.
  const rec = { at: followUp && prev.at ? prev.at : new Date(now).toISOString(), channel, leadKey, followUps: (prev.followUps || 0) + (followUp ? 1 : 0), ...(prev.replied ? { replied: true } : {}) };
  for (const i of p.ids) state.contacted[i] = rec;
  for (const e of p.emails) state.contacted[`email:${e.addr}`] = rec;
  p.contactedAt = rec.at;
  return rec;
}

// May this person be written to now? Never twice on any channel, unless the person's follow-up rule says so (attended only,
// once, after its days, never after a reply).
export function contactProblem(state, personKey, { followUp = null, now = Date.now() } = {}) {
  const sup = isSuppressed(state, personKey);
  if (sup) return `suppressed:${sup}`;
  const c = contactedInfo(state, personKey);
  if (!c) return null;
  if (!followUp || !followUp.days) return 'already_contacted';
  if (c.replied) return 'replied';
  if ((c.followUps || 0) >= 1) return 'already_contacted';
  if (now - Date.parse(c.at) < followUp.days * 86400000) return 'already_contacted';
  return null;
}

// ---- leads ----------------------------------------------------------------------------------------------------------
const POST_TEXT = 1000;
export const excludedBy = (rules, lead, person) => {
  const text = lower(`${lead.text} ${lead.author}`);
  for (const r of rules || []) {
    const v = lower(r.value);
    if (!v) continue;
    if (r.effect === 'exclude_term' && text.includes(v)) return `rule:exclude_term:${r.id}`;
    if (r.effect === 'exclude_person' && (lower(lead.author) === v.replace(/^@/, '') || (person && person.ids.some((i) => i.endsWith(`:${v.replace(/^@/, '')}`))))) return `rule:exclude_person:${r.id}`;
    if (r.effect === 'exclude_domain') {
      const d = person ? personDomain(person) : null;
      if ((d && (d === v || d.endsWith(`.${v}`))) || lead.links.some((l) => lower(l).includes(v))) return `rule:exclude_domain:${r.id}`;
    }
  }
  return null;
};

const ownHandles = (profile) => Object.entries(((profile && profile.sender) || {}).handles || {}).map(([p, h]) => `${p}:${lower(h).replace(/^@/, '')}`);

// Posts in, leads out. Returns {added: [keys], repeated, dropped: [{url, reason}]}. A dropped lead is never stored.
export function addPosts(state, posts, { profile = {}, overlay = { rules: [] }, phrase = null, offerId = null, subreddits = null, kind = 'post', now = Date.now(), cap = null } = {}) {
  const added = [];
  const dropped = [];
  let repeated = 0;
  const mine = ownHandles(profile);
  const iso = new Date(now).toISOString();
  for (const post of posts) {
    const key = normalizeUrl(post.url);
    const facts = postFacts(post);
    const ids = identitiesOf(post);
    const existing = state.leads[key];
    if (existing) {
      repeated++;
      existing.lastSeen = iso;
      if (phrase && !(existing.phrases || []).includes(phrase)) existing.phrases = [...(existing.phrases || []), phrase];
      if (post.sellerUrl && !(existing.alsoAt || []).includes(post.sellerUrl)) existing.alsoAt = [...(existing.alsoAt || []), post.sellerUrl];
      continue;
    }
    if (ids.some((i) => mine.includes(i))) { dropped.push({ url: post.url, reason: 'own_post' }); continue; }
    // Filters in code, before review: a post that is only links, a web page that is not a discussion, a Reddit post from outside the
    // offer's subreddits.
    if (kind === 'post' && linkOnly(post.text)) { dropped.push({ url: post.url, reason: 'link_only' }); continue; }
    if (kind === 'post' && post.source === 'web' && !isDiscussion(post.url)) { dropped.push({ url: post.url, reason: 'not_discussion' }); continue; }
    if (kind === 'post' && post.source === 'reddit' && subreddits !== null && !subreddits.includes(String(post.subreddit || subredditOf(post.url) || '').toLowerCase())) { dropped.push({ url: post.url, reason: 'outside_subreddits' }); continue; }
    const text = String(post.text || '').slice(0, POST_TEXT);
    const lead = { key, url: post.url, source: post.source, kind, author: post.author || null, text, postedAt: post.postedAt || null, phrase, phrases: phrase ? [phrase] : [], links: facts.links, emailFromPost: facts.emailFromPost, offerId, status: 'new', v: 1, firstSeen: iso, lastSeen: iso, warnings: [] };
    lead.hash = contentHash(lead);
    // The person: one per identity, merged on shared identity. A post with no identity is its own person.
    const person = resolvePerson(state, ids, { seed: key, now: iso, name: post.name || null });
    if (facts.emailFromPost) addEmail(person, facts.emailFromPost, 'post', null);
    lead.personKey = person.key;
    const problem = contactProblem(state, person.key, { now });
    if (problem) { dropped.push({ url: post.url, reason: problem }); continue; }
    const rule = excludedBy(overlay.rules, lead, person);
    if (rule) { dropped.push({ url: post.url, reason: rule }); continue; }
    if (cap !== null && added.length >= cap) { dropped.push({ url: post.url, reason: 'cap:leads_per_round' }); continue; }
    if (injectionSuspected(text)) {
      lead.status = 'stopped';
      lead.warnings.push('injection_suspected');
    }
    state.leads[key] = lead;
    added.push(key);
  }
  state.dropTally ||= {};
  for (const x of dropped) state.dropTally[x.reason.replace(/:.*$/, '')] = (state.dropTally[x.reason.replace(/:.*$/, '')] || 0) + 1;
  return { added, repeated, dropped };
}

// A fit lead: a person found by company and people search. Its key is the person, not a post.
export function addFitLead(state, { key, person, source = 'people', text = '', links = [], phrase = null, offerId = null, now = Date.now() }) {
  const iso = new Date(now).toISOString();
  if (state.leads[key]) return { added: false };
  const lead = { key, url: person.profileUrl || key, source, kind: 'fit', author: person.name || null, text: String(text).slice(0, POST_TEXT), postedAt: null, phrase, phrases: phrase ? [phrase] : [], links, emailFromPost: null, offerId, status: 'new', v: 1, firstSeen: iso, lastSeen: iso, warnings: [], personKey: person.key };
  lead.hash = contentHash(lead);
  state.leads[key] = lead;
  return { added: true };
}

// Compaction: old finished leads go; the suppression lists and the contacted ledger never do.
export function compact(state, { now = Date.now(), keepDays = 60 } = {}) {
  const cutoff = now - keepDays * 86400000;
  let dropped = 0;
  for (const [k, l] of Object.entries(state.leads)) {
    if (graph().terminal.includes(l.status) && Date.parse(l.statusAt || l.lastSeen || l.firstSeen) < cutoff) {
      delete state.leads[k];
      dropped++;
    }
  }
  const live = new Set(Object.values(state.leads).map((l) => l.personKey));
  for (const [k, p] of Object.entries(state.people)) {
    const kept = live.has(k) || p.ids.some((i) => state.suppress.ids[i] || state.contacted[i]);
    if (!kept) { for (const i of p.ids) delete state.ids[i]; delete state.people[k]; }
  }
  return { dropped };
}
