import { offersOf } from './offers.mjs';
import { checkQuery, SOURCES } from './querycheck.mjs';

// A set of queries per offer and source, not one. Each records its author (the person or the model), when it was added, whether it is
// pinned, whether it is active or retired, and its counts per round (kept in state.queryYield by its label). The person's own query
// (`G queries set`, stored in the profile) is pinned and never retires. A variant the model adds (`G queries add`, stored in state)
// retires in code when it kept nothing for two rounds, unless pinned. The model writes variants only from the offer, the phrases and
// the count table code prints (`queriesTable`): never from a post, a sample or any tool text.
export const RETIRE_AFTER_ROUNDS = 2;
export const KEPT = ['reviewed', 'drafted', 'picked', 'approved', 'contacted', 'replied'];
export const labelOf = (id) => `query:${id}`;

// Every query of every offer: the person's per-source queries from the profile, then the set in state.
export function querySetOf(profile, state) {
  const out = [];
  for (const o of offersOf(profile)) {
    for (const [src, text] of Object.entries(o.queries || {})) out.push({ id: `${o.id}:${src}`, offerId: o.id, source: src, text, author: 'person', addedAt: null, pinned: true, status: 'active', fromProfile: true });
  }
  const offerIds = new Set(offersOf(profile).map((o) => o.id));
  for (const q of Object.values((state && state.queries) || {})) if (offerIds.has(q.offerId)) out.push({ ...q, fromProfile: false });
  return out;
}
export const activeOf = (profile, state) => querySetOf(profile, state).filter((q) => q.status === 'active');

// What came of a query: leads kept by review, sent and replied, and leads still waiting for review.
export function outcomeOf(state, label) {
  const mine = Object.values(state.leads).filter((l) => (l.phrases || [l.phrase]).includes(label) || l.phrase === label);
  return {
    toReview: mine.length,
    kept: mine.filter((l) => KEPT.includes(l.status)).length,
    sent: mine.filter((l) => ['contacted', 'replied'].includes(l.status)).length,
    replied: mine.filter((l) => l.status === 'replied').length,
    pending: mine.filter((l) => l.status === 'new').length,
  };
}

export function addQuery(state, profile, { offerId, source, text, author = 'model', pinned = false, now = Date.now() }) {
  const offer = offersOf(profile).find((o) => o.id === offerId);
  if (!offer) throw new Error(`no offer with id ${offerId}`);
  if (!SOURCES.includes(source)) throw new Error(`source is one of ${SOURCES.join(', ')}`);
  if (!['model', 'person'].includes(author)) throw new Error('author is model or person');
  const bad = checkQuery(source, text, offer);
  if (bad.length) throw new Error(`refused, rewrite: ${bad.join('; ')}`);
  const all = querySetOf(profile, state);
  if (all.some((q) => q.offerId === offerId && q.source === source && q.text.trim().toLowerCase() === text.trim().toLowerCase() && q.status === 'active')) throw new Error('that query is already in the set');
  state.queries ||= {};
  state.queryCounter = (state.queryCounter || 0) + 1;
  const id = `${offerId}:${source}:${state.queryCounter}`;
  state.queries[id] = { id, offerId, source, text: text.trim(), author, addedAt: new Date(now).toISOString(), pinned: Boolean(pinned) || author === 'person', status: 'active', addedRound: (state.rounds || []).length };
  return state.queries[id];
}

function stateQuery(state, id) {
  const q = (state.queries || {})[id];
  if (!q) throw new Error(`no query with id ${id} (a query from G queries set is changed with G queries set)`);
  return q;
}
export function removeQuery(state, id, now = Date.now()) {
  const q = stateQuery(state, id);
  q.status = 'retired';
  q.retiredAt = new Date(now).toISOString();
  q.retiredWhy = 'removed by the person';
  return q;
}
export function pinQuery(state, id, pinned) {
  const q = stateQuery(state, id);
  q.pinned = pinned;
  return q;
}

// Retire in code: a model query that kept nothing for two rounds, and has no lead still waiting for review. A person's query or a
// pinned one never retires.
export function retireStale(state, profile, now = Date.now()) {
  const gone = [];
  for (const q of Object.values(state.queries || {})) {
    if (q.status !== 'active' || q.pinned || q.author === 'person') continue;
    const y = (state.queryYield || {})[labelOf(q.id)];
    if (!y || y.rounds < RETIRE_AFTER_ROUNDS) continue;
    const o = outcomeOf(state, labelOf(q.id));
    if (o.kept > 0 || o.pending > 0) continue;
    q.status = 'retired';
    q.retiredAt = new Date(now).toISOString();
    q.retiredWhy = `kept nothing for ${y.rounds} round${y.rounds === 1 ? '' : 's'}`;
    state.held = (state.held || []).filter((h) => h.key !== `need:${{ x: 'x_posts', reddit: 'reddit_posts', linkedin: 'linkedin_posts', web: 'web_research' }[q.source]}:${labelOf(q.id)}`);
    gone.push(q.id);
  }
  return gone;
}

// Offers and sources where no query kept a lead, a round has run, nothing waits for review and no variant is waiting for its first run.
export function needVariants(state, profile) {
  const out = [];
  const all = querySetOf(profile, state);
  for (const o of offersOf(profile)) {
    if (!o.phrases.length) continue;
    for (const src of SOURCES) {
      if (profile.sources && !profile.sources.includes(src)) continue;
      const mine = all.filter((q) => q.offerId === o.id && q.source === src);
      const ran = (state.funnel && state.funnel.sources && state.funnel.sources[src]) || null;
      const leadsOf = Object.values(state.leads).filter((l) => l.offerId === o.id && l.source === src);
      if (!ran && !Object.values((state.queryYield || {})).some((y) => y.offerId === o.id && y.source === src)) continue;
      if (leadsOf.some((l) => KEPT.includes(l.status) || l.status === 'new')) continue;
      if (mine.some((q) => q.status === 'active' && !((state.queryYield || {})[labelOf(q.id)] || { rounds: 0 }).rounds && !q.fromProfile)) continue; // an added variant has not run yet
      out.push({ offerId: o.id, source: src });
    }
  }
  return out;
}

// The table the model works from: the query text and the counts, and nothing from a post.
export function queriesTable(state, profile) {
  const rows = querySetOf(profile, state);
  return offersOf(profile).map((o) => ({
    id: o.id, name: o.name, what: o.what, who: o.who, phrases: o.phrases,
    needVariants: needVariants(state, profile).filter((n) => n.offerId === o.id).map((n) => n.source),
    queries: rows.filter((q) => q.offerId === o.id).map((q) => {
      const y = (state.queryYield || {})[labelOf(q.id)] || {};
      const oc = outcomeOf(state, labelOf(q.id));
      return { id: q.id, source: q.source, text: q.text, author: q.author, addedAt: q.addedAt, pinned: q.pinned, status: q.status, retiredWhy: q.retiredWhy || null, rounds: y.rounds || 0, results: y.found || 0, passed: y.passed || {}, toReview: oc.toReview, kept: oc.kept, sent: oc.sent, replied: oc.replied, perRound: (y.history || []).slice(-5) };
    }),
  }));
}
