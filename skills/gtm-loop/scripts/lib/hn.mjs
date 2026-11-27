import { guardedFetch } from './net.mjs';
import { strip } from './postinfo.mjs';
import { HN_SITE } from './platforms.mjs';
import { addPosts } from './dedupe.mjs';
import { loadState, updateState } from './store.mjs';
import { capOf } from './overlay.mjs';
import { offersOf } from './offers.mjs';
import { checkQuery } from './querycheck.mjs';
import { funnelAdd, recordYield } from './routed.mjs';
import { activeOf, labelOf } from './queryset.mjs';
import { hnQuery, keywords } from './queries.mjs';

// Hacker News comments and stories, free, through the HN Search API only (never news.ycombinator.com, which is only shown to the
// person and opened by them). One keyword search per phrase, newest first, only items newer than the last read.
const ALGOLIA = 'https://hn.algolia.com/api/v1';
export const itemUrl = (id) => `https://${HN_SITE}/item?id=${id}`;

async function getJson(url, fetchImpl) {
  const res = await guardedFetch(url, {}, fetchImpl);
  if (!res.ok) throw new Error(`hn ${url.split('?')[0]}: http ${res.status}`);
  return res.json();
}

const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim();
// A hit is a person who asks only when it is an Ask HN story, or a comment under an Ask HN story, or a comment that holds the key
// words next to each other. A bare key-word match in any thread is noise.
export function keepHit(h, phrase) {
  const tags = h._tags || [];
  if (tags.includes('story')) return tags.includes('ask_hn');
  const title = String(h.story_title || '');
  if (/^ask hn/i.test(title)) return true;
  const k = keywords(phrase, 3).join(' ');
  return Boolean(k) && ` ${norm(strip(h.comment_text || ''))} `.includes(` ${k} `);
}

// phrase -> posts. Two searches: Ask HN stories, and comments. `sinceTs` is unix seconds.
export async function searchHn({ fetch, phrase, query = null, sinceTs = 0, hits = 50 }) {
  const filter = sinceTs > 0 ? `&numericFilters=${encodeURIComponent(`created_at_i>${Math.floor(sinceTs)}`)}` : '';
  const q = encodeURIComponent(query || hnQuery(phrase));
  const posts = [];
  for (const tag of ['ask_hn', 'comment']) {
    const r = await getJson(`${ALGOLIA}/search_by_date?query=${q}&tags=${tag}&hitsPerPage=${hits}${filter}`, fetch);
    for (const h of r.hits || []) {
      if (!keepHit({ ...h, _tags: h._tags || (tag === 'comment' ? ['comment'] : ['story', 'ask_hn']) }, query || phrase)) continue;
      const body = strip(h.comment_text || h.story_text || '');
      const text = [strip(h.title || ''), body].filter(Boolean).join('\n');
      if (!text || !h.objectID) continue;
      posts.push({ url: itemUrl(h.objectID), author: h.author || '', postedAt: h.created_at_i ? new Date(h.created_at_i * 1000).toISOString() : null, text: text.slice(0, 1000), links: h.url ? [h.url] : [], source: 'hn' });
    }
  }
  return posts;
}

export const sinceTsOf = (state, now, maxDays = 14) => {
  const last = state.hn && state.hn.lastAt ? Date.parse(state.hn.lastAt) : 0;
  return Math.max(last, now - maxDays * 86400000) / 1000;
};

// One round: every phrase (up to the person's phrases_per_round rule), each on its own request, then the leads.
export async function runHn({ fetch, profile, overlay, now = Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gapMs = 250 }) {
  const since = sinceTsOf(loadState(), now);
  // A stored query (written by the model, checked by code) is one search per offer; without one, one search per phrase.
  const jobs = [];
  const state0 = loadState();
  for (const offer of offersOf(profile)) {
    const set = activeOf(profile, state0).filter((q) => q.offerId === offer.id && q.source === 'hn' && !checkQuery('hn', q.text, offer).length);
    if (set.length) for (const q of set) jobs.push({ offer, label: labelOf(q.id), query: q.text, phrase: q.text });
    else for (const phrase of offer.phrases.slice(0, capOf(overlay, 'phrases_per_round') || undefined)) jobs.push({ offer, label: phrase, query: null, phrase });
  }
  const found = [];
  for (const j of jobs) {
    found.push({ ...j, posts: await searchHn({ fetch, phrase: j.phrase, query: j.query, sinceTs: since }) });
    if (gapMs) await sleep(gapMs);
  }
  return updateState((state) => {
    const out = { added: 0, repeated: 0, dropped: 0, byPhrase: {} };
    for (const { phrase, label, offer, posts } of found) {
      const r = addPosts(state, posts, { profile, overlay, phrase: label, offerId: offer.id, now });
      out.added += r.added.length;
      out.repeated += r.repeated;
      out.dropped += r.dropped.length;
      out.byPhrase[phrase] = r.added.length;
      const y = (state.phraseYield[label] ||= {});
      y.hn = (y.hn || 0) + r.added.length;
      recordYield(state, { query: label, fields: { offerId: offer.id }, kind: 'hn' }, posts.length, r.added.length, now, { dropped: r.dropped, repeated: r.repeated });
      funnelAdd(state, 'hn', { returned: posts.length, dropped: r.dropped, repeated: r.repeated, toReview: r.added.length });
    }
    state.hn.lastAt = new Date(now).toISOString();
    return out;
  });
}
