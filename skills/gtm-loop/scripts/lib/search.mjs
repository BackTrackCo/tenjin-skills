import crypto from 'node:crypto';
import { graph } from './graph.mjs';
import { loadState, updateState } from './store.mjs';
import { capOf } from './overlay.mjs';
import { frequencyOf, searchIsDue } from './schedule.mjs';
import { runHn } from './hn.mjs';
import { runPostRound, runIdentityReads } from './routed.mjs';
import { RouterClient } from './router.mjs';

// When a search is due, what runs in code, and what is left to the one free model step. HN is free and always in code. With Tenjin
// ready, every post source runs in code too; without it the model's one Haiku web-search step runs the queries `G search plan`
// prints and writes a post file.
export const searchDue = (state, profile, now = Date.now()) => {
  if (!(profile.phrases || []).length) return false;
  const last = state.search && state.search.lastAt ? Date.parse(state.search.lastAt) : null;
  return searchIsDue({ lastAt: last, now, frequency: frequencyOf(profile), hour: profile.sweepHour ?? graph().sweep.defaultHour });
};

// The free step's queries: each phrase, then the phrase on each platform the person chose, as web-search queries.
export function searchPlan(profile, overlay) {
  const phrases = (profile.phrases || []).slice(0, capOf(overlay, 'phrases_per_round') || undefined);
  const sources = profile.sources && profile.sources.length ? profile.sources : ['x', 'reddit', 'linkedin', 'web'];
  const sites = { x: 'site:x.com', reddit: 'site:reddit.com', linkedin: 'site:linkedin.com/posts' };
  const queries = [];
  for (const phrase of phrases) {
    if (sources.includes('web')) queries.push({ phrase, source: 'web', query: `"${phrase}"` });
    for (const s of ['x', 'reddit', 'linkedin']) if (sources.includes(s)) queries.push({ phrase, source: s, query: `"${phrase}" ${sites[s]}` });
  }
  return { queries, note: 'Search the web with each query. For each result that is a person asking for what the offer is, keep its link, the author handle if shown, the date if shown and the snippet as text (1000 characters at most). Write one file per phrase: {"phrase", "status": "fulfilled", "posts": [{"url", "author", "postedAt", "text", "source"}]}, then run G ingest --file <file>. Never fetch x.com, linkedin.com or reddit.com.' };
}

const stamp = (n) => n;
export function searchItems({ state, profile, now }) {
  const items = [];
  const s = state.search || {};
  if (s.modelDue) items.push({ key: 'search', reason: 'search_due', v: stamp(s.round || 1), detail: 'the free web-search step' });
  return items;
}

// The watcher's search step. Marks the round, runs HN, then the routed round when Tenjin is ready; otherwise leaves the free step.
export async function searchStep({ profile, overlay, fetchImpl, now, routerClient, save, sleep }) {
  const state = loadState();
  if (!searchDue(state, profile, now) || (state.search || {}).modelDue) return { ran: false };
  const out = { ran: true };
  if (fetchImpl && (!profile.sources || profile.sources.includes('hn'))) out.hn = await runHn({ fetch: fetchImpl, profile, overlay, now, sleep });
  if (loadState().tenjin.status === 'ready') {
    out.routed = await runPostRound({ profile, overlay, client: routerClient || new RouterClient(), now, save });
    try {
      out.reads = await runIdentityReads({ client: routerClient || new RouterClient(), now, save });
    } catch {}
  } else {
    updateState((s) => { s.search.modelDue = true; s.search.round = (s.search.round || 0) + 1; s.search.roundAdded = 0; });
  }
  updateState((s) => { s.search.lastAt = new Date(now).toISOString(); });
  return out;
}

export function searchDone(now = Date.now()) {
  return updateState((s) => {
    s.search.modelDue = false;
    s.search.lastAt = new Date(now).toISOString();
    return { done: true };
  });
}

export const reviewItems = ({ state }) => {
  const fresh = Object.values(state.leads).filter((l) => l.status === 'new');
  if (!fresh.length) return [];
  const v = parseInt(crypto.createHash('sha256').update(fresh.map((l) => `${l.key}:${l.v}`).sort().join('|')).digest('hex').slice(0, 8), 16);
  return [{ key: 'review', reason: 'review_due', v, count: fresh.length }];
};
