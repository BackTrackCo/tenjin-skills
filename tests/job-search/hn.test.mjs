import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, fakeFetch, fixture, tmpHome } from './helpers/env.mjs';

tmpHome();
const hn = await import('../../skills/job-search/scripts/lib/hn.mjs');
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const net = await import('../../skills/job-search/scripts/lib/net.mjs');
const work = await import('../../skills/job-search/scripts/lib/work.mjs');

const FB = 'https://hacker-news.firebaseio.com/v0';
const AL = 'https://hn.algolia.com/api/v1';
const jobItems = fixture('hn-job-items.json');
const profile = { search: { role: 'software engineer', place: 'Berlin' } };

const hnFetch = ({ threadTitle } = {}) => {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const respond = (v) => ({ ok: true, status: 200, json: async () => v });
    if (url.startsWith(`${AL}/search_by_date?`)) return respond(threadTitle ? { hits: [{ objectID: '9002', title: threadTitle, created_at_i: 1 }] } : fixture('algolia-thread.json'));
    if (url.startsWith(`${AL}/search?`)) {
      const q = new URL(url).searchParams;
      const term = q.get('query');
      const nf = q.get('numericFilters');
      const doc = fixture(term === 'software' ? 'algolia-comments-software.json' : 'algolia-comments-engineer.json');
      const min = nf ? Number(/created_at_i>(\d+)/.exec(nf)[1]) : 0;
      return respond({ hits: doc.hits.filter((h) => h.created_at_i > min) });
    }
    if (url === `${FB}/jobstories.json`) return respond(fixture('hn-jobstories.json'));
    const m = /\/item\/(\d+)\.json$/.exec(url);
    if (m && jobItems[m[1]]) return respond(jobItems[m[1]]);
    return { ok: false, status: 404, json: async () => null };
  };
  f.calls = calls;
  return f;
};
const reset = () => store.updateState((s) => { Object.assign(s, store.emptyState()); });

test('the thread is the newest "Who is hiring?" story of whoishiring, found through Algolia', async () => {
  const f = hnFetch();
  assert.equal((await hn.latestHiringThread(f)).id, '9002');
  assert.match(f.calls[0], /search_by_date\?tags=story,author_whoishiring&query=%22who%20is%20hiring%22&hitsPerPage=1$/);
  assert.equal(await hn.latestHiringThread(hnFetch({ threadTitle: 'Ask HN: Who wants to be hired?' })), null);
});

