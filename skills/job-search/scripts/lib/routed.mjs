import { graph } from './graph.mjs';
import { RouterClient, runRound } from './router.mjs';
import { SUPPLIERS } from './suppliers/index.mjs';
import { ingest } from './ingest.mjs';
import { loadState, updateState } from './store.mjs';
import { loadOverlay } from './overlay.mjs';
import { advanceSearch, searchRound, variantFor } from './work.mjs';

// With Tenjin, a search round runs in code, with no model step before review: the needs go to the router one at a time
// (router.mjs), each result is ingested, and the same rule as the model-run rounds decides whether the next role-word
// variant is worth a round. A search that is held (any status but fulfilled, no adapter, a timeout) is named in the
// report; nothing is retried. The web search is answered `native` by the router, so it stays a model step: after each
// round code leaves a `web_search_due` item for it, with no hold reason shown to the person.
const fill = (kind, f) => graph().needTemplates[kind].replace(/\{(\w+)\}/g, (_, k) => (f[k] === undefined ? '' : String(f[k])));
export const needText = (kind, q) => fill(kind, { ...q, role: q.variant || q.role, place: q.place || 'any place' });

const SEARCH_KINDS = ['job_postings', 'x_hiring_posts'];
export function roundNeeds(profile, state, now, round) {
  const since = state.routed && state.routed.lastSearchAt ? new Date(Math.max(Date.parse(state.routed.lastSearchAt) - 86400000, now - 14 * 86400000)) : new Date(now - 14 * 86400000);
  const days = Math.max(1, Math.ceil((now - since.getTime()) / 86400000));
  const base = { role: profile.search.role, place: profile.search.place || '', remote: profile.search.remote === true, since: since.toISOString().slice(0, 10), variant: variantFor(profile, round), round };
  const searchNeeds = SEARCH_KINDS.filter((k) => SUPPLIERS.some((s) => s.kind === k)).map((kind) => ({ kind, text: needText(kind, { ...base, days }), fields: { ...base, days: Math.min(days, 14), role: base.variant || base.role }, query: base }));
  // The web search is asked once per round; the router answers `native` and the model step keeps it.
  const web = { kind: 'web_search', text: needText('web_search', base), fields: base, query: base };
  return [...searchNeeds, web];
}

// Needs for one job: the employer's careers page for a reviewed job with no employer posting, and the people search for a
// job the person asked contacts for. Each is tried once; the model's Haiku step stays as the fallback.
export function jobNeeds(state, profile, overlay) {
  const out = [];
  const count = (() => { const r = (overlay.rules || []).filter((x) => x.effect === 'contact_count').pop(); return r && r.value !== 'all' ? Number(r.value) : undefined; })();
  for (const j of Object.values(state.jobs)) {
    const site = j.employerWebsite;
    if (j.status === 'reviewed' && !j.employerPosting && !j.careersChecked && !(j.routedTried || {}).careers_page && site && ['no_board', 'unconfirmed_board', 'no_match', 'no_apply_link', 'yc_platform_only'].includes(j.unresolved)) {
      out.push({ kind: 'careers_page', text: fill('careers_page', { company: j.company, url: site }), fields: { jobKey: j.key, website: site, company: j.company }, query: null, jobKey: j.key });
    }
  }
  for (const key of state.contactsRequested || []) {
    const j = state.jobs[key];
    if (!j || !j.employerWebsite || (state.contacts[key] || []).length || j.contactsSearched || (j.routedTried || {}).people_search) continue;
    out.push({ kind: 'people_search', text: fill('people_search', { company: j.company, url: j.employerWebsite, where: j.city ? ` in ${j.city}` : '' }), fields: { jobKey: key, website: j.employerWebsite, titles: graph().peopleTitles, city: j.city || '', count }, query: null, jobKey: key });
  }
  return out;
}

// The watcher runs the rounds in code only when the searches that can run in code have adapters; `J route` runs them by hand.
export const allNeedsCovered = () => SEARCH_KINDS.every((k) => SUPPLIERS.some((s) => s.kind === k));

const hold = (r, now) => updateState((s) => {
  if (r.native) return; // a native answer is not a hold: that need stays a model step
  s.held = [...s.held.filter((h) => !String(h.detail).startsWith(`routed:${r.need}:`)), { reason: 'source_empty', detail: `routed:${r.need}: ${r.status}: ${r.reason}` }];
  s.routed.lastSearchAt = new Date(now).toISOString();
  if (r.status === 'wallet_unavailable') s.routed.skipReason = 'wallet_unavailable: run the searches in an attended turn';
});

export async function routedRounds({ profile, fetch, client = new RouterClient(), now = Date.now(), maxRounds = 20 }) {
  const log = [];
  for (let i = 0; i < maxRounds; i++) {
    const state = loadState();
    const round = searchRound(state, profile, now);
    if (round === null) break;
    const needs = [...roundNeeds(profile, state, now, round), ...(i === 0 ? jobNeeds(state, profile, loadOverlay()) : [])];
    if (!needs.some((n) => SEARCH_KINDS.includes(n.kind))) break;
    const results = await runRound(needs, { client });
    for (let k = 0; k < results.length; k++) {
      const r = results[k];
      const need = needs[k];
      if (r.ok) {
        const out = await ingest({ obj: r.ingest, state: loadState(), profile, overlay: loadOverlay(), fetch, now });
        updateState((s) => { s.routed.lastCost = r.cost || s.routed.lastCost; });
        log.push({ round, need: need.kind, ok: true, status: 'fulfilled', added: out.added });
      } else {
        hold(r, now);
        if (need.jobKey) updateState((s) => { if (s.jobs[need.jobKey]) (s.jobs[need.jobKey].routedTried ||= {})[need.kind] = true; });
        log.push({ round, need: need.kind, ok: false, status: r.status });
      }
    }
    // the web search stays a model step: one item per round, until the model records it as done
    updateState((s) => { s.search.webPending = { round, at: new Date(now).toISOString() }; s.routed.lastSearchAt = s.routed.lastSearchAt || new Date(now).toISOString(); });
    const next = updateState((s) => (s.search.session ? advanceSearch(s, profile) : { done: true }));
    if (next.done) break;
  }
  return log;
}
