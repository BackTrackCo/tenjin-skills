import { graph } from './graph.mjs';
import { RouterClient, runRound } from './router.mjs';
import { registerReplay } from './repairs.mjs';
import { loadState, updateState } from './store.mjs';
import { capOf, loadOverlay } from './overlay.mjs';
import { readProfile } from './profile.mjs';
import { postNeedKinds, centsOf } from './prices.mjs';
import { addPosts, linkIdentity } from './dedupe.mjs';
import { countryFrom } from './geo.mjs';
import { linkedinSlugOf } from './platforms.mjs';
import { offersOf, phrasePairs, liveHeld } from './offers.mjs';
import { codeId } from './codeid.mjs';
import { xQuery, redditQuery, linkedinQuery, webDescription } from './queries.mjs';
import { checkQuery } from './querycheck.mjs';
import { activeOf, querySetOf, outcomeOf, labelOf, retireStale } from './queryset.mjs';

// Searches and lookups run in code in the watcher, because their inputs are fixed by code, so a model step would cost Claude usage
// and add no judgment. Each need is sent to the router as plain text and the router picks the seller and applies the person's
// limits. The skill names no seller and pins no tool. A need the router or an adapter cannot serve is held with its reason, and
// held needs are listed in the report, never retried inside the same round.
const DAY = 86400000;

export function fillNeed(kind, fields) {
  const t = graph().needs[kind];
  if (!t) throw new Error(`unknown need: ${kind}`);
  for (const f of t.fields) if (fields[f] === undefined || fields[f] === null || String(fields[f]).trim() === '') throw new Error(`the ${kind} need has no ${f}`);
  const text = t.text.replace(/\{(\w+)\}/g, (_, k) => String(fields[k] ?? ''));
  return { kind, text, fields: { ...fields }, query: fields.phrase || fields.query || fields.handle || fields.url || fields.domain || fields.email || fields.industry || null };
}

export const sinceOf = (state, now, maxDays = graph().sweep.maxDaysBack) => {
  const last = state.routed && state.routed.lastSearchAt ? Date.parse(state.routed.lastSearchAt) : 0;
  return new Date(Math.max(last, now - maxDays * DAY)).toISOString().slice(0, 10);
};

// One need per source per offer when the person has a stored query for it (written by the model in an attended turn, checked by code
// before every run); otherwise one need per phrase per source, in the query shape code builds (key words and that source's operators).
// An offer's Reddit need searches inside its own list of subreddits; an offer with none has no Reddit need and says so. The person's
// own caps cut the list: phrases per round (built queries only), searches per day.
const SRC_OF = { x_posts: 'x', reddit_posts: 'reddit', linkedin_posts: 'linkedin', web_research: 'web' };
export const queryLabel = (offerId, src) => `query:${offerId}:${src}`;
function builtNeed(kind, offer, phrase, base) {
  if (kind === 'x_posts') return fillNeed(kind, { ...base, phrase, query: xQuery(phrase) });
  if (kind === 'reddit_posts') return offer.subreddits.length ? fillNeed(kind, { ...base, phrase, query: redditQuery(phrase), subreddits: offer.subreddits.join(', ') }) : null;
  if (kind === 'linkedin_posts') return fillNeed(kind, { ...base, phrase, query: linkedinQuery(phrase) });
  return fillNeed(kind, { ...base, phrase, query: webDescription(offer, phrase), mode: 'discussion' });
}
export function queryRefusals(profile, state = null) {
  const out = [];
  for (const q of querySetOf(profile, state)) {
    if (q.status !== 'active') continue;
    const o = offersOf(profile).find((x) => x.id === q.offerId);
    const bad = checkQuery(q.source, q.text, o);
    if (bad.length) out.push({ offerId: q.offerId, src: q.source, id: q.id, bad });
  }
  return out;
}
const rank = (state, n) => (n.priority.pinned ? 1e6 : 0) + (n.priority.kept || 0) * 100 - (n.priority.age || 0);
export function postNeeds({ profile, overlay, state, now = Date.now() }) {
  const kinds = postNeedKinds(profile.sources);
  const since = sinceOf(state, now);
  const cap = capOf(overlay, 'phrases_per_round');
  const active = activeOf(profile, state);
  let needs = [];
  for (const offer of offersOf(profile)) {
    for (const kind of kinds) {
      const src = SRC_OF[kind];
      const base = { since, offerId: offer.id };
      const set = active.filter((q) => q.offerId === offer.id && q.source === src);
      if (set.length) {
        // Every active query runs, the person's own and pinned ones first, then the ones that kept the most.
        for (const q of set) {
          if (checkQuery(src, q.text, offer).length) continue; // refused: named in a held line
          const f = { ...base, phrase: labelOf(q.id), query: q.text };
          if (kind === 'reddit_posts') f.subreddits = offer.subreddits.join(', ');
          if (kind === 'web_research') f.mode = 'discussion';
          const n = fillNeed(kind, f);
          n.priority = { pinned: q.pinned, kept: outcomeOf(state, labelOf(q.id)).kept, age: q.addedAt ? Date.parse(q.addedAt) / 1e11 : 0 };
          needs.push(n);
        }
      } else {
        for (const phrase of offer.phrases.slice(0, cap || undefined)) { const n = builtNeed(kind, offer, phrase, base); if (n) { n.priority = { pinned: false, kept: 0, age: 0 }; needs.push(n); } }
      }
    }
  }
  needs.sort((a, b) => rank(state, b) - rank(state, a));
  // The person's own caps: searches per round, then searches per day.
  const perRound = capOf(overlay, 'searches_per_round');
  if (perRound !== null) needs = needs.slice(0, perRound);
  const perDay = capOf(overlay, 'searches_per_day');
  if (perDay !== null) {
    const today = (state.spend || []).filter((s) => now - Date.parse(s.at) < DAY && s.search).length;
    needs = needs.slice(0, Math.max(0, perDay - today));
  }
  return needs;
}

