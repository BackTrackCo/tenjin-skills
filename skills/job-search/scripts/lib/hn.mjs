import { guardedFetch } from './net.mjs';
import { HN_API_HOST } from './platforms.mjs';
import { updateState } from './store.mjs';

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

// A code prefilter: the post names a role word and the person's place or "remote".
export function keepPost(body, profile) {
  const s = profile.search || {};
  const role = String(s.role || '').toLowerCase().split(/\W+/).filter((w) => w.length >= 3);
  const t = body.toLowerCase();
  if (!role.length || !role.some((w) => t.includes(w))) return false;
  const place = String(s.place || '').toLowerCase().trim();
  return /\bremote\b/.test(t) || (place !== '' && t.includes(place));
}

// One request at a time, about one a second. Only unseen ids are fetched; deleted and dead items are skipped.
export async function readHn({ fetch, seen = [], profile, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gapMs = 1000 }) {
  const seenSet = new Set(seen);
  const fresh = [];
  let first = true;
  const pull = async (id) => {
    if (!first) await sleep(gapMs);
    first = false;
    return getJson(`/item/${id}.json`, fetch);
  };
  const thread = await latestHiringThread(fetch);
  const ids = [];
  for (const kid of (thread && thread.kids) || []) if (!seenSet.has(kid)) ids.push(['comment', kid]);
  const jobIds = await getJson('/jobstories.json', fetch);
  for (const id of jobIds) if (!seenSet.has(id)) ids.push(['job', id]);
  const kept = [];
  for (const [kind, id] of ids) {
    const it = await pull(id);
    seenSet.add(id);
    fresh.push(id);
    if (!it || it.deleted || it.dead) continue;
    const body = text(`${it.title || ''} ${it.text || ''}`);
    if (!keepPost(body, profile)) continue;
    kept.push({ url: `hn:${id}`, author: it.by || '', postedAt: it.time ? new Date(it.time * 1000).toISOString() : null, text: body.slice(0, 1000), status: 'new', source: 'hn', kind });
  }
  return { thread: thread ? thread.id : null, newIds: fresh, kept };
}

export function persistHn(result, now = Date.now()) {
  return updateState((state) => {
    const known = new Set((state.posts || []).map((p) => p.url));
    const add = result.kept.filter((p) => !known.has(p.url));
    state.posts = [...(state.posts || []), ...add];
    state.hn = { seen: [...new Set([...((state.hn && state.hn.seen) || []), ...result.newIds])], lastAt: new Date(now).toISOString(), thread: result.thread };
    return { fetched: result.newIds.length, kept: add.length };
  });
}

export const hnDue = (state, profile, now) => Boolean(profile.search && profile.search.role && profile.hn !== false && (!state.hn || !state.hn.lastAt || now - Date.parse(state.hn.lastAt) >= DAY - 4 * 3600000));
