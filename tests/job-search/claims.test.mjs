import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const work = await import(`${S}work.mjs`);
const lease = await import(`${S}lease.mjs`);
const watcher = await import(`${S}watcher.mjs`);

const dir = () => path.join(process.env.TENJIN_SKILLS_DIR, 'job-search');
const J = (...a) => runJobs(home, a);
const fresh = (i) => mkJob({ key: `https://www.example-jobs.test/view/${i}`, status: 'new', employerPosting: null, openConfirmed: false, unresolved: 'no_board', company: ['MixRank', 'Ledgebrook', 'Rippling'][i % 3], title: `Engineer ${i}`, employerWebsite: `co${i}.test`, hash: `h${i}`, v: 1 });
const reset = (jobs = []) => {
  fs.rmSync(path.join(dir(), 'rules.json'), { force: true });
  fs.rmSync(path.join(dir(), 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; });
  J('profile', 'set', JSON.stringify({ updates: false }));
};
const run = async (opts = {}) => {
  const lines = [];
  const r = await watcher.runWatcher({ write: (l) => lines.push(l), sleep: async () => {}, runner: async () => ({ code: 0 }), ...opts });
  return { ...r, out: lines };
};
const rank = (jobs) => jobs.flatMap((j) => [{ op: 'rank', key: j.key, fit: 70, line: 'ok' }, { op: 'transition', key: j.key, to: 'reviewed' }]);

test('the live-run sequence: ops makes three employer_page items, they are claimed by J work --commit, and the watcher does not exit for them', async () => {
  const jobs = [fresh(1), fresh(2), fresh(3)];
  reset(jobs);
  assert.equal(J('work', '--commit').json.items.length, 3, 'the round handed out the three new jobs, now claimed');
  let n = 0;
  const log = [];
  const sleep = async () => {
    n++;
    if (n !== 1) return;
    // the model's turn, while the watcher runs: ops, then the next hand-out
    assert.equal(J('ops', JSON.stringify(rank(jobs))).code, 0);
    const w = J('work', '--commit').json;
    log.push(w.items.map((i) => i.reason));
  };
  const r = await run({ maxTicks: 7, sleep });
  assert.equal(r.reason, 'max_ticks', 'no exit for the three claimed items, over six more ticks');
  assert.deepEqual(r.out, ['watching; exits when work is due']);
  assert.deepEqual(log[0], ['employer_page', 'employer_page', 'employer_page']);
  assert.equal(Object.keys(store.loadState().claims).length, 3);
  // started again as the last step, with everything claimed, it runs
  assert.equal((await run({ maxTicks: 2 })).reason, 'max_ticks');
});

