import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fixture, tmpHome } from './helpers/env.mjs';

tmpHome();
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const ing = await import('../../skills/job-search/scripts/lib/ingest.mjs');
const sweep = await import('../../skills/job-search/scripts/lib/sweep.mjs');
const work = await import('../../skills/job-search/scripts/lib/work.mjs');
const report = await import('../../skills/job-search/scripts/lib/report.mjs');
const { runJobs } = await import('./helpers/env.mjs');
const NOW = Date.parse('2026-11-23T10:00:00Z');
const empty = { rules: [], lessons: [] };
const profile = { places: ['Berlin'], includeOld: true, search: { role: 'software engineer', place: 'Berlin' } };
const board = fixture('greenhouse-figma.json');
const liveId = board.jobs[0].id;
const doc = () => JSON.parse(JSON.stringify(fixture('ingest-job-postings.json')).replace('__JOBID__', String(liveId)));
const run = (obj, extra = {}) => ing.ingest({ obj, state: store.loadState(), profile, overlay: empty, fetch: fakeFetch({ 'https://boards-api.greenhouse.io/': board }), now: NOW, ...extra });
const reset = () => store.updateState((s) => { Object.assign(s, store.emptyState()); });

test('a valid file: the Greenhouse posting is verified on its board and queued; others become apply-yourself items', async () => {
  reset();
  const r = await run(doc());
  assert.equal(r.added, 1);
  assert.equal(r.applyYourself, 1);
  assert.equal(r.closedOnBoard, 1, 'a board that no longer lists the job means closed');
  assert.equal(r.dropped, 1, 'outside the place');
  const s = store.loadState();
  const job = Object.values(s.jobs)[0];
  assert.equal(job.url, `https://boards.greenhouse.io/figma/jobs/${liveId}`);
  assert.equal(job.board, 'greenhouse:figma');
  assert.equal(s.applyYourself[0].employer, 'Globex');
  assert.deepEqual(s.applyYourself[0].links.map((l) => l.publisher), ['Example Jobs', 'Globex']);
  assert.equal(s.routed.lastCost, '$0.01');
  assert.ok(s.routed.lastSearchAt);
});

test('only an apply link on Greenhouse, Lever or Ashby with a token and an id reaches the queue', () => {
  assert.equal(ing.boardTarget([{ url: 'https://careers.globex.test/1', publisher: '' }]), null);
  assert.equal(ing.boardTarget([{ url: 'https://acme.test/careers?gh_jid=5', publisher: '' }]), null, 'no token');
  assert.equal(ing.boardTarget([{ url: 'https://boards.greenhouse.io/acme', publisher: '' }]), null, 'no job id');
  assert.equal(ing.boardTarget([{ url: 'https://jobs.lever.co/acme/abc/apply', publisher: '' }]).url, 'https://jobs.lever.co/acme/abc');
  assert.equal(ing.boardTarget([{ url: 'https://x.test', publisher: '' }, { url: 'https://jobs.ashbyhq.com/Acme/uuid-1/application', publisher: '' }]).token, 'Acme');
});

test('a second ingest of the same file adds nothing: dedupe across runs', async () => {
  const again = await run(doc());
  assert.equal(again.added, 0);
  assert.equal(again.applyYourself, 0);
  assert.equal(Object.keys(store.loadState().jobs).length, 1);
});

test('dedupe across routed postings and watched boards: one job, same key', async () => {
  reset();
  const payload = await sweep.runSweep({ state: store.loadState(), profile: { includeOld: true, watch: [{ url: 'https://boards.greenhouse.io/figma' }] }, overlay: empty, fetch: fakeFetch({ 'https://boards-api.greenhouse.io/': board }), now: NOW });
  sweep.persist(payload);
  const before = Object.keys(store.loadState().jobs).length;
  await run(doc());
  assert.equal(Object.keys(store.loadState().jobs).length, before, 'the routed posting is already a watched job');
});

test('a schema failure holds the source, with the reason, and invents nothing', async () => {
  reset();
  const bad = doc();
  delete bad.postings[0].employer;
  const r = await run(bad);
  assert.equal(r.added, 0);
  assert.match(r.held[0], /routed:job_postings: posting 0: title and employer are required/);
  const long = doc();
  long.postings[0].description = 'x'.repeat(2001);
  assert.match((await run(long)).held[0], /at most 2,000 characters/);
  const noLinks = doc();
  noLinks.postings[0].applyLinks = [{ url: 'u' }];
  assert.match((await run(noLinks)).held[0], /applyLinks/);
  assert.match((await run(null)).held[0], /not an object/);
  assert.ok(store.loadState().held.some((h) => h.reason === 'source_empty' && h.detail.startsWith('routed:')));
});

