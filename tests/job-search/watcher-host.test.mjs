import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JOBS, SKILL, mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const lease = await import('../../skills/loop-base/lib/lease.mjs');
const watcher = await import(`${S}watcher.mjs`);
const work = await import(`${S}work.mjs`);

const dir = () => path.join(process.env.TENJIN_SKILLS_DIR, 'job-search');
const reset = (jobs = []) => {
  fs.rmSync(path.join(dir(), 'rules.json'), { force: true });
  fs.rmSync(path.join(dir(), 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; });
  runJobs(home, ['profile', 'set', JSON.stringify({ updates: false })]);
};
const due = (i) => mkJob({ key: `https://www.example-jobs.test/view/${i}`, status: 'reviewed', employerPosting: null, openConfirmed: false, unresolved: 'no_board', company: `Co${i}`, employerWebsite: `co${i}.test`, v: 1 });
// the watcher with no network, no real sleep, and its lines collected
const run = async (opts = {}) => {
  const lines = [];
  const r = await watcher.runWatcher({ write: (l) => lines.push(l), sleep: async () => {}, runner: async () => ({ code: 0 }), ...opts });
  return { ...r, out: lines };
};

test('a quiet state keeps ticking with no output and never exits because of time', async () => {
  reset();
  const r = await run({ maxTicks: 60 });
  assert.equal(r.reason, 'max_ticks', 'it only stopped because the test said so');
  assert.deepEqual(r.out, ['watching; exits when work is due'], 'one start line, then nothing');
  assert.equal(store.loadState().lease, null, 'the lease is released when it ends');
});

// The round's work arrives while the watcher runs, as it does in a live round: `add` runs during the first sleep.
const arriving = (add) => { let done = false; return async () => { if (!done) { done = true; add(); } }; };
const claimAll = () => work.workList({ commit: true }); // J work --commit: what the round handed out is claimed

test('it exits 0 with one line when an actionable wake is due, and that line names the work', async () => {
  reset();
  const r = await run({ maxTicks: 10, sleep: arriving(() => store.updateState((s) => { for (const j of [due(1), due(2)]) s.jobs[j.key] = j; })) });
  assert.equal(r.reason, 'due');
  assert.equal(r.exit, 0);
  assert.equal(r.out.length, 2);
  assert.equal(r.out[0], 'watching; exits when work is due');
  assert.match(r.out[1], /^Job Search round: run J work --commit --unattended \(J is node .*scripts\/jobs\.mjs\), handle each item, then start J watch last with run_in_background\. Due: 2 employer_page\.$/);
  assert.equal(store.loadState().lease, null);
});

test('a restarted watcher reads the stored fingerprint: it does not exit again for the same due set, only for a new item or a new version', async () => {
  reset();
  assert.equal((await run({ maxTicks: 5, sleep: arriving(() => store.updateState((s) => { s.jobs[due(1).key] = due(1); })) })).reason, 'due');
  claimAll(); // the round handled its work and claimed it before the restart
  const again = await run({ maxTicks: 4 });
  assert.equal(again.reason, 'max_ticks', 'the same due set: no second exit');
  assert.deepEqual(again.out, ['watching; exits when work is due']);
  // a set that only shrinks keeps it running
  store.updateState((s) => { delete s.jobs[Object.keys(s.jobs)[0]]; });
  assert.equal((await run({ maxTicks: 3 })).reason, 'max_ticks');
  // a new item: it exits, and only once
  reset();
  await run({ maxTicks: 2 });
  const gained = await run({ maxTicks: 5, sleep: arriving(() => store.updateState((s) => { s.jobs[due(2).key] = due(2); })) });
  assert.equal(gained.reason, 'due');
  assert.match(gained.out[1], /1 employer_page/);
  claimAll();
  // a changed version of an item wakes it again, once it is no longer claimed
  store.updateState((s) => { s.jobs[Object.keys(s.jobs)[0]].fit = 41; });
  store.updateState((s) => { s.claims = {}; });
  assert.equal((await run({ maxTicks: 5, sleep: async () => {} })).reason, 'unclaimed', 'unclaimed due work blocks a restart');
});