// The subreddits of an offer: a Reddit post from outside the list is dropped in code, so no list drops every Reddit post.
export const subsOf = (profile, offerId) => (offersOf(profile).find((o) => o.id === offerId) || offersOf(profile)[0] || { subreddits: [] }).subreddits;

// The offers that want Reddit but have no subreddits yet.
export const noSubreddits = (profile) => (postNeedKinds(profile.sources).includes('reddit_posts') ? offersOf(profile).filter((o) => o.phrases.length && !o.subreddits.length) : []);

const heldKey = (need) => `need:${need.kind}:${need.query || ''}`;
export function recordHeld(state, need, r) {
  const key = heldKey(need);
  state.held = state.held.filter((h) => h.key !== key);
  state.held.push({ key, reason: 'need_held', status: r.status, codeId: codeId(), detail: `${need.kind}${need.query ? ` (${need.query})` : ''}: ${r.reason}` });
}
export const clearHeld = (state, need) => { state.held = state.held.filter((h) => h.key !== heldKey(need)); };

// A whole round of post searches: one process, the needs one at a time. A paid result is kept at once, before the next need starts.
const is404 = (r) => /\b404\b/.test(`${r.status} ${r.reason}`) || r.status === 'not_found';
const nextDay = (now) => { const d = new Date(now); d.setHours(24, 0, 0, 0); return d.toISOString(); };
const SRC_NAME = { x_posts: 'x', reddit_posts: 'reddit', linkedin_posts: 'linkedin', web_research: 'web' };

// The per-round funnel, per source: what the seller returned, what each code filter dropped, what went to review.
export const FUNNEL_DROPS = ['link_only', 'not_an_ask', 'not_discussion', 'outside_subreddits', 'too_old', 'duplicate'];
export function funnelAdd(state, source, { returned = 0, dropped = [], repeated = 0, tooOld = 0, toReview = 0, searches = 1 }) {
  const f = ((state.funnel ||= { at: null, sources: {} }).sources[source] ||= { searches: 0, returned: 0, toReview: 0, ...Object.fromEntries(FUNNEL_DROPS.map((k) => [k, 0])) });
  f.searches += searches; f.returned += returned; f.toReview += toReview; f.duplicate += repeated; f.too_old += tooOld;
  for (const x of dropped) { const k = x.reason.replace(/:.*$/, ''); if (k in f) f[k] += 1; }
}

// A paid post search that answers 404 is empty for that day: held with that reason, and not run again until the next day's round.
const skippedToday = (state, need, now) => (state.held || []).some((h) => h.key === heldKey(need) && h.skipUntil && Date.parse(h.skipUntil) > now);

