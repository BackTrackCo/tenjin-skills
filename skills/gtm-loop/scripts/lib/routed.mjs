import { graph } from './graph.mjs';
import { RouterClient, runRound } from './router.mjs';
import { loadState, updateState } from './store.mjs';
import { capOf } from './overlay.mjs';
import { postNeedKinds, centsOf } from './prices.mjs';
import { addPosts, linkIdentity } from './dedupe.mjs';
import { countryFrom } from './geo.mjs';
import { linkedinSlugOf } from './platforms.mjs';
import { offersOf, phrasePairs } from './offers.mjs';
import { xQuery, redditQuery, linkedinQuery, webQuery } from './queries.mjs';

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

// One need per phrase per source, each in the query shape of its source (key words and that source's operators, never the raw phrase).
// An offer's Reddit need searches inside its own list of subreddits; an offer with none has no Reddit need and says so. The person's
// own caps cut the list: phrases per round, searches per day.
export function postNeeds({ profile, overlay, state, now = Date.now() }) {
  const kinds = postNeedKinds(profile.sources);
  const since = sinceOf(state, now);
  let needs = [];
  for (const { offer, phrase } of phrasePairs(profile, capOf(overlay, 'phrases_per_round'))) {
    const base = { since, phrase, offerId: offer.id };
    for (const kind of kinds) {
      if (kind === 'x_posts') needs.push(fillNeed(kind, { ...base, query: xQuery(phrase) }));
      else if (kind === 'reddit_posts') { if (offer.subreddits.length) needs.push(fillNeed(kind, { ...base, query: redditQuery(phrase), subreddits: offer.subreddits.join(', ') })); }
      else if (kind === 'linkedin_posts') needs.push(fillNeed(kind, { ...base, query: linkedinQuery(phrase) }));
      else needs.push(fillNeed(kind, { ...base, query: webQuery(phrase), mode: 'discussion' }));
    }
  }
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
  state.held.push({ key, reason: 'need_held', status: r.status, detail: `${need.kind}${need.query ? ` (${need.query})` : ''}: ${r.reason}` });
}
export const clearHeld = (state, need) => { state.held = state.held.filter((h) => h.key !== heldKey(need)); };

// A whole round of post searches: one process, the needs one at a time. A paid result is kept at once, before the next need starts.
export async function runPostRound({ profile, overlay, client = new RouterClient(), now = Date.now(), save }) {
  const roundsCap = capOf(overlay, 'rounds_per_day');
  if (roundsCap !== null && (loadState().rounds || []).filter((r) => now - Date.parse(r.at) < DAY).length >= roundsCap) return { skipped: 'rounds_per_day', needs: 0, added: 0 };
  const needs = postNeeds({ profile, overlay, state: loadState(), now });
  updateState((s) => {
    s.search.roundAdded = 0;
    for (const o of noSubreddits(profile)) { s.held = s.held.filter((h) => h.key !== `need:reddit_posts:${o.id}`); s.held.push({ key: `need:reddit_posts:${o.id}`, reason: 'need_held', status: 'no_subreddits', detail: `reddit_posts (${o.name || o.id}): no subreddits yet, so Reddit is not searched for this offer` }); }
  });
  let added = 0;
  const out = await runRound(needs, {
    client, save,
    onResult: (need, r) => updateState((state) => {
      if (!r.ok) return recordHeld(state, need, r);
      clearHeld(state, need);
      const res = addPosts(state, r.ingest.posts, { profile, overlay, phrase: need.query, offerId: need.fields.offerId || null, subreddits: subsOf(profile, need.fields.offerId), now, cap: capOf(overlay, 'leads_per_round') === null ? null : Math.max(0, capOf(overlay, 'leads_per_round') - state.search.roundAdded) });
      state.search.roundAdded += res.added.length;
      added += res.added.length;
      const y = (state.phraseYield[need.query] ||= {});
      for (const k of res.added) y[state.leads[k].source] = (y[state.leads[k].source] || 0) + 1;
      state.spend.push({ at: new Date(now).toISOString(), kind: need.kind, cents: centsOf(r.cost), cost: r.cost, leads: res.added.length, search: true });
    }),
  });
  updateState((state) => {
    state.routed.lastSearchAt = new Date(now).toISOString();
    state.search.lastAt = state.routed.lastSearchAt;
    state.rounds.push({ at: state.routed.lastSearchAt, needs: needs.length, ok: out.filter((r) => r.ok).length, added });
    if (state.spend.length > 600) state.spend.splice(0, state.spend.length - 600);
    if (state.rounds.length > 200) state.rounds.splice(0, state.rounds.length - 200);
  });
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
      if (!lead) return;
      if (!r.ok) {
        lead.identityHeld = r.status;
        return recordHeld(s, need, r);
      }
      clearHeld(s, need);
      applyIdentity(s, lead, r.ingest);
      s.spend.push({ at: new Date(now).toISOString(), kind: need.kind, cents: centsOf(r.cost), cost: r.cost, leads: 0 });
    }),
  });
  return { reads: out.length, ok: out.filter((r) => r.ok).length };
}