test('a second watcher exits at once when another holds the lease; a dead one does not hold it', async () => {
  reset();
  store.updateState((s) => { s.lease = { holder: 'other', heartbeat: new Date().toISOString(), alive: new Date().toISOString(), pid: process.pid }; });
  const second = await run({ maxTicks: 5 });
  assert.equal(second.reason, 'lease_held');
  assert.deepEqual(second.out, ['another session holds the lease; work attended']);
  assert.equal(store.loadState().lease.holder, 'other', 'the first one keeps it');
  // its process is gone: the lease is reclaimed at once
  store.updateState((s) => { s.lease.pid = 2147483000; });
  assert.equal((await run({ maxTicks: 2, sleep: arriving(() => store.updateState((s) => { s.jobs[due(1).key] = due(1); })) })).reason, 'due');
  // stale by time: older than twice the tick interval
  store.updateState((s) => { s.lease = { holder: 'old', heartbeat: new Date(Date.now() - 3 * 60000).toISOString(), alive: new Date(Date.now() - 3 * 60000).toISOString(), pid: process.pid }; });
  assert.notEqual((await run({ maxTicks: 1 })).reason, 'lease_held');
  assert.equal(lease.STALE_MS, 2 * lease.TICK_MS);
});

test('the watcher records its process id and last tick in the lease', async () => {
  reset();
  let seen;
  await run({ maxTicks: 2, pid: process.pid, sleep: async () => { seen = seen || store.loadState().lease; } });
  assert.equal(seen.pid, process.pid);
  assert.ok(Date.parse(seen.lastTick) > Date.now() - 60000);
});

test('every J command reports watcher: stopped once armed and no watcher lives; none before, none while one runs', () => {
  reset();
  assert.equal(runJobs(home, ['profile', 'get']).json.watcher, undefined, 'before any arm there is no noise');
  assert.equal(runJobs(home, ['arm']).json.armed, true);
  assert.equal(runJobs(home, ['profile', 'get']).json.watcher, 'stopped', 'armed, but no watcher is running');
  assert.equal(runJobs(home, ['work']).json.watcher, 'stopped');
  const now = () => new Date().toISOString();
  store.updateState((s) => { s.lease = { holder: 'w', heartbeat: now(), lastTick: now(), pid: process.pid }; });
  assert.equal(runJobs(home, ['profile', 'get']).json.watcher, undefined, 'a live watcher with a recent tick');
  store.updateState((s) => { s.lease.lastTick = new Date(Date.now() - 5 * 60000).toISOString(); s.lease.heartbeat = s.lease.lastTick; });
  assert.equal(runJobs(home, ['profile', 'get']).json.watcher, 'stopped', 'a stale last tick');
  // J commands never write the liveness field
  const before = new Date(Date.now() - 20000).toISOString();
  store.updateState((s) => { s.lease.alive = before; s.lease.heartbeat = before; s.lease.lastTick = before; });
  runJobs(home, ['profile', 'get']);
  assert.equal(store.loadState().lease.alive, before, 'a J command did not refresh the liveness field');
  assert.equal(store.loadState().lease.heartbeat, before);
});

test('a tick that runs for 5 simulated minutes keeps the watcher running, because its timer refreshes the liveness field', async () => {
  reset();
  let t = Date.now();
  let fire = null;
  let stopped = 0;
  const checks = [];
  const tickImpl = async () => {
    for (let i = 0; i < 10; i++) {
      t += 30000; // 30 s of a slow provider, ten times
      fire();
      const st = store.loadState();
      checks.push(lease.watcherStatus(st, t).running);
      if (i === 9) {
        const second = await watcher.runWatcher({ write: (l) => checks.push(l), sleep: async () => {}, clock: () => t, tickImpl: async () => ({ lines: [], stop: false }), maxTicks: 1 });
        checks.push(second.reason);
      }
    }
    return { lines: [], stop: false };
  };
  const r = await watcher.runWatcher({ write: () => {}, sleep: async () => {}, clock: () => t, timer: (fn) => { fire = fn; return () => { stopped++; }; }, tickImpl, maxTicks: 1 });
  assert.equal(r.reason, 'max_ticks');
  assert.deepEqual(checks.filter((c) => typeof c === 'boolean'), Array(10).fill(true), 'running through 5 minutes');
  assert.ok(checks.includes('another session holds the lease; work attended'));
  assert.ok(checks.includes('lease_held'), 'a second J watch exits at once');
  assert.equal(stopped, 1, 'the timer stops with the watcher');
  // without the timer the same 5 minutes would read as stopped: that was the bug
  reset();
  t = Date.now();
  await lease.claimLease({ holder: 'w', pid: process.pid, now: t });
  assert.equal(lease.watcherStatus(store.loadState(), t + 5 * 60000).running, false);
  assert.equal(lease.watcherStatus(store.loadState(), t + 60000).running, true);
});