// One post search's result, into state: a held need is recorded (a paid 404 counts as empty for the day), a good one is added, counted
// and paid for. Used by the round and by a repair that re-reads a saved answer. Returns how many leads were added.
export function ingestPostResult(state, need, r, { profile, overlay, now }) {
  if (!r.ok) {
    recordHeld(state, need, r);
    if (is404(r)) {
      const h = state.held.find((x) => x.key === heldKey(need));
      Object.assign(h, { status: 'empty_404', skipUntil: nextDay(now), detail: `${need.kind} (${need.query}): the seller answered 404, counted as empty for today and not run again until the next round` });
      recordYield(state, need, 0, 0, now);
      funnelAdd(state, SRC_NAME[need.kind] || need.kind, {});
    }
    return 0;
  }
  clearHeld(state, need);
  const res = addPosts(state, r.ingest.posts, { profile, overlay, phrase: need.query, offerId: need.fields.offerId || null, subreddits: subsOf(profile, need.fields.offerId), now, cap: capOf(overlay, 'leads_per_round') === null ? null : Math.max(0, capOf(overlay, 'leads_per_round') - state.search.roundAdded) });
  state.search.roundAdded += res.added.length;
  recordYield(state, need, r.ingest.posts.length + (r.ingest.droppedOld || 0), res.added.length, now, { dropped: res.dropped, repeated: res.repeated, tooOld: r.ingest.droppedOld || 0 });
  funnelAdd(state, SRC_NAME[need.kind] || need.kind, { returned: r.ingest.posts.length + (r.ingest.droppedOld || 0), dropped: res.dropped, repeated: res.repeated, tooOld: r.ingest.droppedOld || 0, toReview: res.added.length });
  const y = (state.phraseYield[need.query] ||= {});
  for (const k of res.added) y[state.leads[k].source] = (y[state.leads[k].source] || 0) + 1;
  state.spend.push({ at: new Date(now).toISOString(), kind: need.kind, cents: centsOf(r.cost), cost: r.cost, leads: res.added.length, search: true });
  if (need.kind === 'web_research') {
    const w = (state.webTally ||= { tooOld: 0, undated: 0 });
    w.tooOld += r.ingest.droppedOld || 0;
    w.undated += r.ingest.undated || 0;
  }
  return res.added.length;
}
// A repaired mapping re-reads the saved answer of a post search the round held: the same ingest, no new call.
for (const kind of ['x_posts', 'reddit_posts', 'linkedin_posts', 'web_research']) {
  registerReplay(kind, (state, need, r, { now }) => {
    const n = ingestPostResult(state, need, r, { profile: readProfile(), overlay: loadOverlay(), now });
    return `re-read the saved answer: ${r.ingest.posts.length} posts, ${n} new lead${n === 1 ? '' : 's'}`;
  });
}

// `only`: the held key of one need (G search route --need "<key>"): that search only, whatever it was held for, and the round's
// schedule is left alone.
export async function runPostRound({ profile, overlay, client = new RouterClient(), now = Date.now(), save, only = null }) {
  const roundsCap = capOf(overlay, 'rounds_per_day');
  if (!only && roundsCap !== null && (loadState().rounds || []).filter((r) => now - Date.parse(r.at) < DAY).length >= roundsCap) return { skipped: 'rounds_per_day', needs: 0, added: 0 };
  if (!only) updateState((s) => { retireStale(s, profile, now); });
  let needs = postNeeds({ profile, overlay, state: loadState(), now });
  if (only) {
    needs = needs.filter((n) => heldKey(n) === only);
    if (!needs.length) throw new Error(`no search has the key ${only}: use a key from G report --all`);
  } else needs = needs.filter((n) => !skippedToday(loadState(), n, now));
  updateState((s) => {
    s.held = liveHeld(s.held, profile);
    s.held = s.held.filter((h) => h.status !== 'query_refused');
    for (const r of queryRefusals(profile, s)) s.held.push({ key: `need:query:${r.id}`, reason: 'need_held', status: 'query_refused', codeId: codeId(), detail: `the ${r.src} query ${r.id} was refused: ${r.bad.join('; ')}. Remove it (G queries remove) or add a corrected variant (G queries add)` });
    if (!only) { s.search.roundAdded = 0; s.funnel = { at: new Date(now).toISOString(), sources: (s.funnel && s.funnel.sources && s.funnel.sources.hn) ? { hn: s.funnel.sources.hn } : {} }; }
    for (const o of noSubreddits(profile)) { s.held = s.held.filter((h) => h.key !== `need:reddit_posts:${o.id}`); s.held.push({ key: `need:reddit_posts:${o.id}`, reason: 'need_held', status: 'no_subreddits', codeId: codeId(), detail: `reddit_posts (${o.name || o.id}): no subreddits yet, so Reddit is not searched for this offer` }); }
  });
  let added = 0;
  const out = await runRound(needs, {
    client, save,
    onResult: (need, r) => updateState((state) => { added += ingestPostResult(state, need, r, { profile, overlay, now }); }),
  });
  if (!only) {
    updateState((state) => {
      state.routed.lastSearchAt = new Date(now).toISOString();
      state.search.lastAt = state.routed.lastSearchAt;
      state.rounds.push({ at: state.routed.lastSearchAt, needs: needs.length, ok: out.filter((r) => r.ok).length, added });
      if (state.spend.length > 600) state.spend.splice(0, state.spend.length - 600);
      if (state.rounds.length > 200) state.rounds.splice(0, state.rounds.length - 200);
    });
  }
  return { needs: needs.length, ok: out.filter((r) => r.ok).length, held: out.filter((r) => !r.ok).map((r) => ({ need: r.need, status: r.status, reason: r.reason })), added };
}

