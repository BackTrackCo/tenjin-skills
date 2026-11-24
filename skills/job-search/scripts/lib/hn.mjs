import { guardedFetch } from './net.mjs';
import { HN_API_HOST } from './platforms.mjs';
import { updateState } from './store.mjs';
import { roleWords } from './verify.mjs';
import { INTERVAL_MS, frequencyOf } from './schedule.mjs';

// Hacker News through its official APIs only, never news.ycombinator.com (the YC Terms of Use ban automated access to the site):
//  - the hiring thread's comments through the HN Search API by Algolia, one query per role word, new comments only;
//  - job stories through the Firebase API, new ids only, saved as the read goes.
const FIREBASE = `https://${HN_API_HOST}/v0`;
const ALGOLIA = 'https://hn.algolia.com/api/v1';
export const SAVE_EVERY = 20;
export const DEFAULT_BUDGET_MS = 90_000; // for the job-story reads only, under Claude Code's 2-minute Bash default

async function getJson(url, fetchImpl) {
  const res = await guardedFetch(url, {}, fetchImpl);
  if (!res.ok) throw new Error(`hn ${url.split('?')[0]}: http ${res.status}`);
  return res.json();
}

const text = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&#x2F;/g, '/').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();

// The newest "Ask HN: Who is hiring?" story of the whoishiring account.
export async function latestHiringThread(fetchImpl) {
  const r = await getJson(`${ALGOLIA}/search_by_date?tags=story,author_whoishiring&query=%22who%20is%20hiring%22&hitsPerPage=1`, fetchImpl);
  const hit = (r.hits || [])[0];
  return hit && /who is hiring/i.test(hit.title || '') ? { id: String(hit.objectID), title: hit.title, createdAt: hit.created_at_i } : null;
}

// A code prefilter: the post names a role word (search.roleWords widens the list) and the person's place or "remote".
export function keepPost(body, profile) {
  const words = roleWords(profile);
  const t = body.toLowerCase();
  if (!words.length || !words.some((w) => t.includes(w))) return false;
  const place = String((profile.search || {}).place || '').toLowerCase().trim();
  return /\bremote\b/.test(t) || (place !== '' && t.includes(place));
}

// Thread comments: one search per role word, only comments newer than the last read, only top-level ones
// (parent_id is the thread). Nothing is fetched per comment.
export async function readThread({ fetch, profile, lastRead = 0, threadSeen = null }) {
  const thread = await latestHiringThread(fetch);
  if (!thread) return { thread: null, kept: [], lastRead };
  const since = threadSeen === thread.id ? lastRead : 0; // a new thread starts from the beginning
  const byId = new Map();
  for (const word of roleWords(profile)) {
    const filter = since > 0 ? `&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}` : '';
    const r = await getJson(`${ALGOLIA}/search?tags=comment,story_${thread.id}&query=${encodeURIComponent(word)}&hitsPerPage=1000${filter}`, fetch);
    for (const h of r.hits || []) if (String(h.parent_id) === thread.id && !byId.has(h.objectID)) byId.set(h.objectID, h);
  }
  let newest = since;
  const kept = [];
  for (const h of byId.values()) {
    newest = Math.max(newest, h.created_at_i || 0);
    const body = text(h.comment_text);
    if (!keepPost(body, profile)) continue;
    kept.push({ url: `hn:${h.objectID}`, author: h.author || '', postedAt: h.created_at_i ? new Date(h.created_at_i * 1000).toISOString() : null, text: body.slice(0, 1000), status: 'new', source: 'hn', kind: 'comment' });
  }
  return { thread: thread.id, kept, lastRead: Math.max(newest, since) };
}

// Job stories: new ids only, one request at a time, saved every 20 items and at the time budget.
export async function readJobStories({ fetch, seen = [], profile, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gapMs = 1000, budgetMs = DEFAULT_BUDGET_MS, clock = Date.now, save = null }) {
  const started = clock();
  const seenSet = new Set(seen);
  const ids = (await getJson(`${FIREBASE}/jobstories.json`, fetch)).filter((id) => !seenSet.has(id));
  const fresh = [];
  const kept = [];
  let pendingIds = [];
  let pendingKept = [];
  let done = 0;
  const flush = async () => {
    if (save && pendingIds.length) await save({ newIds: pendingIds, kept: pendingKept });
    pendingIds = [];
    pendingKept = [];
  };
  for (const id of ids) {
    if (clock() - started >= budgetMs) break;
    if (done > 0) await sleep(gapMs);
    const it = await getJson(`${FIREBASE}/item/${id}.json`, fetch);
    done++;
    fresh.push(id);
    pendingIds.push(id);
    if (it && !it.deleted && !it.dead) {
      const body = text(`${it.title || ''} ${it.text || ''}`);
      if (keepPost(body, profile)) {
        const post = { url: `hn:${id}`, author: it.by || '', postedAt: it.time ? new Date(it.time * 1000).toISOString() : null, text: body.slice(0, 1000), status: 'new', source: 'hn', kind: 'job' };
        kept.push(post);
        pendingKept.push(post);
      }
    }
    if (pendingIds.length >= SAVE_EVERY) await flush();
  }
  await flush();
  return { newIds: fresh, kept, remaining: ids.length - done };
}

// Merges one saved chunk into state. Posts are stored once. lastAt is set only by the final chunk of a finished run.
export function persistHn(chunk, now = Date.now()) {
  return updateState((state) => {
    const known = new Set((state.posts || []).map((p) => p.url));
    const add = (chunk.kept || []).filter((p) => !known.has(p.url));
    state.posts = [...(state.posts || []), ...add];
    const prev = state.hn || {};
    const remaining = chunk.remaining !== undefined ? chunk.remaining : prev.remaining || 0;
    state.hn = {
      seen: [...new Set([...(prev.seen || []), ...(chunk.newIds || [])])], // job story ids only
      thread: chunk.thread !== undefined ? chunk.thread : prev.thread || null,
      lastRead: chunk.lastRead !== undefined ? chunk.lastRead : prev.lastRead || 0, // seconds, the thread's cursor
      remaining,
      lastAt: chunk.complete ? new Date(now).toISOString() : prev.lastAt || null,
    };
    return { fetched: (chunk.newIds || []).length, kept: add.length, remaining };
  });
}

// One run: the thread through Algolia (no budget, a handful of requests), then the job stories (time-boxed).
export async function runHn({ fetch, profile, state, budgetMs, sleep, clock, now = Date.now(), gapMs }) {
  const prev = state.hn || {};
  const t = await readThread({ fetch, profile, lastRead: prev.lastRead || 0, threadSeen: prev.thread || null });
  let fetched = 0;
  let kept = t.kept.length;
  persistHn({ thread: t.thread, lastRead: t.lastRead, kept: t.kept, newIds: [], remaining: prev.remaining || 0 }, now);
  const r = await readJobStories({ fetch, seen: prev.seen || [], profile, budgetMs, sleep, clock, gapMs, save: (chunk) => { const x = persistHn(chunk, now); fetched += x.fetched; kept += x.kept; } });
  persistHn({ newIds: [], kept: [], remaining: r.remaining, complete: r.remaining === 0 }, now);
  return { thread: t.thread, fetched, kept, remaining: r.remaining, done: r.remaining === 0 };
}

export const hnDue = (state, profile, now) => Boolean(profile.search && profile.search.role && profile.hn !== false && (!state.hn || !state.hn.lastAt || (state.hn.remaining || 0) > 0 || now - Date.parse(state.hn.lastAt) >= INTERVAL_MS[frequencyOf(profile)] - 4 * 3600000));
