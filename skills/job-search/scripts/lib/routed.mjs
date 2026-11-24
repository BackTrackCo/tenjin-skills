import { graph } from './graph.mjs';
import { RouterClient, runRound } from './router.mjs';
import { SUPPLIERS } from './suppliers/index.mjs';
import { ingest } from './ingest.mjs';
import { loadState, updateState } from './store.mjs';
import { loadOverlay } from './overlay.mjs';
import { advanceSearch, searchRound, variantFor } from './work.mjs';

// With Tenjin, a search round runs in code, with no model step before review: the needs go to the router one at a
// time (router.mjs), each result is ingested, and the same rule as the model-run rounds decides whether the next
// role-word variant is worth a round. A search that is held (any status but fulfilled, no adapter, a timeout) is named in
// the report; nothing is retried.
export const needText = (kind, q) => graph().needTemplates[kind].replace('{role}', q.variant || q.role).replace('{place}', q.place || 'any place').replace('{days}', String(q.days));

// Only the needs that have a supplier adapter run here; the others stay a Haiku step with a hint.
export function roundNeeds(profile, state, now, round) {
  const since = state.routed && state.routed.lastSearchAt ? new Date(Math.max(Date.parse(state.routed.lastSearchAt) - 86400000, now - 14 * 86400000)) : new Date(now - 14 * 86400000);
  const days = Math.max(1, Math.ceil((now - since.getTime()) / 86400000));
  const base = { role: profile.search.role, place: profile.search.place || '', remote: profile.search.remote === true, since: since.toISOString().slice(0, 10), variant: variantFor(profile, round), round };
  return [...new Set(SUPPLIERS.map((s) => s.kind))].filter((k) => graph().needTemplates[k]).map((kind) => ({ kind, text: needText(kind, { ...base, days }), fields: base, query: base }));
}

// The watcher runs the rounds in code only when every need has an adapter; otherwise the model step keeps the searches
// that have none, so nothing is lost. `J route` runs the needs that do.
export const allNeedsCovered = () => Object.keys(graph().needTemplates).every((k) => SUPPLIERS.some((s) => s.kind === k));

export async function routedRounds({ profile, fetch, client = new RouterClient(), now = Date.now(), maxRounds = 20 }) {
  const log = [];
  for (let i = 0; i < maxRounds; i++) {
    const state = loadState();
    const round = searchRound(state, profile, now);
    if (round === null) break;
    const needs = roundNeeds(profile, state, now, round);
    if (!needs.length) break;
    const results = await runRound(needs, { client });
    let added = 0;
    for (const r of results) {
      if (r.ok) {
        const out = await ingest({ obj: r.ingest, state: loadState(), profile, overlay: loadOverlay(), fetch, now });
        added += out.added;
        updateState((s) => { s.routed.lastCost = r.cost || s.routed.lastCost; });
      } else {
        updateState((s) => {
          s.held = [...s.held.filter((h) => !String(h.detail).startsWith(`routed:${r.need}:`)), { reason: 'source_empty', detail: `routed:${r.need}: ${r.status}: ${r.reason}` }];
          s.routed.lastSearchAt = new Date(now).toISOString();
          if (r.status === 'wallet_unavailable') s.routed.skipReason = 'wallet_unavailable: run the searches in an attended turn';
        });
      }
      log.push({ round, need: r.need || r.ingest.need, ok: r.ok, status: r.status });
    }
    const profileNow = profile;
    const next = updateState((s) => (s.search.session ? advanceSearch(s, profileNow) : { done: true }));
    if (next.done) break;
  }
  return log;
}