// ---- the identity reads ----------------------------------------------------------------------------------------------
// For every kept lead: the X or LinkedIn profile, because the country and company feed the email gates. A profile link inside the
// answer is evidence that links an identity (never a guess).
export function identityNeed(state, lead) {
  const p = state.people[lead.personKey];
  if (!p) return null;
  const x = p.ids.find((i) => i.startsWith('x:'));
  const li = p.ids.find((i) => i.startsWith('linkedin:'));
  if (li) return fillNeed('linkedin_profile', { url: `https://www.linkedin.com/in/${li.slice(9)}` });
  if (x) return fillNeed('x_profile', { handle: x.slice(2) });
  return null;
}

export function applyIdentity(state, lead, result) {
  const p = state.people[lead.personKey];
  if (!p) return;
  if (result.name && !p.name) p.name = result.name;
  if (result.company && !p.company) p.company = result.company;
  const country = countryFrom(result.location);
  if (country && !p.country) p.country = country;
  for (const l of result.links || []) {
    const slug = linkedinSlugOf(l);
    if (slug) linkIdentity(state, p.key, `linkedin:${slug}`, 'x_profile_link');
  }
  lead.identityRead = true;
}

// One profile read, into state: a held read marks the lead, a good one fills the person and is paid for.
export function ingestIdentityResult(s, lead, need, r, now) {
  if (!r.ok) {
    lead.identityHeld = r.status;
    return recordHeld(s, need, r);
  }
  clearHeld(s, need);
  delete lead.identityHeld;
  applyIdentity(s, lead, r.ingest);
  s.spend.push({ at: new Date(now).toISOString(), kind: need.kind, cents: centsOf(r.cost), cost: r.cost, leads: 0 });
}
for (const kind of ['x_profile', 'linkedin_profile']) {
  registerReplay(kind, (state, need, r, { now }) => {
    const lead = Object.values(state.leads).find((l) => l.identityHeld && !l.identityRead && (identityNeed(state, l) || {}).text === need.text);
    if (!lead) return 'the lead is gone: nothing to fill';
    ingestIdentityResult(state, lead, need, r, now);
    return 're-read the saved profile and filled the lead';
  });
}

export async function runIdentityReads({ client = new RouterClient(), now = Date.now(), save } = {}) {
  const state = loadState();
  const todo = Object.values(state.leads).filter((l) => l.status === 'reviewed' && !l.identityRead && !l.identityHeld).map((l) => ({ lead: l, need: identityNeed(state, l) }));
  const withNeed = todo.filter((t) => t.need);
  updateState((s) => { for (const t of todo.filter((x) => !x.need)) s.leads[t.lead.key].identityRead = true; });
  if (!withNeed.length) return { reads: 0 };
  const byNeed = new Map(withNeed.map((t) => [t.need.text, t.lead.key]));
  const out = await runRound(withNeed.map((t) => t.need), {
    client, save,
    onResult: (need, r) => updateState((s) => {
      const lead = s.leads[byNeed.get(need.text)];
      if (lead) ingestIdentityResult(s, lead, need, r, now);
    }),
  });
  return { reads: out.length, ok: out.filter((r) => r.ok).length };
}

// How many leads each query found and kept, per round and in total. A query that kept nothing for a round is named in the report and
// waits for the person's yes on a rewrite: nothing is rewritten by itself.
export const yieldKey = (need) => (String(need.query).startsWith('query:') ? need.query : `${need.fields.offerId || 'main'}:${SRC_OF[need.kind] || need.kind}:${need.query}`);
export function recordYield(state, need, found, kept, now, { dropped = [], repeated = 0, tooOld = 0 } = {}) {
  const y = ((state.queryYield ||= {})[yieldKey(need)] ||= { offerId: need.fields.offerId || null, source: SRC_OF[need.kind] || need.kind, stored: String(need.query).startsWith('query:'), label: need.query, rounds: 0, found: 0, kept: 0, lastFound: 0, lastKept: 0, lastAt: null, passed: {}, history: [] });
  y.rounds += 1; y.found += found; y.kept += kept; y.lastFound = found; y.lastKept = kept; y.lastAt = new Date(now).toISOString();
  const drops = {};
  for (const x of dropped) { const k = x.reason.replace(/:.*$/, ''); drops[k] = (drops[k] || 0) + 1; }
  if (repeated) drops.duplicate = repeated;
  if (tooOld) drops.too_old = tooOld;
  y.passed ||= {};
  for (const [k, n] of Object.entries(drops)) y.passed[k] = (y.passed[k] || 0) + n; // what each filter dropped, in total
  (y.history ||= []).push({ at: y.lastAt, results: found, dropped: drops, toReview: kept });
  if (y.history.length > 20) y.history.splice(0, y.history.length - 20);
}