test('a watcher started in the middle of a round refuses with one line naming the unclaimed items, then runs once they are claimed', async () => {
  const jobs = [fresh(1), fresh(2), fresh(3)];
  reset(jobs);
  J('work', '--commit');
  J('ops', JSON.stringify(rank(jobs)));
  const mid = await run({ maxTicks: 3 });
  assert.equal(mid.reason, 'unclaimed');
  assert.deepEqual(mid.out, ['not started: 3 employer_page due and not handed out; run J work --commit, hand them out, then start J watch last']);
  assert.equal(store.loadState().lease, null, 'nothing was started');
  const cli = J('watch');
  assert.match(cli.stdout, /not started: 3 employer_page/);
  assert.equal(cli.code, 0);
  J('work', '--commit');
  assert.equal((await run({ maxTicks: 2 })).reason, 'max_ticks', 'claimed: it runs');
  // work that waits for the person never blocks the restart
  reset([mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/57', status: 'apply_ready', fit: 90, sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [] }, v: 1 })]);
  assert.notEqual((await run({ maxTicks: 1 })).reason, 'unclaimed');
});

test('without the claim the same three items woke the watcher: that was the noise', async () => {
  const jobs = [fresh(1), fresh(2), fresh(3)];
  reset(jobs);
  J('work', '--commit');
  let n = 0;
  const r = await run({ maxTicks: 7, sleep: async () => { n++; if (n === 1) J('ops', JSON.stringify(rank(jobs))); } });
  assert.equal(r.reason, 'due');
  assert.match(r.out[1], /3 employer_page/);
});

test('a claim that times out on a still-open item wakes once, with a version change', async () => {
  const j = fresh(4);
  reset([j]);
  store.updateState((s) => { Object.assign(s.jobs[j.key], { status: 'reviewed', reviewedHash: s.jobs[j.key].hash, fit: 70 }); });
  const T0 = Date.parse('2026-11-25T10:00:00Z');
  work.workList({ now: T0, commit: true });
  assert.ok(store.loadState().claims[`${j.key}|employer_page`]);
  await lease.claimLease({ holder: 'w', pid: process.pid, now: T0 });
  const tick = async (at) => (await watcher.tick({ holder: 'w', now: at, seen: { sig: null } })).lines;
  assert.deepEqual(await tick(T0 + 60000), [], 'claimed: no wake');
  assert.deepEqual(await tick(T0 + 19 * 60000), [], 'still inside the limit');
  assert.equal(work.CLAIM_MS, 20 * 60000);
  const woke = await tick(T0 + 21 * 60000);
  assert.equal(woke.length, 1, 'the claim timed out on an item still open: one wake');
  assert.match(woke[0], /1 employer_page/);
  assert.deepEqual(await tick(T0 + 22 * 60000), [], 'once, not again');
  assert.equal(store.loadState().claims[`${j.key}|employer_page`], undefined);
});

test('a claim ends when its result is ingested, when the item is left, and when the item is no longer due', () => {
  const [a, b, c] = [fresh(5), fresh(6), fresh(7)];
  reset([a, b, c]);
  store.updateState((s) => { for (const j of [a, b, c]) Object.assign(s.jobs[j.key], { status: 'reviewed', reviewedHash: s.jobs[j.key].hash, fit: 70 }); });
  J('work', '--commit');
  const claims = () => Object.keys(store.loadState().claims || {}).map((k) => k.split('|')[0]).sort();
  assert.deepEqual(claims(), [a.key, b.key, c.key].sort());
  // ingest of the careers-page result for a job
  const file = path.join(dir(), 'careers.json');
  fs.writeFileSync(file, JSON.stringify({ need: 'careers_page', jobKey: a.key, careersUrl: 'https://co5.test/careers', status: 'fulfilled', boardLinks: [], otherLinks: [] }));
  J('ingest', file);
  assert.ok(!claims().includes(a.key), 'ingest ends the claim');
  // J leave ends it too
  J('leave', b.key, '--reason', 'low_score');
  assert.ok(!claims().includes(b.key), 'leave ends the claim');
  // an item that is no longer due (its outcome ran) is dropped when the claims settle
  store.updateState((s) => { s.jobs[c.key].status = 'skipped'; });
  const items = work.workList({ commit: false }).items;
  store.updateState((s) => work.settleClaims(s, items));
  assert.deepEqual(claims(), []);
});

test('claims hide nothing from the person: J work still lists claimed items, and items that wait for the person are never claimed', () => {
  const waiting = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/55', status: 'apply_ready', fit: 90, sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [] }, v: 1 });
  reset([fresh(8), waiting]);
  const first = J('work', '--commit').json;
  assert.equal(first.items.length, 2);
  assert.equal(J('work').json.items.length, 2, 'the same list again');
  const claimed = Object.keys(store.loadState().claims);
  assert.equal(claimed.length, 1, 'only the item the model can act on');
  assert.match(claimed[0], /new_job$/);
});

test('an apply loop keeps its claims alive: each hand-out refreshes the apply_ready claims', () => {
  const j = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/56', status: 'apply_ready', fit: 90, sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [] }, v: 1 });
  reset([j]);
  const old = new Date(Date.now() - 15 * 60000).toISOString();
  store.updateState((s) => { s.claims = { [`${j.key}|apply_ready`]: { at: old } }; work.refreshClaims(s, 'apply_ready'); });
  assert.ok(Date.now() - Date.parse(store.loadState().claims[`${j.key}|apply_ready`].at) < 60000);
});

test('SKILL.md: start J watch last, after J work --commit claimed everything handed out, and rewrite a refused ingest file, never sed', async () => {
  const skill = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'SKILL.md'), 'utf8');
  assert.match(skill, /start `J watch` last, after `J work --commit` claimed everything handed out/);
  assert.match(skill, /Rewrite a refused ingest file, never `sed` it/);
  assert.match(skill, /it refuses while due work is unclaimed/);
});
