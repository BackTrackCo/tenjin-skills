import { RouterClient, runRound } from './router.mjs';
import { loadState, updateState } from './store.mjs';
import { capOf } from './overlay.mjs';
import { fillNeed, recordHeld, clearHeld } from './routed.mjs';
import { addFitLead, contactProblem, excludedBy, resolvePerson } from './dedupe.mjs';
import { countryFrom } from './geo.mjs';
import { centsOf } from './prices.mjs';
import { linkedinSlugOf } from './platforms.mjs';
import { offersOf, buyerOk } from './offers.mjs';

// Leads by fit, when the person described a buyer: a company list, then the people at each company by role, then each person's
// recent posts as the reason to write now. These people never asked: their leads are kind "fit", and the writer may not say they
// did. Every need goes to the router as text, one process per phase, each answer kept at once. Held needs are named, not retried.
export const hasBuyer = (profile) => offersOf(profile).some((o) => buyerOk(o.buyer));
const buyerOffers = (profile) => offersOf(profile).filter((o) => buyerOk(o.buyer));
// The offer a company belongs to: the one that found it, else the first offer with a buyer.
const ownerOf = (profile, c) => buyerOffers(profile).find((o) => o.id === c.offerId) || buyerOffers(profile)[0] || null;
const DAY = 86400000;
const iso = (now) => new Date(now).toISOString();
const spend = (state, need, r, now, leads = 0) => state.spend.push({ at: iso(now), kind: need.kind, cents: centsOf(r.cost), cost: r.cost, leads });

export function companyListNeed(offer) {
  const b = offer.buyer || {};
  return fillNeed('company_list', { industry: b.industry || 'any', size: b.size || 'any', place: b.place || 'anywhere', offerId: offer.id });
}
export const unprocessed = (state, offerId = null) => Object.values(state.companies).filter((c) => !c.peopleDoneAt && (!offerId || !c.offerId || c.offerId === offerId));

// Phase 1: one company list per offer with a buyer, only when no company of that offer waits for its people search (a list costs
// more than a people search).
export async function runCompanyList({ profile, client, now, save }) {
  const offers = buyerOffers(profile).filter((o) => !unprocessed(loadState(), o.id).length);
  if (!offers.length) return { ran: false };
  const needs = offers.map(companyListNeed);
  const out = await runRound(needs, {
    client, save,
    onResult: (need, r) => updateState((s) => {
      if (!r.ok) return recordHeld(s, need, r);
      clearHeld(s, need);
      for (const c of r.ingest.companies) if (!s.companies[c.domain]) s.companies[c.domain] = { ...c, offerId: need.fields.offerId, source: 'list', foundAt: iso(now), peopleDoneAt: null };
      spend(s, need, r, now);
    }),
  });
  return { ran: true, ok: out.every((r) => r.ok), companies: out.reduce((n, r) => n + (r.ok ? r.ingest.companies.length : 0), 0), held: out.filter((r) => !r.ok).map((r) => ({ status: r.status, reason: r.reason }))[0] || null };
}

// A company the person named by its domain (G companies add): its profile fills the name, the LinkedIn page and the country.
export async function runCompanyProfiles({ client, now, save }) {
  const todo = Object.values(loadState().companies).filter((c) => !c.name && !c.profileHeld);
  if (!todo.length) return { reads: 0 };
  const needs = todo.map((c) => fillNeed('company_profile', { domain: c.domain }));
  await runRound(needs, {
    client, save,
    onResult: (need, r) => updateState((s) => {
      const c = s.companies[need.fields.domain];
      if (!c) return;
      if (!r.ok) { c.profileHeld = r.status; return recordHeld(s, need, r); }
      clearHeld(s, need);
      Object.assign(c, { name: r.ingest.name || c.domain, linkedinUrl: r.ingest.linkedinUrl, size: r.ingest.size, country: r.ingest.country });
      spend(s, need, r, now);
    }),
  });
  return { reads: todo.length };
}