test('one search per role word, top-level comments only, deduped, prefiltered; nothing fetched per comment', async () => {
  const f = hnFetch();
  const r = await hn.readThread({ fetch: f, profile });
  assert.deepEqual(r.kept.map((p) => p.url).sort(), ['hn:9101', 'hn:9105', 'hn:9108'], 'a reply and a Tokyo post are not kept, 9105 once');
  assert.equal(r.kept[0].text.includes('<p>'), false);
  const searches = f.calls.filter((u) => u.startsWith(`${AL}/search?`));
  assert.equal(searches.length, 2, 'software and engineer');
  for (const u of searches) {
    assert.match(u, /tags=comment,story_9002/);
    assert.match(u, /hitsPerPage=1000/);
    assert.doesNotMatch(u, /numericFilters/, 'the first read has no cursor');
  }
  assert.equal(f.calls.some((u) => /\/item\//.test(u)), false, 'no per-comment request');
  assert.equal(r.lastRead, 1795000400);
});

test('the cursor is the last read time: the next read asks only for newer comments', async () => {
  const f = hnFetch();
  const r = await hn.readThread({ fetch: f, profile, lastRead: 1795000200, threadSeen: '9002' });
  assert.deepEqual(r.kept.map((p) => p.url), ['hn:9107'].filter(() => false).concat(['hn:9108']));
  for (const u of f.calls.filter((x) => x.includes('/search?'))) assert.match(decodeURIComponent(u), /numericFilters=created_at_i>1795000200/);
  // a new thread starts from the beginning
  const g = hnFetch();
  await hn.readThread({ fetch: g, profile, lastRead: 1795000200, threadSeen: '1111' });
  assert.ok(g.calls.filter((x) => x.includes('/search?')).every((u) => !/numericFilters/.test(u)));
});

test('job stories: new ids only, dead items skipped, one request at a time with a gap, saved as it goes', async () => {
  const sleeps = [];
  const saves = [];
  const r = await hn.readJobStories({ fetch: hnFetch(), seen: [], profile, sleep: async (ms) => sleeps.push(ms), save: (c) => saves.push(c.newIds.length) });
  assert.deepEqual(r.newIds, [9201, 9202, 9203]);
  assert.deepEqual(r.kept.map((p) => p.url), ['hn:9201'], 'a role word and the place; dead and wrong-role dropped');
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms === 1000));
  assert.deepEqual(saves, [3]);
  const f2 = hnFetch();
  assert.deepEqual((await hn.readJobStories({ fetch: f2, seen: [9201, 9202, 9203], profile, sleep: async () => {} })).newIds, []);
  assert.ok(f2.calls.every((u) => !/\/item\//.test(u)), 'no item is fetched twice');
});

test('a cut-off job-story read keeps its seen ids and the next run continues', async () => {
  reset();
  let t = 0;
  const sleep = async (ms) => { t += ms; };
  const r1 = await hn.runHn({ fetch: hnFetch(), profile, state: store.loadState(), budgetMs: 1000, sleep, clock: () => t, now: Date.parse('2026-11-23T10:00:00Z') });
  assert.equal(r1.done, false);
  assert.equal(r1.remaining, 1);
  let s = store.loadState();
  assert.deepEqual(s.hn.seen, [9201, 9202], 'saved although the read did not finish');
  assert.equal(s.hn.lastAt, null, 'not complete');
  assert.equal(s.hn.lastRead, 1795000400, 'the thread cursor is saved at once');
  assert.equal(hn.hnDue(s, profile, Date.parse('2026-11-23T10:01:00Z')), true);
  const f2 = hnFetch();
  t = 0;
  const r2 = await hn.runHn({ fetch: f2, profile, state: s, budgetMs: 90000, sleep, clock: () => t, now: Date.parse('2026-11-23T10:02:00Z') });
  assert.equal(r2.done, true);
  assert.ok(f2.calls.every((u) => !/\/item\/920[12]\.json/.test(u)));
  assert.ok(f2.calls.filter((u) => u.includes('/search?')).every((u) => /numericFilters/.test(decodeURIComponent(u))), 'the thread read continues from its cursor');
  s = store.loadState();
  assert.equal(s.hn.remaining, 0);
  assert.ok(s.hn.lastAt);
  assert.equal(hn.hnDue(s, profile, Date.parse('2026-11-23T11:00:00Z')), false);
  assert.equal(hn.hnDue(s, profile, Date.parse('2026-11-24T11:00:00Z')), true);
  assert.equal(hn.hnDue(s, { ...profile, hn: false }, Date.parse('2026-11-24T11:00:00Z')), false);
});

test('only the allowed HN hosts are ever called', async () => {
  const f = hnFetch();
  await hn.runHn({ fetch: f, profile, state: store.emptyState(), sleep: async () => {} });
  assert.ok(f.calls.length > 4);
  for (const u of f.calls) assert.ok(['hn.algolia.com', 'hacker-news.firebaseio.com'].includes(new URL(u).hostname), u);
  for (const bad of ['https://news.ycombinator.com/item?id=1', 'https://www.workatastartup.com/jobs', 'https://hn.algolia.com.evil.test/x']) await assert.rejects(net.guardedFetch(bad, {}, async () => ({})), /host not allowed|never-automated host refused/);
});

test('the network check: no script fetches news.ycombinator.com or workatastartup.com, and no careers-page fetch exists', () => {
  const dir = path.join(ROOT, 'skills', 'job-search', 'scripts');
  const files = [path.join(dir, 'jobs.mjs'), ...fs.readdirSync(path.join(dir, 'lib'), { recursive: true }).filter((f) => f.endsWith('.mjs')).map((f) => path.join(dir, 'lib', f))];
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /https?:\/\/[^'"`\s]*(news\.ycombinator\.com|workatastartup\.com)/i, path.basename(f));
  assert.equal(net.fetchPublicPage, undefined);
});

test('kept posts are stored once, as one post_review batch', async () => {
  reset();
  const r = await hn.runHn({ fetch: hnFetch(), profile, state: store.loadState(), sleep: async () => {}, now: Date.parse('2026-11-23T10:00:00Z') });
  assert.equal(r.kept, 4);
  const again = await hn.runHn({ fetch: hnFetch(), profile, state: store.loadState(), sleep: async () => {}, now: Date.parse('2026-11-23T10:00:00Z') });
  assert.equal(store.loadState().posts.length, 4, 'posts are stored once');
  const items = work.buildWorkList(store.loadState(), { rules: [], lessons: [] }, Date.parse('2026-11-23T11:00:00Z'), {}).items.filter((i) => i.reason === 'post_review');
  assert.equal(items.length, 1);
  assert.equal(items[0].posts.length, 4);
  assert.ok(again.done);
});

test('an hn_hiring_posts ingest uses the posting shape and the same employer steps', async () => {
  const ing = await import('../../skills/job-search/scripts/lib/ingest.mjs');
  reset();
  const obj = { need: 'hn_hiring_posts', query: { role: 'software engineer', place: 'Berlin', remote: false, since: null }, status: 'fulfilled', fullResultPath: '/x', postings: [{ title: 'Software Engineer', employer: 'Acme', city: 'Berlin', region: '', country: 'DE', remote: false, postedAt: null, employmentType: 'Full-time', salary: null, applyLinks: [{ url: 'https://jobs.lever.co/acme/abc-1/apply', publisher: 'Lever' }], description: 'x', sourceUrl: 'hn:9101' }] };
  const lever = [{ id: 'abc-1', text: 'Software Engineer', categories: { location: 'Berlin', commitment: 'Full-time' }, createdAt: Date.parse('2026-11-15'), workplaceType: 'onsite' }];
  const r = await ing.ingest({ obj, state: store.loadState(), profile: { places: ['Berlin'], includeOld: true }, overlay: { rules: [], lessons: [] }, fetch: fakeFetch({ 'https://api.lever.co/v0/postings/acme': lever }), now: Date.parse('2026-11-23T10:00:00Z') });
  assert.equal(r.added, 1);
  assert.equal(Object.values(store.loadState().jobs)[0].via, 'hn');
});
