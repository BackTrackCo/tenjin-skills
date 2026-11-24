import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeFetch, fixture, mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const sweep = await import('../../skills/job-search/scripts/lib/sweep.mjs');
const { normalizeUrl } = await import('../../skills/job-search/scripts/lib/dedupe.mjs');
const { screenJob } = await import('../../skills/job-search/scripts/lib/verify.mjs');
const work = await import('../../skills/job-search/scripts/lib/work.mjs');

const NOW = Date.parse('2026-11-23T10:00:00Z');
const empty = { rules: [], lessons: [] };
const gh = () => fixture('greenhouse-figma.json');
const profile = { watch: [{ name: 'Figma', ats: 'greenhouse', token: 'figma' }], includeOld: true };

test('a sweep reads the board, dedupes, and persists new jobs', async () => {
  const ff = fakeFetch({ 'https://boards-api.greenhouse.io/v1/boards/figma': gh() });
  const payload = await sweep.runSweep({ state: store.loadState(), profile, overlay: empty, fetch: ff, now: NOW });
  const r1 = sweep.persist(payload);
  assert.equal(r1.added, gh().jobs.length);
  assert.equal(ff.calls.length, 1);
  const payload2 = await sweep.runSweep({ state: store.loadState(), profile, overlay: empty, fetch: ff, now: NOW });
  assert.equal(sweep.persist(payload2).added, 0);
});

test('closed means absent from the board list', async () => {
  const board = gh();
  const gone = board.jobs.pop();
  const payload = await sweep.runSweep({ state: store.loadState(), profile, overlay: empty, fetch: fakeFetch({ 'https://boards-api.greenhouse.io/': board }), now: NOW });
  assert.ok(payload.closedKeys.includes(normalizeUrl(`https://boards.greenhouse.io/figma/jobs/${gone.id}`)));
  sweep.persist(payload);
  assert.equal(store.loadState().jobs[normalizeUrl(`https://boards.greenhouse.io/figma/jobs/${gone.id}`)].status, 'closed');
});

test('a source that returns nothing is held for the run and named', async () => {
  const p = await sweep.runSweep({ state: store.loadState(), profile, overlay: empty, fetch: fakeFetch({ 'https://boards-api.greenhouse.io/': 429 }), now: NOW });
  assert.equal(p.held[0].reason, 'source_empty');
  assert.match(p.held[0].detail, /Figma.*429/);
  assert.equal(p.jobs.length, 0);
});

test('a city query drops a remote-only job unless remote was said', () => {
  const remoteOnly = mkJob({ city: '', region: '', country: '', remote: true });
  const berlin = mkJob({ city: 'Berlin' });
  const base = { places: ['Berlin'], includeOld: true };
  assert.ok(screenJob(remoteOnly, base, empty, NOW).drop.includes('outside_place'));
  assert.deepEqual(screenJob(berlin, base, empty, NOW).drop, []);
  assert.deepEqual(screenJob(remoteOnly, { ...base, remote: true }, empty, NOW).drop, []);
});

test('date window, contracts and old listings', () => {
  const old = mkJob({ posted: new Date(NOW - 20 * 864e5).toISOString() });
  assert.ok(screenJob(old, { windowDays: 14 }, empty, NOW).drop.includes('outside_date_window'));
  const stale = mkJob({ posted: new Date(NOW - 90 * 864e5).toISOString() });
  assert.ok(screenJob(stale, { windowDays: 14 }, empty, NOW).warnings.includes('listed over 60 days'));
  assert.ok(screenJob(mkJob({ type: 'Contract' }), {}, empty, NOW).warnings.includes('contract'));
});

test('cross-source merge keeps one job and records the other URL', () => {
  const a = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/1', url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'Backend Engineer' });
  store.updateState((s) => { s.jobs = {}; s.jobs[a.key] = a; });
  const dupe = { ...a, url: 'https://jobs.lever.co/acme/abc', ats: 'lever' };
  store.updateState((s) => { return require_merge(s, [dupe]); });
  const s = store.loadState();
  assert.equal(Object.keys(s.jobs).length, 1);
  assert.deepEqual(s.jobs[a.key].alsoAt, ['https://jobs.lever.co/acme/abc']);
});
import { mergeJobs } from '../../skills/job-search/scripts/lib/dedupe.mjs';
function require_merge(s, jobs) { return mergeJobs(s, jobs, new Date().toISOString()); }

test('a dropped job never comes back after compact', () => {
  const j = mkJob({ status: 'skipped', statusAt: new Date(NOW - 60 * 864e5).toISOString() });
  store.updateState((s) => { s.jobs = { [j.key]: j }; store.compact(s, NOW); });
  store.updateState((s) => { mergeJobs(s, [{ ...j, status: undefined }], new Date(NOW).toISOString()); });
  assert.equal(store.loadState().jobs[j.key], undefined);
});

test('an unchanged content hash skips review; a changed one asks again', () => {
  const j = mkJob({ status: 'new', reviewedHash: 'h1', hash: 'h1' });
  store.updateState((s) => { s.jobs = { [j.key]: j }; });
  assert.deepEqual(work.workList({ now: NOW }).items.filter((i) => i.key === j.key), []);
  store.updateState((s) => { s.jobs[j.key].hash = 'h2'; });
  assert.equal(work.workList({ now: NOW }).items.find((i) => i.key === j.key).reason, 'review_due');
});

test('catch-up math: due after 20 hours on the first tick, capped at 14 days', () => {
  const s = store.emptyState();
  assert.equal(sweep.sweepDue(s, NOW), true);
  s.sweep.lastAt = new Date(NOW - 5 * 3600000).toISOString();
  assert.equal(sweep.sweepDue(s, NOW, { firstTick: true }), false);
  s.sweep.lastAt = new Date(NOW - 21 * 3600000).toISOString();
  assert.equal(sweep.sweepDue(s, NOW, { firstTick: true }), true);
  s.sweep.lastAt = new Date(NOW - 40 * 864e5).toISOString();
  assert.equal(sweep.catchUpDays(s, NOW), 14);
  s.sweep.lastAt = new Date(NOW - 3 * 864e5).toISOString();
  assert.equal(sweep.catchUpDays(s, NOW), 4);
});

test('an unreplaced [PATH TO RESUME] asks and reads nothing', () => {
  const r = runJobs(home, ['setup', 'resume', '[PATH TO RESUME]']);
  assert.equal(r.code, 4);
  assert.equal(r.json.read, false);
  assert.equal(fs.existsSync(path.join(home, '.tenjin-skills', 'job-search', 'profile.json')), false);
});
