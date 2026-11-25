import { graph } from './graph.mjs';
import { RouterClient, runNeed, runRound } from './router.mjs';
import { SUPPLIERS } from './suppliers/index.mjs';
import { ingest } from './ingest.mjs';
import { loadState, updateState } from './store.mjs';
import { loadOverlay } from './overlay.mjs';
import { advanceSearch, searchRound, variantFor } from './work.mjs';
import { companyNames, websiteOf } from './company.mjs';

// With Tenjin, a search round runs in code, with no model step before review: the needs go to the router one at a time
// (router.mjs), each result is ingested, and the same rule as the model-run rounds decides whether the next role-word
// variant is worth a round. A search that is held (any status but fulfilled, no adapter, a timeout) is named in the
// report; nothing is retried. The board search is a routed need too, run by catalog tool id; a missing mapper holds it for
// the round with a report line, never a model step.
const fill = (kind, f) => graph().needTemplates[kind].replace(/\{(\w+)\}/g, (_, k) => (f[k] === undefined ? '' : String(f[k])));
export const needText = (kind, q) => fill(kind, { ...q, role: q.variant || q.role, place: q.place || 'any place' });

const SEARCH_KINDS = ['job_postings', 'x_hiring_posts'];
export function roundNeeds(profile, state, now, round) {
  const since = state.routed && state.routed.lastSearchAt ? new Date(Math.max(Date.parse(state.routed.lastSearchAt) - 86400000, now - 14 * 86400000)) : new Date(now - 14 * 86400000);
  const days = Math.max(1, Math.ceil((now - since.getTime()) / 86400000));
  const base = { role: profile.search.role, place: profile.search.place || '', remote: profile.search.remote === true, since: since.toISOString().slice(0, 10), variant: variantFor(profile, round), round };
  const searchNeeds = SEARCH_KINDS.map((kind) => ({ kind, text: needText(kind, { ...base, days }), fields: { ...base, days: Math.min(days, 14), role: base.variant || base.role }, query: base }));
  // The board search is one need per round, run through the catalog's search tool by id (no `{query}` route, no seller named).
  const web = { kind: 'web_search', tool: 'exa-search', text: null, fields: { ...base, role: base.variant || base.role }, query: base };
  return [...searchNeeds, web];
}

// Needs for one job: the employer's careers page for a reviewed job with no employer posting, and the people search for a
// job the person asked contacts for. Each is tried once; the model's Haiku step stays as the fallback.
export function jobNeeds(state, profile, overlay, { kinds = ['careers_page', 'people_search'], keys = null, skips = null } = {}) {
  const out = [];
  const count = (() => { const r = (overlay.rules || []).filter((x) => x.effect === 'contact_count').pop(); return r && r.value !== 'all' ? Number(r.value) : undefined; })();
  for (const j of kinds.includes('careers_page') ? Object.values(state.jobs) : []) {
    const site = j.employerWebsite;
    if (j.status === 'reviewed' && !j.employerPosting && !j.careersChecked && !(j.routedTried || {}).careers_page && site && ['no_board', 'unconfirmed_board', 'no_match', 'no_apply_link', 'yc_platform_only'].includes(j.unresolved)) {
      out.push({ kind: 'careers_page', text: fill('careers_page', { company: j.company, url: site }), fields: { jobKey: j.key, website: site, company: j.company }, query: null, jobKey: j.key });
    }
  }
  // The people search never needs an employer website: with one it filters by the company's domain; without one it runs by company
  // name and city, and its results are weak unless their company matches a known domain or the board's company name. A job it does
  // not search is named in `skips` with the reason, never skipped in silence.
  for (const key of kinds.includes('people_search') ? keys || state.contactsRequested || [] : []) {
    const j = state.jobs[key];
    const why = !j ? 'unknown job' : (state.contacts[key] || []).length ? 'a contact is already recorded' : j.contactsSearched ? 'already searched' : (j.routedTried || {}).people_search ? 'tried once and held' : !j.company ? 'no company name' : null;
    if (why) { if (skips) skips.push({ key, reason: why }); continue; }
    const site = websiteOf(j);
    out.push({ kind: 'people_search', text: fill('people_search', { company: j.company, url: site ? site.url : j.url || '', where: j.city ? ` in ${j.city}` : '' }), fields: { jobKey: key, website: site ? site.url : null, company: j.company, names: companyNames(j), linkedinUrl: j.companyLinkedinUrl || null, titles: graph().peopleTitles, city: j.city || '', count }, query: null, jobKey: key });
  }
  return out;
}

