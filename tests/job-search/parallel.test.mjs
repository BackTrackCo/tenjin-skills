import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const ap = await import(`${S}apply.mjs`);
const approval = await import(`${S}approval.mjs`);
const J = (...a) => runJobs(home, a);
const empty = { rules: [], lessons: [] };
const ep = (host, n) => ({ url: `https://${host}/acme/jobs/${n}`, system: 'employer_site', token: null, jobId: null, source: 'careers_page', confidence: 'confirmed' });
const job = (n, host, over = {}) => mkJob({ key: `https://${host}/acme/jobs/${n}`, status: 'apply_ready', company: `Co${n}`, fit: 100 - n, verifiedAt: new Date().toISOString(), employerPosting: ep(host, n), sheet: { hash: `h${n}`, passed: true, eeoMissing: false, fields: [] }, v: 1, ...over });
const reset = (jobs) => {
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) { s.jobs[j.key] = j; s.approvals[j.key] = { sheetHash: j.sheet.hash }; } });
  J('profile', 'set', JSON.stringify({ eeo: 'decline_all' }));
};

test('apply next --all hands out every passing job, one per host; the rest wait for their host and are not parked', () => {
  const a = job(1, 'jobs.one.test'); const b = job(2, 'jobs.two.test'); const c = job(3, 'jobs.one.test'); const d = job(4, 'jobs.three.test');
  reset([a, b, c, d]);
  J('batch', 'open');
  const r = J('apply', 'next', '--all');
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.handouts.map((h) => h.key), [a.key, b.key, d.key]);
  assert.deepEqual(r.json.queue, [{ key: c.key, reason: 'host_busy' }]);
  assert.equal(store.loadState().jobs[c.key].parked, null, 'a job that waits for its host is never parked');
  assert.equal(r.json.handout.key, a.key, 'the first is also in handout');
  // handed-out jobs are in flight: a second call hands out nothing new and the waiting one still waits
  const again = J('apply', 'next', '--all');
  assert.equal(again.json.handouts.length, 0);
  assert.deepEqual(again.json.queue, [{ key: c.key, reason: 'host_busy' }]);
  // the host frees when its job is filled: the waiting job goes out
  J('fillonly', a.key, 'on');
  store.updateState((s) => { s.jobs[a.key].fillReady = { at: new Date().toISOString() }; s.jobs[a.key].inFlight = null; });
  const third = J('apply', 'next', '--all');
  assert.deepEqual(third.json.handouts.map((h) => h.key), [c.key]);
  // without --all one job goes out, as before
  const single = job(9, 'jobs.nine.test'); const single2 = job(10, 'jobs.ten.test');
  reset([single, single2]);
  J('batch', 'open');
  assert.equal(J('apply', 'next').json.handouts.length, 1);
});

test('claims and may-submit work per job; a stop on one job leaves the others handed out; a closed round says no for every job still open', () => {
  const a = job(21, 'jobs.one.test'); const b = job(22, 'jobs.two.test'); const c = job(23, 'jobs.three.test');
  reset([a, b, c]);
  J('batch', 'open');
  const r = J('apply', 'next', '--all');
  assert.equal(r.json.handouts.length, 3);
  const st = store.loadState();
  for (const k of [a.key, b.key, c.key]) assert.ok(ap.inFlight(st.jobs[k]), 'each job has its own claim');
  const may = (k) => approval.maySubmit(store.loadState(), { eeo: 'decline_all' }, empty, k, st.jobs[k].sheet.hash, true);
  assert.deepEqual([a.key, b.key, c.key].map((k) => may(k).ok), [true, true, true]);
  // a bot check on one job (attended) stops only that job
  const stop = J('stop', b.key, '--kind', 'upload_blocked');
  assert.equal(stop.json.batchClosed, false);
  assert.deepEqual([a.key, b.key, c.key].map((k) => may(k).ok), [true, false, true], 'the others are still handed out');
  assert.equal(may(b.key).why, 'stopped');
  assert.equal(store.loadState().jobs[b.key].inFlight, null);
  // a Chrome disconnect closes the round: every open job answers no
  J('stop', c.key, '--kind', 'chrome_disconnected', '--unattended');
  store.updateState((s) => { s.batch = null; });
  assert.deepEqual([a.key, c.key].map((k) => approval.maySubmit(store.loadState(), { eeo: 'decline_all' }, empty, k, st.jobs[k].sheet.hash, false).why), ['batch_closed', 'batch_closed']);
  assert.equal(J('may-submit', a.key, st.jobs[a.key].sheet.hash).code, 4, 'through the CLI too');
});

test('an unattended round closes only when nothing is handed out and nothing is still running', () => {
  const a = job(31, 'jobs.one.test');
  reset([a]);
  J('profile', 'set', JSON.stringify({ unattended: { roles: ['engineer'], places: ['Berlin'], minScore: 70, hosts: ['*'] } }));
  store.updateState((s) => { s.batch = { mode: 'unattended', uploadPath: null, denied: [], openedAt: new Date().toISOString(), touchedAt: new Date().toISOString() }; s.jobs[a.key].inFlight = { at: new Date().toISOString(), host: 'jobs.one.test' }; });
  const r = J('apply', 'next', '--all', '--unattended');
  assert.equal(r.json.batchClosed, false, 'a job still running keeps the round open');
  assert.ok(store.loadState().batch);
});

test('SKILL.md and apply.md: independent subagents of a wake start in one message as parallel calls, the writer stays one call', () => {
  const root = path.join(import.meta.dirname, '..', '..', 'skills', 'job-search');
  const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  assert.ok(skill.length <= 10000, `${skill.length}`);
  assert.match(skill, /start every independent subagent of a wake in one message as parallel Agent calls/);
  assert.match(skill, /the one writer call stays single/);
  assert.match(skill, /one job per host at a time \(`J apply next --all`\)/);
  const apply = fs.readFileSync(path.join(root, 'references', 'apply.md'), 'utf8');
  assert.match(apply, /in one message as parallel Agent calls, each in its own tab/);
  assert.doesNotMatch(apply, /One application at a time\./);
  assert.match(apply, /still run in turn/, 'the serial lines the plan keeps are said');
});