test('a status that is not a delivered result holds the source', async () => {
  reset();
  for (const status of ['needs_approval', 'failed', 'pending', '']) {
    const d = doc();
    d.status = status;
    const r = await run(d);
    assert.equal(r.added, 0);
    assert.match(r.held[0], /status|missing/);
  }
});

test('an empty list holds the source', async () => {
  reset();
  const d = doc();
  d.postings = [];
  assert.match((await run(d)).held[0], /the list is empty/);
  assert.equal((await run({ ...fixture('ingest-x-posts.json'), posts: [] })).held[0].includes('x_hiring_posts'), true);
});

test('a board that cannot be read holds that board, not the whole source', async () => {
  reset();
  const r = await run(doc(), { fetch: fakeFetch({ 'https://boards-api.greenhouse.io/': 429 }) });
  assert.match(r.held[0], /board greenhouse:figma unavailable \(rate limited \(429\)\)/);
  assert.equal(r.applyYourself, 1);
});

test('X posts are stored for review, once, and become a post_review item', async () => {
  reset();
  assert.equal((await run(fixture('ingest-x-posts.json'))).posts, 1);
  assert.equal((await run(fixture('ingest-x-posts.json'))).posts, 0);
  const wl = work.workList({ now: NOW });
  assert.ok(wl.items.some((i) => i.reason === 'post_review'));
});

test('search_due: due with no search yet, not due after one, due again after a day; none without Tenjin', () => {
  reset();
  const s = store.loadState();
  const items = (st, now) => work.buildWorkList(st, empty, now, profile).items.filter((i) => i.reason === 'search_due');
  const [due] = items(s, NOW);
  assert.deepEqual(due.query, { role: 'software engineer', place: 'Berlin', remote: false, since: '2026-11-09' });
  s.routed.lastSearchAt = new Date(NOW - 3600000).toISOString();
  assert.equal(items(s, NOW).length, 0);
  assert.equal(items(s, NOW + 27 * 3600000).length, 1);
  s.routed.lastSearchAt = null;
  s.held.push({ reason: 'tenjin_missing', detail: 'missing' });
  assert.equal(items(s, NOW).length, 0);
  assert.equal(work.buildWorkList(s, empty, NOW, {}).items.length, 0, 'no search settings, no item');
});

test('the report: new jobs with their board, apply yourself, held sources, watched boards, cost', async () => {
  reset();
  await run(doc());
  const s = store.loadState();
  s.held.push({ reason: 'source_empty', detail: 'Figma (greenhouse:figma): http 500' });
  s.watched = { checked: 2, ok: 1, at: 'x' };
  const text = report.renderReport(s, empty, { now: NOW });
  assert.match(text, /on its own board: greenhouse:figma/);
  assert.match(text, /## Apply yourself \(1\)[\s\S]*careers\.globex\.test\/apply\/2 \(Globex\)/);
  assert.match(text, /## Sources held this run[\s\S]*http 500/);
  assert.match(text, /Watched boards checked: 1 of 2 answered/);
  assert.match(text, /Cost the router reported: \$0\.01/);
  assert.doesNotMatch(text, /did not run/);
});

test('the "routed search did not run" row names the reason, and the watched boards still run', async () => {
  reset();
  store.updateState((s) => { s.held.push({ reason: 'tenjin_missing', detail: 'missing' }); });
  assert.match(report.renderReport(store.loadState(), empty, { now: NOW }), /## The routed search did not run\n- no Tenjin \(missing\)\. The watched boards still ran\./);
  reset();
  const home = process.env.HOME;
  assert.equal(runJobs(home, ['routed', 'skip', 'no Tenjin request tool until the next session']).code, 0);
  assert.match(report.renderReport(store.loadState(), empty, { now: NOW }), /request tool until the next session\. The watched boards still ran/);
  // a sweep of watched boards works with no Tenjin at all
  const payload = await sweep.runSweep({ state: store.loadState(), profile: { watch: [{ url: 'https://boards.greenhouse.io/figma' }], includeOld: true }, overlay: empty, fetch: fakeFetch({ 'https://boards-api.greenhouse.io/': board }), now: NOW });
  assert.ok(payload.jobs.length > 0);
});

test('the ingest command reads a file; a broken file holds, exits 4 and never throws', async () => {
  reset();
  const fs = await import('node:fs');
  const path = await import('node:path');
  const f = path.join(process.env.HOME, 'bad.json');
  fs.writeFileSync(f, '{ not json');
  const r = runJobs(process.env.HOME, ['ingest', f]);
  assert.equal(r.code, 4);
  assert.match(r.json.held[0], /not an object/);
});
