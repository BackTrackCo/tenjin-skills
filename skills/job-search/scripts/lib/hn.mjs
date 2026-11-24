import { guardedFetch } from './net.mjs';
import { HN_API_HOST } from './platforms.mjs';
import { updateState } from './store.mjs';
import { roleWords } from './verify.mjs';

// Hacker News through its official API only, never news.ycombinator.com (the YC Terms of Use ban automated access to the site).
const BASE = `https://${HN_API_HOST}/v0`;
const DAY = 86400000;

async function getJson(p, fetchImpl) {
  const res = await guardedFetch(`${BASE}${p}`, {}, fetchImpl);
  if (!res.ok) throw new Error(`hn ${p}: http ${res.status}`);
  return res.json();
}

// The newest story titled "Ask HN: Who is hiring?" in the whoishiring account's submissions.
export async function latestHiringThread(fetchImpl) {
  const user = await getJson('/user/whoishiring.json', fetchImpl);
  for (const id of (user.submitted || []).slice(0, 8)) {
    const item = await getJson(`/item/${id}.json`, fetchImpl);
    if (item && /^Ask HN: Who is hiring\?/i.test(item.title || '')) return item;
  }
  return null;
}

const text = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&#x2F;/g, '/').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();

// A code prefilter: the post names a role word (search.roleWords widens the list) and the person's place or "remote".
export function keepPost(body, profile) {
  const words = roleWords(profile);
  const t = body.toLowerCase();
  if (!words.length || !words.some((w) => t.includes(w))) return false;
  const place = String((profile.search || {}).place || '').toLowerCase().trim();
  return /\bremote\b/.test(t) || (place !== '' && t.includes(place));
}

export const SAVE_EVERY = 20;
export const DEFAULT_BUDGET_MS = 90_000; // under Claude Code's 2-minute Bash default, so a `J hn` call is never cut off

// One request at a time, about one a second. Only unseen ids are fetched; deleted and dead items are skipped.
// Work is saved every 20 items through `save`, and the read stops at the time budget, so a cut-off read keeps
// its seen ids and the next call continues. Returns what was left.
export async function readHn({ fetch, seen = [], profile, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gapMs = 1000, budgetMs = DEFAULT_BUDGET_MS, clock = Date.now, save = null }) {
  const started = clock();
  const seenSet = new Set(seen);
  const thread = await latestHiringThread(fetch);
  const ids = [];
  for (const kid of (thread && thread.kids) || []) if (!seenSet.has(kid)) ids.push(['comment', kid]);
  const jobIds = await getJson('/jobstories.json', fetch);
  for (const id of jobIds) if (!seenSet.has(id)) ids.push(['job', id]);
  const fresh = [];
  const kept = [];
  let pendingIds = [];
  let pendingKept = [];
  let done = 0;
  const flush = async () => {
    if (save && pendingIds.length) await save({ thread: thread ? thread.id : null, newIds: pendingIds, kept: pendingKept, remaining: ids.length - done });
    pendingIds = [];
    pendingKept = [];
  };
  for (const [kind, id] of ids) {
    if (clock() - started >= budgetMs) break;
    if (done > 0) await sleep(gapMs);
    const it = await getJson(`/item/${id}.json`, fetch);
    done++;
    fresh.push(id);
    pendingIds.push(id);
    if (it && !it.deleted && !it.dead) {
      const body = text(`${it.title || ''} ${it.text || ''}`);
      if (keepPost(body, profile)) {
        const post = { url: `hn:${id}`, author: it.by || '', postedAt: it.time ? new Date(it.time * 1000).toISOString() : null, text: body.slice(0, 1000), status: 'new', source: 'hn', kind };
        kept.push(post);
        pendingKept.push(post);
      }
    }
    if (pendingIds.length >= SAVE_EVERY) await flush();
  }
  await flush();
  return { thread: thread ? thread.id : null, newIds: fresh, kept, remaining: ids.length - done };
}

// Merges one saved chunk: seen ids, kept posts and what is left. lastAt is set only when the read is complete.
export function persistHn(result, now = Date.now()) {
  return updateState((state) => {
    const known = new Set((state.posts || []).map((p) => p.url));
    const add = result.kept.filter((p) => !known.has(p.url));
    state.posts = [...(state.posts || []), ...add];
    const prev = state.hn || {};
    state.hn = { seen: [...new Set([...(prev.seen || []), ...result.newIds])], lastAt: result.remaining > 0 ? prev.lastAt || null : new Date(now).toISOString(), thread: result.thread, remaining: result.remaining };
    return { fetched: result.newIds.length, kept: add.length, remaining: result.remaining };
  });
}

// Reads for up to the budget, saving as it goes. The result says how many items are left.
export async function runHn({ fetch, profile, state, budgetMs, sleep, clock, now = Date.now(), gapMs }) {
  let fetched = 0;
  let kept = 0;
  const r = await readHn({ fetch, seen: (state.hn || {}).seen || [], profile, budgetMs, sleep, clock, gapMs, save: (chunk) => { const x = persistHn(chunk, now); fetched += x.fetched; kept += x.kept; } });
  persistHn({ thread: r.thread, newIds: [], kept: [], remaining: r.remaining }, now); // the final state: remaining, and lastAt once complete
  return { fetched, kept, remaining: r.remaining, done: r.remaining === 0 };
}

export const hnDue = (state, profile, now) => Boolean(profile.search && profile.search.role && profile.hn !== false && (!state.hn || !state.hn.lastAt || (state.hn.remaining || 0) > 0 || now - Date.parse(state.hn.lastAt) >= DAY - 4 * 3600000));