// The watcher runs the rounds in code only when the searches that can run in code have adapters; `J route` runs them by hand.
export const allNeedsCovered = () => SEARCH_KINDS.every((k) => SUPPLIERS.some((s) => s.kind === k));

const hold = (r, now, { clock = true } = {}) => updateState((s) => {
  s.held = [...s.held.filter((h) => !String(h.detail).startsWith(`routed:${r.need}:`)), { reason: 'source_empty', detail: `routed:${r.need}: ${r.status}: ${r.reason}` }];
  if (clock) s.routed.lastSearchAt = new Date(now).toISOString();
  if (r.status === 'wallet_unavailable') s.routed.skipReason = 'wallet_unavailable: run the searches in an attended turn';
});

const covered = (kind) => SUPPLIERS.some((x) => x.kind === kind);
// A need code cannot run (no adapter for its kind, or a supplier it does not know) becomes one model item for the round.
const leaveForModel = (need, round, now) => updateState((s) => {
  s.search.needPending = [...(s.search.needPending || []).filter((n) => n.kind !== need.kind), { kind: need.kind, text: need.text, query: need.query, round, at: new Date(now).toISOString() }];
});

// Each need runs on its own: one that cannot run in code never stops the others. An uncovered need is left as a Haiku item
// for the round's wake.
export async function routedRounds({ profile, fetch, client = new RouterClient(), now = Date.now(), maxRounds = 20 }) {
  const log = [];
  for (let i = 0; i < maxRounds; i++) {
    const state = loadState();
    const round = searchRound(state, profile, now);
    if (round === null) break;
    const all = [...roundNeeds(profile, state, now, round), ...(i === 0 ? jobNeeds(state, profile, loadOverlay(), { kinds: ['careers_page'] }) : [])];
    const needs = all.filter((n) => covered(n.kind));
    for (const n of all) if (!needs.includes(n)) {
      leaveForModel(n, round, now);
      log.push({ round, need: n.kind, ok: false, status: 'model' });
    }
    const results = await runRound(needs, { client });
    for (let k = 0; k < results.length; k++) {
      const r = results[k];
      const need = needs[k];
      if (r.ok) {
        const out = await ingest({ obj: r.ingest, state: loadState(), profile, overlay: loadOverlay(), fetch, now });
        updateState((s) => { s.routed.lastCost = r.cost || s.routed.lastCost; });
        log.push({ round, need: need.kind, ok: true, status: 'fulfilled', added: out.added });
      } else if (r.status === 'no_adapter' && need.kind !== 'web_search') {
        leaveForModel(need, round, now);
        log.push({ round, need: need.kind, ok: false, status: 'model' });
      } else {
        hold(r, now);
        if (need.jobKey) updateState((s) => { if (s.jobs[need.jobKey]) (s.jobs[need.jobKey].routedTried ||= {})[need.kind] = true; });
        log.push({ round, need: need.kind, ok: false, status: r.status });
      }
    }
    // With Tenjin the board search is a routed need like the others: a failed call holds it for the round, with a report line, and never becomes a model step.
    updateState((s) => { s.routed.lastSearchAt = s.routed.lastSearchAt || new Date(now).toISOString(); });
    const next = updateState((s) => (s.search.session ? advanceSearch(s, profile) : { done: true }));
    if (next.done) break;
  }
  return log;
}

// A LinkedIn profile link the person gave as their resume: one routed need, read once, saved as resume.txt with the raw
// result next to it. Any status but fulfilled asks for a PDF export or the text. The skill never opens linkedin.com.
export async function readLinkedIn({ url, client = new RouterClient() }) {
  const need = { kind: 'linkedin_profile', text: fill('linkedin_profile', { url }), fields: { url }, query: { url } };
  const [r] = await runRound([need], { client });
  if (!r.ok) return { ok: false, status: r.status, reason: r.reason };
  return { ok: true, text: r.ingest.text, cost: r.cost };
}

