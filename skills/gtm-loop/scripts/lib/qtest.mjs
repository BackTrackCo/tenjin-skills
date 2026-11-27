import { RouterClient, runRound } from './router.mjs';
import { loadState, updateState } from './store.mjs';
import { offersOf } from './offers.mjs';
import { checkQuery } from './querycheck.mjs';
import { addPosts } from './dedupe.mjs';
import { fillNeed, sinceOf, recordHeld, clearHeld, queryLabel, FUNNEL_DROPS } from './routed.mjs';
import { searchHn } from './hn.mjs';
import { centsOf } from './prices.mjs';
import { subredditOf } from './queries.mjs';

// G query test <offer> <source>: one query, run once, in the attended turn, with the person's own router limits. It prints how many
// results came back, how many pass each code filter and three short sample lines (cut short, with no handles and no links), and what the
// test cost. No lead is stored. The model rewrites a query that returns 0 or only noise and tests again; the person stops when satisfied.
const KIND = { x: 'x_posts', reddit: 'reddit_posts', linkedin: 'linkedin_posts', web: 'web_research' };
const clip = (t) => String(t).replace(/https?:\/\/\S+/g, ' ').replace(/@\w+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);

// What the filters do to a set of posts, on a copy of the state: nothing is stored.
export function funnelOf(state, posts, { profile, overlay, offerId, subreddits, now }) {
  const copy = JSON.parse(JSON.stringify(state));
  const r = addPosts(copy, posts, { profile, overlay, phrase: 'query test', offerId, subreddits, now });
  const dropped = Object.fromEntries(FUNNEL_DROPS.map((k) => [k, 0]));
  for (const x of r.dropped) { const k = x.reason.replace(/:.*$/, ''); dropped[k] = (dropped[k] || 0) + 1; }
  dropped.duplicate = r.repeated;
  return { sentToReview: r.added.length, dropped, samples: r.added.slice(0, 3).map((k) => clip(copy.leads[k].text)) };
}

export async function testQuery({ profile, overlay, offerId, source, query = null, client = new RouterClient(), fetch = globalThis.fetch, now = Date.now(), save }) {
  const offer = offersOf(profile).find((o) => o.id === offerId);
  if (!offer) throw new Error(`no offer with id ${offerId}`);
  const text = query === null ? offer.queries[source] : query;
  if (!text) throw new Error(`the offer has no stored ${source} query: write one first (G queries set)`);
  const bad = checkQuery(source, text, offer);
  if (bad.length) return { ran: false, refused: bad };
  const state = loadState();
  const since = sinceOf(state, now);
  let posts;
  let cost = null;
  let droppedOld = 0;
  if (source === 'hn') {
    posts = await searchHn({ fetch, phrase: text, query: text, sinceTs: Date.parse(since) / 1000 });
    cost = 'free';
  } else {
    const kind = KIND[source];
    const base = { since, offerId, phrase: queryLabel(offerId, source), query: text };
    const need = kind === 'reddit_posts' ? fillNeed(kind, { ...base, subreddits: offer.subreddits.join(', ') }) : fillNeed(kind, { ...base, ...(kind === 'web_research' ? { mode: 'discussion' } : {}) });
    const [r] = await runRound([need], { client, save });
    if (!r.ok) {
      updateState((s) => recordHeld(s, need, r));
      return { ran: true, ok: false, status: r.status, reason: r.reason, cost: null };
    }
    updateState((s) => { clearHeld(s, need); s.spend.push({ at: new Date(now).toISOString(), kind: 'query_test', cents: centsOf(r.cost), cost: r.cost, leads: 0 }); });
    posts = r.ingest.posts;
    droppedOld = r.ingest.droppedOld || 0;
    cost = r.cost;
  }
  const f = funnelOf(loadState(), posts, { profile, overlay, offerId, subreddits: offer.subreddits, now });
  f.dropped.too_old = droppedOld;
  const outside = source === 'reddit' ? posts.filter((p) => !offer.subreddits.includes(String(p.subreddit || subredditOf(p.url) || '').toLowerCase())).length : 0;
  updateState((s) => { s.queryTests[queryLabel(offerId, source)] = { at: new Date(now).toISOString(), query: text, returned: posts.length + droppedOld, toReview: f.sentToReview, cost }; });
  return { ran: true, ok: true, source, offer: offerId, returned: posts.length + droppedOld, passFilters: f.sentToReview, dropped: f.dropped, outsideList: outside, samples: f.samples, cost, cents: cost === 'free' ? 0 : centsOf(cost), verdict: posts.length + droppedOld === 0 ? 'empty: rewrite it (looser: fewer words, fewer operators)' : f.sentToReview === 0 ? 'only noise: every result dropped by a filter; rewrite it' : 'results pass the filters' };
}