test('a dead pid is reclaimed, and a live but reused pid with a stale field is reclaimed too', async () => {
  reset();
  const at = (ms) => new Date(Date.now() - ms).toISOString();
  store.updateState((s) => { s.lease = { holder: 'dead', heartbeat: at(1000), alive: at(1000), pid: 2147483000 }; });
  assert.equal((await run({ maxTicks: 1 })).reason, 'max_ticks', 'a dead pid with a fresh field');
  store.updateState((s) => { s.lease = { holder: 'reused', heartbeat: at(10 * 60000), alive: at(10 * 60000), pid: process.pid }; });
  assert.equal(lease.watcherStatus(store.loadState()).running, false);
  assert.equal((await run({ maxTicks: 1 })).reason, 'max_ticks', 'the pid lives but the field is stale: another process now owns that pid');
  store.updateState((s) => { s.lease = { holder: 'reused', heartbeat: at(10 * 60000), alive: at(10 * 60000), pid: process.pid }; });
  assert.equal(runJobs(home, ['arm']).json.armed, true);
  // a live pid with a fresh field is never reclaimed
  store.updateState((s) => { s.lease = { holder: 'live', heartbeat: at(5000), alive: at(5000), pid: process.pid }; });
  assert.equal((await run({ maxTicks: 1 })).reason, 'lease_held');
});

test('the CLI: J watch prints one line, exits 0 when work arrives, and a second one exits at once', async () => {
  const { spawn } = await import('node:child_process');
  reset();
  const env = { ...process.env, HOME: home, TENJIN_SKILLS_DIR: process.env.TENJIN_SKILLS_DIR, PATH: '/usr/bin:/bin', JOB_SEARCH_TICK_MS: '200' };
  const child = spawn(process.execPath, [JOBS, 'watch'], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((res) => child.on('exit', (code) => res(code)));
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(out.trim(), 'watching; exits when work is due', 'quiet: one line and nothing more');
  store.updateState((s) => { s.jobs[due(7).key] = due(7); });
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 20000))]);
  assert.equal(code, 0);
  assert.match(out, /^watching; exits when work is due\nJob Search round: run J work --commit --unattended .*Due: 1 employer_page/);
  assert.equal(store.loadState().lease, null, 'the exited watcher released the lease');
  claimAll();
  store.updateState((s) => { s.lease = { holder: 'other', heartbeat: new Date().toISOString(), alive: new Date().toISOString(), pid: process.pid }; });
  const b = spawnSync(process.execPath, [JOBS, 'watch'], { encoding: 'utf8', env, timeout: 30000 });
  assert.equal(b.status, 0);
  assert.equal(b.stdout.trim(), 'another session holds the lease; work attended');
});

test('one path: no Monitor call, no Monitor branch, no persistent branch, and allowed-tools drops Monitor', () => {
  const skill = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.doesNotMatch(/^allowed-tools:.*$/m.exec(skill)[0], /Monitor/);
  const texts = [skill, ...fs.readdirSync(path.join(SKILL, 'references')).map((f) => fs.readFileSync(path.join(SKILL, 'references', f), 'utf8'))].join('\n');
  assert.doesNotMatch(texts, /timeout_ms|persistent|deadline message|re-run `J arm`|with Monitor/);
  assert.match(skill, /`J watch` last \(Bash tool, `run_in_background`/);
  assert.match(skill, /`watcher: stopped`/);
  assert.match(skill, /start it again after each round/);
  const lib = path.join(SKILL, 'scripts', 'lib');
  const code = fs.readdirSync(lib, { recursive: true }).filter((f) => f.endsWith('.mjs')).map((f) => fs.readFileSync(path.join(lib, f), 'utf8')).join('\n') + fs.readFileSync(path.join(SKILL, 'scripts', 'jobs.mjs'), 'utf8');
  assert.doesNotMatch(code, /Monitor command|--holder|Run this with Monitor/);
});