// The router's people search for the jobs asked, in code. First the company: from what code has (a link field, the posting's website,
// a board page's homepage), else with Tenjin a company lookup (one routed need, a free spec first); a domain is saved only after code
// checks it against the company name. Then the people search, by domain or, with no website, by name and city. Held, never retried;
// the free ways stay a Haiku step. Every job it did not search is reported with its reason.
export async function routeContacts({ keys, profile, fetch, client = new RouterClient(), now = Date.now() }) {
  const log = [];
  const skips = [];
  const want = jobNeeds(loadState(), profile, loadOverlay(), { kinds: ['people_search'], keys, skips });
  for (const sk of skips) {
    log.push({ job: sk.key, ok: false, status: 'not_searched', reason: sk.reason });
    updateState((s) => { if (s.jobs[sk.key]) s.jobs[sk.key].contactsStatus = { state: 'not_searched', reason: sk.reason, at: new Date(now).toISOString() }; });
  }
  if (!want.length) return log;
  // 1. the company lookup, for the jobs whose website no field gives
  const lookups = want.filter((n) => !n.fields.website).map((n) => {
    const j = loadState().jobs[n.jobKey];
    // Called by catalog tool id; the input is the name, and the company's LinkedIn page only when the job record has it. The board link
    // and the city are not inputs: they stay code context for the domain check.
    return { kind: 'company_lookup', tool: 'companyenrich-properties', text: null, fields: { jobKey: n.jobKey, company: j.company, linkedinUrl: j.companyLinkedinUrl || j.companyLinkedin || null }, query: null, jobKey: n.jobKey };
  });
  // One `tenjin mcp` process for the lookups and the people search (the search needs the lookup's answer first); closed after.
  try {
    await client.start();
  } catch (e) {
    await client.close();
    const status = e.code === 'tenjin_missing' ? 'tenjin_missing' : 'wallet_unavailable';
    for (const n of want) {
      hold({ need: n.kind, status, reason: e.message }, now, { clock: false });
      updateState((s) => { if (s.jobs[n.jobKey]) s.jobs[n.jobKey].contactsStatus = { state: 'not_searched', reason: `Tenjin could not start (${status})`, at: new Date(now).toISOString() }; });
      log.push({ job: n.jobKey, ok: false, status, reason: e.message });
    }
    return log;
  }
  try {
    for (const n of lookups) {
      const r = await runNeed(client, n);
      if (r.ok) {
        await ingest({ obj: r.ingest, state: loadState(), profile, overlay: loadOverlay(), fetch, now });
        updateState((s) => { s.routed.lastCost = r.cost || s.routed.lastCost; });
        log.push({ job: n.jobKey, ok: true, status: 'company_lookup', website: (loadState().jobs[n.jobKey] || {}).employerWebsite || null });
      } else {
        hold(r, now, { clock: false });
        log.push({ job: n.jobKey, ok: false, status: r.status, step: 'company_lookup' });
      }
    }
    // 2. the people search, with the website now known where it could be found
    const needs = jobNeeds(loadState(), profile, loadOverlay(), { kinds: ['people_search'], keys: want.map((n) => n.jobKey) });
    for (const need of needs) {
      const r = await runNeed(client, need);
      if (r.ok) {
        const out = await ingest({ obj: r.ingest, state: loadState(), profile, overlay: loadOverlay(), fetch, now });
        updateState((s) => { s.routed.lastCost = r.cost || s.routed.lastCost; });
        log.push({ job: need.jobKey, ok: true, contacts: out.contacts, searchedBy: need.fields.website ? 'website' : 'name and city' });
      } else {
        hold(r, now, { clock: false });
        updateState((s) => { if (s.jobs[need.jobKey]) { (s.jobs[need.jobKey].routedTried ||= {})[need.kind] = true; s.jobs[need.jobKey].contactsStatus = { state: 'not_searched', reason: `the search was held (${r.status})`, at: new Date(now).toISOString() }; } });
        log.push({ job: need.jobKey, ok: false, status: r.status });
      }
    }
  } finally {
    await client.close();
  }
  return log;
}
