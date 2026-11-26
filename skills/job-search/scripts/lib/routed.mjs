import { graph } from './graph.mjs';
import { RouterClient, runNeed, runRound } from './router.mjs';
import { SUPPLIERS } from './suppliers/index.mjs';
import { ingest } from './ingest.mjs';
import { loadState, updateState } from './store.mjs';
import { loadOverlay } from './overlay.mjs';
import { advanceSearch, inPeriodSet, searchRound, stillLeft, variantFor } from './work.mjs';
import { companyNames, nameMatches, websiteOf } from './company.mjs';
import { employerName } from './employer.mjs';
import { bigEmployerMatch, isSmall } from './warmpath.mjs';
import { dedupeEvents, filterEvents, matchTargets, planTargets, readPage, saveEvents, windowDays } from './events.mjs';
import { assertEventRead } from './net.mjs';

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
export function jobNeeds(state, profile, overlay, { kinds = ['careers_page', 'people_search'], keys = null, skips = null, now = Date.now() } = {}) {
  const out = [];
  const count = (() => { const r = (overlay.rules || []).filter((x) => x.effect === 'contact_count').pop(); return r && r.value !== 'all' ? Number(r.value) : undefined; })();
  for (const j of kinds.includes('careers_page') ? Object.values(state.jobs) : []) {
    const site = j.employerWebsite;
    // The same jobs the free employer-page step would take: above the score floor, within this period's most, and not left.
    if (j.status === 'reviewed' && !j.employerPosting && !j.careersChecked && !(j.routedTried || {}).careers_page && site && !stillLeft(state, j, overlay, profile) && inPeriodSet(state, j, profile, overlay, now) && ['no_board', 'unconfirmed_board', 'no_match', 'no_apply_link', 'yc_platform_only'].includes(j.unresolved)) {
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


const hold = (r, now, { clock = true } = {}) => updateState((s) => {
  s.held = [...s.held.filter((h) => !String(h.detail).startsWith(`routed:${r.need}:`)), { reason: 'source_empty', detail: `routed:${r.need}: ${r.status}: ${r.reason}` }];
  if (clock) s.routed.lastSearchAt = new Date(now).toISOString();
  if (r.status === 'wallet_unavailable') s.routed.skipReason = 'wallet_unavailable: run the searches in an attended turn';
});

const covered = (kind) => SUPPLIERS.some((x) => x.kind === kind);
// A need code cannot run (no adapter for its kind, or a supplier it does not know) becomes one model item for the round.
const leaveForModel = (need, round, now, routerAnswered) => updateState((s) => {
  s.search.needPending = [...(s.search.needPending || []).filter((n) => n.kind !== need.kind), { kind: need.kind, text: need.text, query: need.query, round, at: new Date(now).toISOString(), ...(routerAnswered ? { routerAnswered: true } : {}) }];
});

const LOCK_MS = 15 * 60 * 1000;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// One routed round at a time: a watcher tick and a `J route` never both pay for the same needs. A lock left by a process that is
// gone, or older than the longest round, is taken over.
function takeLock(now) {
  return updateState((s) => {
    const l = s.routed.roundLock;
    if (l && now - Date.parse(l.at) < LOCK_MS && l.pid !== process.pid && alive(l.pid)) return false;
    s.routed.roundLock = { pid: process.pid, at: new Date(now).toISOString() };
    return true;
  });
}
const dropLock = () => updateState((s) => { if (s.routed.roundLock && s.routed.roundLock.pid === process.pid) s.routed.roundLock = null; });

// Each need runs on its own: one that cannot run in code never stops the others. An uncovered need is left as a Haiku item
// for the round's wake. A paid result is kept in state the moment it arrives and ingested at once, so a run that is killed
// between paying and ingesting finishes the ingest first at the next start and never pays for it again.
export async function routedRounds({ profile, fetch, client = new RouterClient(), now = Date.now(), maxRounds = 20 }) {
  const log = [];
  if (!takeLock(now)) return [{ need: 'round', ok: false, status: 'already_running' }];
  try {
    // 1. a result paid for in an earlier run that was never ingested
    for (const p of loadState().routed.pendingIngest || []) {
      try {
        await ingest({ obj: p.ingest, state: loadState(), profile, overlay: loadOverlay(), fetch, now });
        log.push({ round: p.round, need: p.kind, ok: true, status: 'recovered' });
      } catch (e) {
        hold({ need: p.kind, status: 'ingest_failed', reason: e.message }, now);
        log.push({ round: p.round, need: p.kind, ok: false, status: 'ingest_failed' });
      }
      updateState((s) => { s.routed.pendingIngest = (s.routed.pendingIngest || []).filter((x) => x.at !== p.at || x.kind !== p.kind); });
    }
    for (let i = 0; i < maxRounds; i++) {
      const state = loadState();
      const round = searchRound(state, profile, now);
      if (round === null) break;
      const all = [...roundNeeds(profile, state, now, round), ...(i === 0 ? jobNeeds(state, profile, loadOverlay(), { kinds: ['careers_page'], now }) : [])];
      const needs = all.filter((n) => covered(n.kind));
      for (const n of all) if (!needs.includes(n)) {
        leaveForModel(n, round, now, false);
        log.push({ round, need: n.kind, ok: false, status: 'model' });
      }
      const onResult = async (need, r) => {
        if (r.ok) {
          const mark = { at: new Date().toISOString(), kind: need.kind, round, ingest: r.ingest };
          const keep = r.ingest.fullResultPath !== null; // a supplier whose terms allow immediate use only is never saved
          if (keep) updateState((s) => { (s.routed.pendingIngest ||= []).push(mark); });
          let out;
          try {
            out = await ingest({ obj: r.ingest, state: loadState(), profile, overlay: loadOverlay(), fetch, now });
          } catch (e) {
            // A paid result is never paid for twice: a result that cannot be ingested is held with its reason, the rest of the
            // round goes on, and every attempt on a job's careers lookup counts as tried.
            hold({ need: need.kind, status: 'ingest_failed', reason: e.message }, now);
            if (need.jobKey) updateState((s) => { if (s.jobs[need.jobKey]) (s.jobs[need.jobKey].routedTried ||= {})[need.kind] = true; });
            if (keep) updateState((s) => { s.routed.pendingIngest = (s.routed.pendingIngest || []).filter((x) => x.at !== mark.at); });
            log.push({ round, need: need.kind, ok: false, status: 'ingest_failed' });
            return;
          }
          updateState((s) => {
            s.routed.lastCost = r.cost || s.routed.lastCost;
            if (need.jobKey && s.jobs[need.jobKey]) (s.jobs[need.jobKey].routedTried ||= {})[need.kind] = true;
            if (keep) s.routed.pendingIngest = (s.routed.pendingIngest || []).filter((x) => x.at !== mark.at);
          });
          log.push({ round, need: need.kind, ok: true, status: 'fulfilled', added: out.added });
        } else if (r.status === 'no_adapter' && need.kind !== 'web_search') {
          // The router already answered (and charged its routing fee): the model step must not send it to the router again.
          leaveForModel(need, round, now, true);
          log.push({ round, need: need.kind, ok: false, status: 'model' });
        } else {
          hold(r, now);
          if (need.jobKey) updateState((s) => { if (s.jobs[need.jobKey]) (s.jobs[need.jobKey].routedTried ||= {})[need.kind] = true; });
          log.push({ round, need: need.kind, ok: false, status: r.status });
        }
      };
      await runRound(needs, { client, onResult });
      // With Tenjin the board search is a routed need like the others: a failed call holds it for the round, with a report line, and never becomes a model step.
      updateState((s) => { s.routed.lastSearchAt = s.routed.lastSearchAt || new Date(now).toISOString(); });
      const next = updateState((s) => (s.search.session ? advanceSearch(s, profile) : { done: true }));
      if (next.done) break;
    }
  } finally {
    dropLock();
  }
  return log;
}

// A LinkedIn profile link the person gave as their resume: one routed need, read once, saved as resume.txt with the raw
// result next to it. Any status but fulfilled asks for a PDF export or the text. The skill never opens linkedin.com.
export async function readLinkedIn({ url, client = new RouterClient() }) {
  const need = { kind: 'linkedin_profile', text: fill('linkedin_profile', { url }), fields: { url }, query: { url } };
  const [r] = await runRound([need], { client });
  if (!r.ok) return { ok: false, status: r.status, reason: r.reason };
  return { ok: true, text: r.ingest.text, cost: r.cost, thin: r.ingest.thin !== false, history: r.ingest.history || null, schools: r.ingest.schools || null, titles: r.ingest.titles || [], current: (r.ingest.current || []).map((c) => c.title), headline: r.ingest.headline || null };
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

// "Also worked at" hints for the companies the skill plans to apply to: for each past employer of the person, a company lookup (its
// employee range), then one people search for people now at the target who also worked there. A small past employer (50 or fewer)
// gives a hint with no further check; a big one needs one profile read for each candidate, and a hint only when the dates overlap and
// a team word is shared (code does both). Never read connections; never contact anyone: every hint is a contact marked "also worked at".
export async function routeWarmPaths({ profile, client = new RouterClient(), now = Date.now(), state = loadState() }) {
  const history = profile.resumeHistory || profile.history || [];
  const log = [];
  if (!history.length) return [{ ok: false, reason: 'no_history: the person\'s own employers are not known' }];
  const LIVE = ['shortlisted', 'prepared', 'apply_ready'];
  const targets = new Map();
  for (const j of Object.values(state.jobs)) if (LIVE.includes(j.status) && j.employerPosting && !targets.has(employerName(j.company))) targets.set(employerName(j.company), j);
  const pasts = (target) => [...new Map(history.filter((h) => h && h.company && employerName(h.company) !== employerName(target.company)).map((h) => [employerName(h.company), h.company])).values()];
  const profileReads = new Map();
  for (const target of targets.values()) {
    const found = [];
    for (const past of pasts(target)) {
      const [lk] = await runRound([{ kind: 'company_lookup', tool: 'companyenrich-properties', text: null, fields: { jobKey: target.key, company: past }, query: null, jobKey: target.key }], { client });
      const named = lk.ok && lk.ingest.name && nameMatches(lk.ingest.name, past) ? lk.ingest : null;
      const small = named ? isSmall(named.employees) : false;
      const [ps] = await runRound([{ kind: 'people_search', text: fill('people_search', { company: target.company, url: target.employerWebsite || '', where: '' }), fields: { jobKey: target.key, website: target.employerWebsite || null, company: target.company, names: companyNames(target), pastCompany: past, city: '', count: 25 }, query: null, jobKey: target.key }], { client });
      if (!ps.ok) { log.push({ company: target.company, past, ok: false, status: ps.status }); continue; }
      for (const c of ps.ingest.contacts || []) {
        if (small) { found.push({ name: c.name, title: c.title, url: c.sourceUrl, pastCompany: past, basis: 'small employer' }); continue; }
        if (!profileReads.has(c.sourceUrl)) {
          const [pr] = await runRound([{ kind: 'linkedin_profile', text: fill('linkedin_profile', { url: c.sourceUrl }), fields: { url: c.sourceUrl }, query: { url: c.sourceUrl } }], { client });
          profileReads.set(c.sourceUrl, pr.ok ? pr.ingest.history || [] : []);
        }
        const m = bigEmployerMatch(history, profileReads.get(c.sourceUrl), past, now);
        if (m) found.push({ name: c.name, title: c.title, url: c.sourceUrl, pastCompany: past, basis: `same team (${m.team}) and overlapping dates` });
      }
      log.push({ company: target.company, past, ok: true, small, hints: found.length });
    }
    updateState((s) => { (s.alsoWorked ||= {})[employerName(target.company)] = { company: target.company, hints: found, at: new Date(now).toISOString() }; });
  }
  return log;
}

// Events through the router: for each target company, the web search by catalog tool id (event domains in the filter) and the X posts that
// mention a meetup, talk or hackathon by the company. A Luma page a result links is read in code and confirmed on its own page; every
// other page is left for the model's fetch. The LinkedIn posts needs have no recorded supplier, so they are not run (a hint moment).
// Post text is data: kept as a short quote, never used as an event or put into a field.
// The LinkedIn profile links of the key people found for a target company, each once.
const peopleLinks = (state, t) => [...new Set(Object.entries(state.contacts || {}).filter(([jobKey]) => state.jobs[jobKey] && employerName(state.jobs[jobKey].company) === employerName(t.company)).flatMap(([, list]) => (list || []).map((c) => c.sourceUrl)).filter((u) => /^https:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/in\/[^/?#\s]+/i.test(String(u || ''))))];

export async function routeEvents({ profile, overlay, client = new RouterClient(), fetch, sleep, now = Date.now(), state = loadState() }) {
  const targets = planTargets(state, profile);
  const lines = [];
  if (!targets.length) return { added: 0, lines: ['events: no target company yet'] };
  const place = (profile.search || {}).place || '';
  const since = new Date(now).toISOString().slice(0, 10);
  const needs = targets.flatMap((t) => [
    { kind: 'event_web', tool: 'exa-search', text: null, fields: { company: t.company, place }, query: null, company: t },
    { kind: 'event_posts_x', text: fill('event_posts_x', { company: t.company }), fields: { company: t.company, place, since }, query: { company: t.company }, company: t },
    { kind: 'event_posts_linkedin', tool: 'anyapi-linkedin-search-posts', text: null, fields: { company: t.company }, query: null, company: t },
    // the key people's own posts, from the profile links the contacts flow found; one page each, never a link the skill opens
    ...peopleLinks(state, t).map((url) => ({ kind: 'event_posts_people', tool: 'anyapi-linkedin-author-posts', text: null, fields: { url }, query: null, company: t })),
  ]);
  const results = await runRound(needs, { client });
  const pace = { n: 0 };
  const items = [];
  const pages = [];
  const clean = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  for (let k = 0; k < results.length; k++) {
    const r = results[k];
    const t = needs[k].company;
    if (!r.ok) { lines.push(`events: ${needs[k].kind} for ${t.company} held (${r.status})`); continue; }
    const urls = needs[k].kind === 'event_web' ? r.ingest.results.map((x) => ({ url: x.url, title: x.title })) : r.ingest.posts.flatMap((p) => (p.links || []).map((u) => ({ url: u, quote: clean(p.text), author: p.author })));
    for (const u of urls) {
      let readable = true;
      try { assertEventRead(u.url); } catch { readable = false; }
      if (!readable || !/^https:\/\/luma\.com\//.test(u.url)) { if (/^https:\/\//.test(u.url)) pages.push({ company: t.company, url: u.url, title: clean(u.title) }); continue; }
      const page = await readPage(u.url, 'luma', { fetch, sleep, state: pace });
      if (!page.ok) { lines.push(`events: ${u.url} skipped (${page.why})`); continue; }
      for (const e of filterEvents(page.parsed.events, { now, days: windowDays(overlay), place })) {
        const matches = matchTargets(e, targets);
        if (!matches.length && needs[k].kind === 'event_web') matches.push({ company: t.company, how: 'search' });
        if (!matches.length && needs[k].kind === 'event_posts_people') matches.push({ company: t.company, how: 'person_post' });
        if (!matches.length) continue;
        items.push({ event: { ...e, pageConfirmed: true, ...(u.quote ? { quote: u.quote } : {}) }, matches, status: matches.some((m) => m.how === 'organizer') ? 'confirmed' : 'candidate' });
      }
    }
  }
  const added = updateState((s) => { const n = saveEvents(s, dedupeEvents(items.map((i) => i.event)).map((e) => items.find((i) => i.event.id === e.id)), now); (s.events.pages = [...(s.events.pages || []), ...pages].filter((p, i, a) => a.findIndex((x) => x.url === p.url) === i)); return n; });
  return { added, pages: pages.length, lines };
}
