import test from 'node:test';
import assert from 'node:assert/strict';
import { mkJob, runJobs, tmpHome, noReferrals } from './helpers/env.mjs';

const home = tmpHome();
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const work = await import('../../skills/job-search/scripts/lib/work.mjs');
const lease = await import('../../skills/loop-base/lib/lease.mjs');
const watcher = await import('../../skills/job-search/scripts/lib/watcher.mjs');
const overlay = await import('../../skills/job-search/scripts/lib/overlay.mjs');
const NOW = Date.parse('2026-11-23T12:00:00Z');
const reset = (jobs = []) => { store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; }); noReferrals(); };

test('the work-list has items, held, inventory, rules, lessons; an empty one says so and still exits 0', () => {
  reset();
  const empty = work.workList({ now: NOW });
  assert.deepEqual(Object.keys(empty).sort(), ['bring', 'empty', 'held', 'heldForPeriod', 'inventory', 'items', 'lessons', 'notify', 'notifyQuiet', 'rules']);
  assert.equal(empty.empty, true);
  const r = runJobs(home, ['work']);
  assert.equal(r.code, 0, 'an empty list is not an error: a new user sees no failure');
  assert.equal(r.json.empty, true);
  reset([mkJob()]);
  assert.equal(work.workList({ now: NOW }).empty, false);
  assert.equal(runJobs(home, ['work']).code, 0);
});

test('J work --commit says to start the watcher last; J work without --commit does not, and J arm keeps its own text', () => {
  reset([mkJob()]);
  const plain = runJobs(home, ['work']);
  assert.equal(plain.json.then, undefined);
  const commit = runJobs(home, ['work', '--commit']);
  assert.equal(commit.code, 0);
  assert.match(commit.json.then, /start J watch last, with run_in_background, after every item is handed out or done/);
  assert.equal(runJobs(home, ['arm']).json.watch.startsWith('start J watch with the Bash tool, run_in_background true'), true, 'the arm text is unchanged');
});

test('every item carries its closed reason and gate text', () => {
  reset([mkJob(), mkJob({ status: 'shortlisted', needsWriting: true }), mkJob({ status: 'apply_ready' })]);
  const wl = work.workList({ now: NOW });
  const reasons = wl.items.map((i) => i.reason).sort();
  assert.deepEqual(reasons, ['apply_ready', 'new_job', 'prepare_due']);
  for (const i of wl.items) assert.ok(i.gate);
});

test('a parked item never wakes the model again until its key or reasons change', () => {
  const j = mkJob();
  reset([j]);
  store.updateState((s) => work.park(s.jobs[j.key], ['captcha']));
  assert.equal(work.workList({ now: NOW }).items.length, 0);
  assert.equal(work.workList({ now: NOW }).empty, true);
  assert.equal(work.workList({ now: NOW }).inventory.length, 1);
  // same key, same reasons: no change
  assert.equal(store.updateState((s) => work.park(s.jobs[j.key], ['captcha'])), false);
  // changed reasons: a change
  assert.equal(store.updateState((s) => work.park(s.jobs[j.key], ['captcha', 'login'])), true);
  // changed content (key includes the hash): a change
  store.updateState((s) => { s.jobs[j.key].hash = 'other'; });
  assert.equal(store.updateState((s) => work.park(s.jobs[j.key], ['captcha', 'login'])), true);
});