// Phase 2: the people at each waiting company, by role. The person's own `companies_per_search` rule cuts the list; none by default.
export async function runPeopleSearch({ profile, overlay, client, now, save }) {
  const cap = capOf(overlay, 'companies_per_search');
  const withOwner = unprocessed(loadState()).map((c) => ({ c, owner: ownerOf(profile, c) })).filter((x) => x.owner && (x.owner.buyer.roles || []).length);
  const todo = withOwner.slice(0, cap === null ? undefined : cap).map((x) => x.c);
  if (!todo.length) return { searched: 0, added: 0 };
  const needs = todo.map((c) => fillNeed('people_search', { role: ownerOf(profile, c).buyer.roles.join(' or '), domain: c.domain, offerId: ownerOf(profile, c).id }));
  let added = 0;
  await runRound(needs, {
    client, save,
    onResult: (need, r) => updateState((s) => {
      const c = s.companies[need.fields.domain];
      if (!r.ok) return recordHeld(s, need, r);
      clearHeld(s, need);
      c.peopleDoneAt = iso(now);
      let n = 0;
      for (const p of r.ingest.people) {
        const slug = linkedinSlugOf(p.profileUrl);
        if (!slug) continue;
        const person = resolvePerson(s, [`linkedin:${slug.toLowerCase()}`], { name: p.name, now: iso(now) });
        if (!person.company) person.company = p.company || c.name || null;
        if (!person.domain) person.domain = c.domain;
        if (!person.country) person.country = countryFrom(p.address) || (c.country && /^[A-Za-z]{2}$/.test(c.country) ? c.country.toUpperCase() : null);
        if (contactProblem(s, person.key, { now })) continue;
        const key = `fit:${c.domain}:${slug.toLowerCase()}`;
        const lead = { key, person: { ...person, name: p.name, profileUrl: p.profileUrl }, source: 'people', text: '', phrase: null, offerId: need.fields.offerId || null, now };
        if (excludedBy(overlay.rules, { text: `${p.name} ${p.title} ${p.headline}`, author: p.name, links: [] }, person)) continue;
        if (addFitLead(s, lead).added) { s.leads[key].title = p.title || p.headline || null; n++; }
      }
      added += n;
      spend(s, need, r, now, n);
    }),
  });
  return { searched: todo.length, added };
}

// Phase 3: the recent post of each new fit lead, the reason to write now. A person with no LinkedIn posts but an X handle gets
// their X timeline. The newest post within 60 days becomes the lead's signal; with none the lead has "no signal".
export async function runRecentPosts({ client, now, save }) {
  const state = loadState();
  const todo = Object.values(state.leads).filter((l) => l.kind === 'fit' && l.status === 'new' && !l.postsRead);
  if (!todo.length) return { reads: 0 };
  const items = todo.map((l) => {
    const url = (state.people[l.personKey].ids.find((i) => i.startsWith('linkedin:')) || '').slice(9);
    return { key: l.key, need: url ? fillNeed('linkedin_author_posts', { url: `https://www.linkedin.com/in/${url}` }) : null };
  }).filter((x) => x.need);
  const byText = new Map(items.map((x) => [x.need.text, x.key]));
  updateState((s) => { for (const l of todo) if (!items.some((x) => x.key === l.key)) s.leads[l.key].postsRead = true; });
  await runRound(items.map((x) => x.need), {
    client, save,
    onResult: (need, r) => updateState((s) => {
      const lead = s.leads[byText.get(need.text)];
      if (!lead) return;
      lead.postsRead = true;
      if (!r.ok) return recordHeld(s, need, r);
      clearHeld(s, need);
      spend(s, need, r, now);
      const recent = r.ingest.posts.filter((p) => p.text && (!p.postedAt || now - Date.parse(p.postedAt) < 60 * DAY)).sort((a, b) => Date.parse(b.postedAt || 0) - Date.parse(a.postedAt || 0))[0];
      if (!recent) return;
      lead.text = recent.text;
      lead.postedAt = recent.postedAt;
      lead.signalUrl = recent.url;
      lead.links = recent.links || [];
      lead.v = (lead.v || 0) + 1;
    }),
  });
  return { reads: items.length };
}


export async function runFitRound({ profile, overlay, client = new RouterClient(), now = Date.now(), save }) {
  if (!hasBuyer(profile)) return { skipped: 'no buyer' };
  const out = {};
  out.list = await runCompanyList({ profile, client, now, save });
  out.profiles = await runCompanyProfiles({ client, now, save });
  out.people = await runPeopleSearch({ profile, overlay, client, now, save });
  out.posts = await runRecentPosts({ client, now, save });
  return out;
}

export function addCompanies(state, domains, now = Date.now(), offerId = null) {
  const added = [];
  for (const raw of domains) {
    const d = String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
    if (!d || !d.includes('.')) throw new Error(`not a company domain: ${raw}`);
    if (!state.companies[d]) { state.companies[d] = { domain: d, name: null, offerId, source: 'person', foundAt: iso(now), peopleDoneAt: null }; added.push(d); }
  }
  return added;
}
