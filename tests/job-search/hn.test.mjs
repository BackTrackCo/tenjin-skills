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

const B = 'https://hacker-news.firebaseio.com/v0';
const items = fixture('hn-items.json');
const hnFetch = () => {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const respond = (v) => ({ ok: true, status: 200, json: async () => v });
    if (url === `${B}/user/whoishiring.json`) return respond(fixture('hn-whoishiring-user.json'));
    if (url === `${B}/jobstories.json`) return respond(fixture('hn-jobstories.json'));
    const m = /\/item\/(\d+)\.json$/.exec(url);
    if (m && items[m[1]]) return respond(items[m[1]]);
    return { ok: false, status: 404, json: async () => null };
  };
  f.calls = calls;
  return f;
};
const profile = { search: { role: 'software engineer', place: 'Berlin' } };

test('the newest story titled "Ask HN: Who is hiring?" is the thread, not "Who wants to be hired"', async () => {
  const t = await hn.latestHiringThread(hnFetch());
  assert.equal(t.id, 9002);
});

test('new ids only: the thread kids and /v0/jobstories, deleted and dead skipped, the prefilter applied', async () => {
  const f = hnFetch();
  const sleeps = [];
  const r = await hn.readHn({ fetch: f, seen: [], profile, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(r.newIds, [9101, 9102, 9103, 9104, 9105, 9201, 9202]);
  assert.deepEqual(r.kept.map((p) => p.url), ['hn:9101', 'hn:9105', 'hn:9201'], 'a role word and the place or remote; deleted, dead, wrong role and wrong place dropped');
  assert.equal(r.kept[0].text.includes('<p>'), false);
  assert.equal(sleeps.length, r.newIds.length - 1, 'one request at a time with a gap between');
  assert.ok(sleeps.every((ms) => ms === 1000));
  // the second read fetches only ids it has not seen
  const f2 = hnFetch();
  const again = await hn.readHn({ fetch: f2, seen: r.newIds, profile, sleep: async () => {} });
  assert.deepEqual(again.newIds, []);
  assert.ok(f2.calls.every((u) => !/\/item\/9[12]\d\d\.json/.test(u)), 'no item is fetched twice');
  const f3 = hnFetch();
  const partial = await hn.readHn({ fetch: f3, seen: [9101, 9102, 9103, 9104, 9105, 9201], profile, sleep: async () => {} });
  assert.deepEqual(partial.newIds, [9202]);
});

test('only the official API host is ever called', async () => {
  const f = hnFetch();
  await hn.readHn({ fetch: f, seen: [], profile, sleep: async () => {} });
  assert.ok(f.calls.length > 5);
  for (const u of f.calls) assert.equal(new URL(u).hostname, 'hacker-news.firebaseio.com');
  await assert.rejects(net.guardedFetch('https://news.ycombinator.com/item?id=1', {}, async () => ({})), /host not allowed/);
  await assert.rejects(net.guardedFetch('https://www.workatastartup.com/jobs', {}, async () => ({})), /host not allowed/);
  await assert.rejects(net.fetchPublicPage('https://news.ycombinator.com/jobs', async () => ({})), /never fetched/);
});

test('the network check: no script fetches news.ycombinator.com or workatastartup.com', () => {
  const dir = path.join(ROOT, 'skills', 'job-search', 'scripts');
  const files = [path.join(dir, 'jobs.mjs'), ...fs.readdirSync(path.join(dir, 'lib')).map((f) => path.join(dir, 'lib', f))];
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /https?:\/\/[^'"`\s]*(news\.ycombinator\.com|workatastartup\.com)/i, path.basename(f));
});

test('kept posts are stored once, as post_review items, with the seen ids', async () => {
  store.updateState((s) => { Object.assign(s, store.emptyState()); });
  const r = await hn.readHn({ fetch: hnFetch(), seen: [], profile, sleep: async () => {} });
  assert.deepEqual(hn.persistHn(r, Date.parse('2026-11-23T10:00:00Z')), { fetched: 7, kept: 3, remaining: 0 });
  assert.deepEqual(hn.persistHn(r, Date.parse('2026-11-23T10:00:00Z')), { fetched: 7, kept: 0, remaining: 0 });
  const s = store.loadState();
  assert.equal(s.hn.seen.length, 7);
  const items2 = work.buildWorkList(s, { rules: [], lessons: [] }, Date.parse('2026-11-23T11:00:00Z'), {}).items.filter((i) => i.reason === 'post_review');
  assert.equal(items2.length, 1, 'three posts are one batch');
  assert.deepEqual(items2[0].posts.map((p) => p.url), ['hn:9101', 'hn:9105', 'hn:9201']);
  assert.equal(hn.hnDue(s, profile, Date.parse('2026-11-23T11:00:00Z')), false);
  assert.equal(hn.hnDue(s, profile, Date.parse('2026-11-24T11:00:00Z')), true);
  assert.equal(hn.hnDue(s, { ...profile, hn: false }, Date.parse('2026-11-24T11:00:00Z')), false);
});

test('an hn_hiring_posts ingest uses the posting shape and the same employer steps', async () => {
  const ing = await import('../../skills/job-search/scripts/lib/ingest.mjs');
  store.updateState((s) => { Object.assign(s, store.emptyState()); });
  const obj = { need: 'hn_hiring_posts', query: { role: 'software engineer', place: 'Berlin', remote: false, since: null }, status: 'fulfilled', fullResultPath: '/x', postings: [{ title: 'Software Engineer', employer: 'Acme', city: 'Berlin', region: '', country: 'DE', remote: false, postedAt: null, employmentType: 'Full-time', salary: null, applyLinks: [{ url: 'https://jobs.lever.co/acme/abc-1/apply', publisher: 'Lever' }], description: 'x', sourceUrl: 'hn:9101' }] };
  const lever = [{ id: 'abc-1', text: 'Software Engineer', categories: { location: 'Berlin', commitment: 'Full-time' }, createdAt: Date.parse('2026-11-15'), workplaceType: 'onsite' }];
  const r = await ing.ingest({ obj, state: store.loadState(), profile: { places: ['Berlin'], includeOld: true }, overlay: { rules: [], lessons: [] }, fetch: fakeFetch({ 'https://api.lever.co/v0/postings/acme': lever }), now: Date.parse('2026-11-23T10:00:00Z') });
  assert.equal(r.added, 1);
  assert.equal(Object.values(store.loadState().jobs)[0].via, 'hn');
});

test('a cut-off read keeps its seen ids and the next call continues from them', async () => {
  store.updateState((s) => { Object.assign(s, store.emptyState()); });
  let t = 0;
  const clock = () => t;
  const sleep = async (ms) => { t += ms; }; // each item costs one second on the fake clock
  const r1 = await hn.runHn({ fetch: hnFetch(), profile, state: store.loadState(), budgetMs: 3500, sleep, clock, now: Date.parse('2026-11-23T10:00:00Z') });
  assert.equal(r1.done, false);
  assert.equal(r1.fetched, 5);
  assert.equal(r1.remaining, 2);
  assert.deepEqual(store.loadState().hn.seen, [9101, 9102, 9103, 9104, 9105], 'saved although the read did not finish');
  assert.equal(store.loadState().hn.lastAt, null, 'not complete yet');
  assert.equal(hn.hnDue(store.loadState(), profile, Date.parse('2026-11-23T10:01:00Z')), true, 'the next tick continues');
  const f2 = hnFetch();
  t = 0;
  const r2 = await hn.runHn({ fetch: f2, profile, state: store.loadState(), budgetMs: 90000, sleep, clock, now: Date.parse('2026-11-23T10:02:00Z') });
  assert.equal(r2.done, true);
  assert.equal(r2.fetched, 2);
  assert.ok(f2.calls.every((u) => !/\/item\/910[1-5]\.json/.test(u)), 'the first five are not fetched again');
  const s = store.loadState();
  assert.equal(s.hn.seen.length, 7);
  assert.equal(s.hn.remaining, 0);
  assert.ok(s.hn.lastAt);
  assert.equal(s.posts.length, 3);
  assert.equal(hn.hnDue(s, profile, Date.parse('2026-11-23T11:00:00Z')), false);
});

test('progress is saved every 20 items, before the read ends', async () => {
  const many = {};
  const kids = Array.from({ length: 45 }, (_, i) => 7000 + i);
  many['9002'] = { id: 9002, type: 'story', title: 'Ask HN: Who is hiring? (X)', kids };
  for (const k of kids) many[k] = { id: k, type: 'comment', by: 'x', time: 1795000000, text: 'Software engineer, Berlin' };
  const f = async (url) => {
    const respond = (v) => ({ ok: true, status: 200, json: async () => v });
    if (url.endsWith('/user/whoishiring.json')) return respond({ submitted: [9002] });
    if (url.endsWith('/jobstories.json')) return respond([]);
    return respond(many[/item\/(\d+)/.exec(url)[1]]);
  };
  const saves = [];
  await hn.readHn({ fetch: f, seen: [], profile, sleep: async () => {}, save: (c) => saves.push(c.newIds.length) });
  assert.deepEqual(saves, [20, 20, 5]);
});

test('the watcher tick reads Hacker News in a time-boxed run and continues on the next tick', async () => {
  store.updateState((s) => { Object.assign(s, store.emptyState()); });
  const fs2 = await import('node:fs');
  fs2.mkdirSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search'), { recursive: true });
  fs2.writeFileSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), JSON.stringify({ search: profile.search, updates: false }));
  const lease = await import('../../skills/job-search/scripts/lib/lease.mjs');
  const watcher = await import('../../skills/job-search/scripts/lib/watcher.mjs');
  const now = Date.parse('2026-11-23T10:00:00Z');
  await lease.claimLease({ holder: 'h', now });
  let t = 0;
  const sleep = async (ms) => { t += ms; };
  await watcher.tick({ holder: 'h', now, fetchImpl: hnFetch(), sleep, clock: () => t, hnBudgetMs: 2500, seen: { sig: null } });
  assert.equal(store.loadState().hn.remaining > 0, true);
  t = 0;
  await watcher.tick({ holder: 'h', now: now + 60000, fetchImpl: hnFetch(), sleep, clock: () => t, hnBudgetMs: 60000, seen: { sig: null } });
  assert.equal(store.loadState().hn.remaining, 0);
});

test('post_review goes to Haiku in batches of 25, one item per batch', () => {
  const s = store.emptyState();
  s.posts = Array.from({ length: 60 }, (_, i) => ({ url: `hn:${i}`, author: 'a', text: 't', status: 'new' }));
  const items = work.buildWorkList(s, { rules: [], lessons: [] }, Date.now(), {}).items.filter((i) => i.reason === 'post_review');
  assert.deepEqual(items.map((i) => i.posts.length), [25, 25, 10]);
  assert.equal(work.POST_BATCH, 25);
});