test('the notify line: a new item notifies once, an unchanged parked set does not, a changed reason does', () => {
  const j = mkJob({ company: 'Globex' });
  reset([j]);
  store.updateState((s) => work.park(s.jobs[j.key], ['captcha']));
  const first = work.workList({ now: NOW, commit: true });
  assert.match(first.notify, /Globex/);
  assert.ok(first.notify.length < 200);
  assert.doesNotMatch(first.notify, /[*_`#\[\]]/);
  assert.equal(work.workList({ now: NOW, commit: true }).notify, null);
  store.updateState((s) => work.park(s.jobs[j.key], ['login']));
  assert.ok(work.workList({ now: NOW, commit: true }).notify);
  assert.equal(work.workList({ now: NOW, commit: true }).notify, null);
});

test('applications waiting for a yes notify; notify_off and quiet hours silence it', () => {
  reset([mkJob({ status: 'apply_ready' }), mkJob({ status: 'apply_ready' })]);
  assert.match(work.workList({ now: NOW }).notify, /2 applications wait for your yes/);
  overlay.addRule({ effect: 'notify_off', value: true, words: 'stop notifying me' });
  assert.equal(work.workList({ now: NOW }).notify, null);
  overlay.removeRule(overlay.loadOverlay().rules[0].id);
  const h = new Date(NOW).getHours();
  overlay.addRule({ effect: 'notify_quiet_hours', value: `${h}-${(h + 2) % 24}`, words: 'no pushes at night' });
  assert.equal(work.workList({ now: NOW, commit: true }).notify, null);
  // not committed while quiet, so it still pushes after quiet hours
  overlay.removeRule(overlay.loadOverlay().rules[0].id);
  assert.ok(work.workList({ now: NOW, commit: true }).notify);
});

test('the lease is refused while fresh and reclaimed when stale', async () => {
  reset();
  assert.equal((await lease.claimLease({ holder: 'a', now: NOW })).ok, true);
  const refused = await lease.claimLease({ holder: 'b', now: NOW + 60000 });
  assert.equal(refused.ok, false);
  assert.equal(refused.heldBy, 'a');
  assert.equal((await lease.claimLease({ holder: 'b', now: NOW + 4 * 60000 })).ok, true);
  assert.equal(lease.heartbeat('a', NOW + 5 * 60000), false);
  assert.equal(lease.heartbeat('b', NOW + 5 * 60000), true);
});

test('a quiet watcher tick prints nothing; news prints once', async () => {
  reset();
  await lease.claimLease({ holder: 'w', now: NOW });
  const seen = { sig: null };
  assert.deepEqual((await watcher.tick({ holder: 'w', now: NOW + 1000, seen })).lines, []);
  store.updateState((s) => { const j = mkJob(); s.jobs[j.key] = j; });
  const t1 = await watcher.tick({ holder: 'w', now: NOW + 2000, seen });
  assert.equal(t1.lines.length, 1);
  assert.match(t1.lines[0], /1 new_job/);
  assert.deepEqual((await watcher.tick({ holder: 'w', now: NOW + 3000, seen })).lines, []);
});

test('a watcher that lost its lease says so and stops', async () => {
  reset();
  await lease.claimLease({ holder: 'x', now: NOW });
  const r = await watcher.tick({ holder: 'someone-else', now: NOW + 1000, seen: { sig: null } });
  assert.equal(r.stop, true);
});

test('arm arms once: a live watcher of another session holds the lease, and a stale lease or a dead process is reclaimed', () => {
  reset();
  const a = runJobs(home, ['arm']);
  assert.equal(a.json.armed, true);
  assert.match(a.json.watch, /J watch/);
  assert.equal(a.json.monitor, undefined, 'no Monitor command');
  const live = () => store.updateState((s) => { s.lease = { holder: 'w1', heartbeat: new Date().toISOString(), lastTick: new Date().toISOString(), pid: process.pid }; });
  live();
  assert.equal(runJobs(home, ['arm']).json.armed, false, 'a live watcher holds it');
  store.updateState((s) => { s.lease.lastTick = new Date(Date.now() - 3 * 60000).toISOString(); s.lease.heartbeat = s.lease.lastTick; });
  assert.equal(runJobs(home, ['arm']).json.armed, true, 'a lease older than twice the tick interval is reclaimed');
  store.updateState((s) => { s.lease = { holder: 'w2', heartbeat: new Date().toISOString(), lastTick: new Date().toISOString(), pid: 2147483000 }; });
  assert.equal(runJobs(home, ['arm']).json.armed, true, 'a dead process is reclaimed');
});
