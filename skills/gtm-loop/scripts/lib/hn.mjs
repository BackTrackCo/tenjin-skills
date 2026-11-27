import { guardedFetch } from './net.mjs';
import { strip } from './postinfo.mjs';
import { HN_SITE } from './platforms.mjs';
import { addPosts } from './dedupe.mjs';
import { loadState, updateState } from './store.mjs';
import { capOf } from './overlay.mjs';
import { phrasePairs } from './offers.mjs';
import { hnQuery } from './queries.mjs';

// Hacker News comments and stories, free, through the HN Search API only (never news.ycombinator.com, which is only shown to the
// person and opened by them). One keyword search per phrase, newest first, only items newer than the last read.
const ALGOLIA = 'https://hn.algolia.com/api/v1';
export const itemUrl = (id) => `https://${HN_SITE}/item?id=${id}`;

async function getJson(url, fetchImpl) {
  const res = await guardedFetch(url, {}, fetchImpl);
  if (!res.ok) throw new Error(`hn ${url.split('?')[0]}: http ${res.status}`);
  return res.json();
}

// phrase -> posts. `sinceTs` is unix seconds.
export async function searchHn({ fetch, phrase, sinceTs = 0, hits = 50 }) {
  const filter = sinceTs > 0 ? `&numericFilters=${encodeURIComponent(`created_at_i>${Math.floor(sinceTs)}`)}` : '';
  const r = await getJson(`${ALGOLIA}/search_by_date?query=${encodeURIComponent(hnQuery(phrase))}&tags=${encodeURIComponent('(story,comment)')}&hitsPerPage=${hits}${filter}`, fetch);
  const posts = [];
  for (const h of r.hits || []) {
    const body = strip(h.comment_text || h.story_text || '');
    const text = [strip(h.title || ''), body].filter(Boolean).join('\n');
    if (!text || !h.objectID) continue;
    posts.push({ url: itemUrl(h.objectID), author: h.author || '', postedAt: h.created_at_i ? new Date(h.created_at_i * 1000).toISOString() : null, text: text.slice(0, 1000), links: h.url ? [h.url] : [], source: 'hn' });
  }
  return posts;
}

export const sinceTsOf = (state, now, maxDays = 14) => {
  const last = state.hn && state.hn.lastAt ? Date.parse(state.hn.lastAt) : 0;
  return Math.max(last, now - maxDays * 86400000) / 1000;
};

// One round: every phrase (up to the person's phrases_per_round rule), each on its own request, then the leads.
export async function runHn({ fetch, profile, overlay, now = Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gapMs = 250 }) {
  const pairs = phrasePairs(profile, capOf(overlay, 'phrases_per_round'));
  const since = sinceTsOf(loadState(), now);
  const found = [];
  for (const { offer, phrase } of pairs) {
    found.push({ phrase, offerId: offer.id, posts: await searchHn({ fetch, phrase, sinceTs: since }) });
    if (gapMs) await sleep(gapMs);
  }
  return updateState((state) => {
    const out = { added: 0, repeated: 0, dropped: 0, byPhrase: {} };
    for (const { phrase, offerId, posts } of found) {
      const r = addPosts(state, posts, { profile, overlay, phrase, offerId, now });
      out.added += r.added.length;
      out.repeated += r.repeated;
      out.dropped += r.dropped.length;
      out.byPhrase[phrase] = r.added.length;
      const y = (state.phraseYield[phrase] ||= {});
      y.hn = (y.hn || 0) + r.added.length;
    }
    state.hn.lastAt = new Date(now).toISOString();
    return out;
  });
}
