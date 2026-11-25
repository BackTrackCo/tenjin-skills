import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fakeFetch, fixture, mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const router = await import(`${S}router.mjs`);
const routed = await import(`${S}routed.mjs`);
const work = await import(`${S}work.mjs`);
const prices = await import(`${S}prices.mjs`);

const NOW = Date.parse('2026-11-24T20:00:00Z');
const empty = { rules: [], lessons: [] };
const FAKE = path.join(import.meta.dirname, 'helpers', 'fake-tenjin.mjs');
const FX = Object.fromEntries(['job-postings', 'x-posts', 'exa-search'].map((n) => [n, fixture(`router/${n}.json`)]));
const reset = (jobs = []) => store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; });
function fake(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faketenjin-'));
  const sf = path.join(dir, 'script.json');
  const lf = path.join(dir, 'log.jsonl');
  fs.writeFileSync(sf, JSON.stringify(script));
  const bin = path.join(dir, 'tenjin');
  fs.writeFileSync(bin, `#!/bin/sh\nFAKE_SCRIPT="${sf}" FAKE_LOG="${lf}" exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  return { bin, log: () => (fs.existsSync(lf) ? fs.readFileSync(lf, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}
const client = (f, timeouts = {}) => new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300, ...timeouts } });
const sp = (n) => ({ ...FX[n].step1.json, __text: FX[n].step1.text });
const env = (n) => ({ ...FX[n].step2.envelope, result: JSON.stringify(FX[n].step2.envelope.result) });
const prof = { places: ['New York'], includeOld: true, search: { role: 'software engineer', place: 'New York City' } };
const need = { kind: 'job_postings', text: FX['job-postings'].step1.query, fields: { role: 'software engineer', place: 'New York City', remote: false, since: null, days: 3 }, query: { role: 'software engineer', place: 'New York City', remote: false, since: null } };

// A process the client can talk to: stdin lines are answered by `reply`, stdout is a real stream.
function mockProc({ reply, exitOnEnd = null, neverExits = false }) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; setImmediate(() => proc.emit('exit', 137)); };
  proc.stdin = {
    write: (line) => { const msg = JSON.parse(line); if (msg.id !== undefined) setImmediate(() => reply(msg, proc)); },
    end: () => { if (!neverExits) setTimeout(() => proc.emit('exit', 0), exitOnEnd ?? 0); },
  };
  return proc;
}
const ok = (id, text) => JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(text) }] } }) + '\n';

// ---- 31 -----------------------------------------------------------------------------------------------------------
test('31: a paid result is kept the moment it arrives and ingested at once; a kept one is finished at the next start without paying again', async () => {
  reset();
  const J = FX['job-postings'];
  const f = fake({ answers: [{ ...J.step1.json, __text: J.step1.text }, env('job-postings'), sp('x-posts'), sp('exa-search')] });
  const seen = [];
  const watch = setInterval(() => { const p = (store.loadState().routed.pendingIngest || []).length; if (p) seen.push(p); }, 1);
  await routed.routedRounds({ profile: prof, fetch: fakeFetch({}), client: client(f), now: NOW });
  clearInterval(watch);
  assert.deepEqual(store.loadState().routed.pendingIngest, [], 'ingested results leave the kept list');
  // a run killed between paying and ingesting leaves the result kept: the next start ingests it first
  store.updateState((st) => { st.routed.lastSearchAt = new Date(NOW).toISOString(); st.routed.pendingIngest = [{ at: 'a1', kind: 'job_postings', round: 0, ingest: { need: 'job_postings', status: 'fulfilled', query: { role: 'software engineer', place: 'New York City', remote: false, since: null }, fullResultPath: '/x', postings: [{ title: 'Kept Engineer', employer: 'Keptco', employerWebsite: null, city: 'New York', region: '', country: '', remote: false, employmentType: '', postedAt: null, salary: null, applyLinks: [{ url: 'https://www.example-jobs.test/kept', publisher: 'X' }], description: 'x', sourceUrl: 'https://www.example-jobs.test/kept' }] } }]; });
  const g = fake({ answers: [] });
  const log = await routed.routedRounds({ profile: prof, fetch: fakeFetch({}), client: client(g), now: NOW + 60000 });
  assert.ok(log.some((l) => l.status === 'recovered' && l.need === 'job_postings'), JSON.stringify(log));
  assert.ok(Object.values(store.loadState().jobs).some((j) => j.company === 'Keptco'), 'the kept result became a job');
  assert.deepEqual(store.loadState().routed.pendingIngest, []);
  assert.equal(g.log().filter((l) => l.call).length, 0, 'nothing was paid for again');
});

// ---- 32 -----------------------------------------------------------------------------------------------------------
test('32: two processes never run the same round', async () => {
  reset();
  store.updateState((s) => { s.routed.roundLock = { pid: process.ppid, at: new Date(NOW).toISOString() }; });
  const f = fake({ answers: [] });
  const log = await routed.routedRounds({ profile: prof, fetch: fakeFetch({}), client: client(f), now: NOW + 1000 });
  assert.deepEqual(log, [{ need: 'round', ok: false, status: 'already_running' }]);
  assert.equal(f.log().length, 0, 'nothing started');
  // a lock left by a process that is gone, or an old one, is taken over
  store.updateState((s) => { s.routed.roundLock = { pid: 999999, at: new Date(NOW).toISOString() }; });
  const g = fake({ answers: [] });
  const log2 = await routed.routedRounds({ profile: prof, fetch: fakeFetch({}), client: client(g), now: NOW + 1000 });
  assert.notDeepEqual(log2[0] && log2[0].status, 'already_running');
  assert.equal(store.loadState().routed.roundLock, null, 'the lock is released');
});

// ---- 33 -----------------------------------------------------------------------------------------------------------
test('33: a paid careers lookup follows the score floor, the period limit and a job that was left', () => {
  const mk = (i, fit) => mkJob({ key: `https://www.example-jobs.test/view/${i}`, status: 'reviewed', employerPosting: null, openConfirmed: false, unresolved: 'no_board', company: `Co${i}`, employerWebsite: `co${i}.test`, fit });
  const jobs = Array.from({ length: 10 }, (_, i) => mk(i, i < 4 ? 90 - i : 40));
  reset(jobs);
  const profile = { ...prof, unattended: { minScore: 70 } };
  const needs = (overlay = empty) => routed.jobNeeds(store.loadState(), profile, overlay, { kinds: ['careers_page'], now: NOW });
  assert.equal(needs().length, 4, 'only the jobs above the floor');
  assert.equal(needs({ rules: [{ effect: 'period_max', value: 2 }] }).length, 2, 'only the period\'s most');
  store.updateState((s) => { const j = s.jobs[jobs[0].key]; j.left = { reason: 'no_match', inputs: work.inputsHash(s, j, empty, profile, 'no_match'), at: new Date(NOW).toISOString() }; });
  assert.equal(needs().length, 3, 'a job that was left is not looked up');
});

// ---- 34 -----------------------------------------------------------------------------------------------------------
test('34: close waits for tenjin mcp to exit after stdin closes, and kills only after the shutdown time', async () => {
  const quick = mockProc({ reply: (m) => quick.stdout.write(ok(m.id, {})), exitOnEnd: 250 });
  const c = new router.RouterClient({ bin: 'x', spawn: () => quick, timeouts: { ...router.TIMEOUTS, shutdown: 1500 } });
  await c.start();
  await c.close();
  assert.equal(quick.killed, false, 'a process still finishing a deposit is not killed');
  const stuck = mockProc({ reply: (m) => stuck.stdout.write(ok(m.id, {})), neverExits: true });
  const d = new router.RouterClient({ bin: 'x', spawn: () => stuck, timeouts: { ...router.TIMEOUTS, shutdown: 200 } });
  await d.start();
  const t0 = Date.now();
  await d.close();
  assert.equal(stuck.killed, true);
  assert.ok(Date.now() - t0 >= 190, 'not before the shutdown time');
  assert.ok(router.TIMEOUTS.shutdown >= 31_000, 'the default is past the 30 s a deposit may take');
});

// ---- 35 -----------------------------------------------------------------------------------------------------------
test('35: a recorded Not now is honoured, a new lease is not a new session, and route commands run only with a ready Tenjin', () => {
  reset();
  store.updateState((s) => { s.tenjin.status = 'missing'; s.lease = { holder: 'a', heartbeat: new Date().toISOString() }; });
  assert.equal(work.tenjinAsk(store.loadState()), true);
  assert.equal(runJobs(home, ['tenjin', 'ask-done', 'no']).code, 0);
  store.updateState((s) => { s.lease = { holder: 'b', heartbeat: new Date().toISOString() }; });
  assert.equal(work.tenjinAsk(store.loadState()), false);
  // J route and J contacts route do nothing without a ready Tenjin
  runJobs(home, ['profile', 'set', JSON.stringify({ search: { role: 'e', place: 'x' } })]);
  for (const c of [['route'], ['contacts', 'route', 'k']]) {
    const r = runJobs(home, c);
    assert.equal(r.code, 4, c.join(' '));
    assert.equal(r.json.ran, false);
    assert.match(r.json.next, /nothing was sent to the router/);
  }
  // outdated: the outdated hint, nothing paid
  const dir = path.join(home, '.local', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tenjin'), '#!/bin/sh\ncase "$1" in --version) echo "0.0.1";; *) exit 1;; esac\n', { mode: 0o755 });
  try {
    const r = runJobs(home, ['route']);
    assert.equal(r.json.tenjin, 'outdated');
    assert.match(r.json.hint, /out of date/);
  } finally { fs.rmSync(path.join(dir, 'tenjin'), { force: true }); }
});

// ---- 36 -----------------------------------------------------------------------------------------------------------
test('36: output split in the middle of a character stays whole', async () => {
  const spec = { status: 'spec', name: 'Zürich Labs' };
  const proc = mockProc({ reply: (m, p) => {
    if (m.method === 'initialize') { p.stdout.write(ok(m.id, {})); return; }
    const bytes = Buffer.from(ok(m.id, spec));
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of the u with a diaeresis
    p.stdout.write(bytes.subarray(0, cut));
    setTimeout(() => p.stdout.write(bytes.subarray(cut)), 20);
  } });
  const c = new router.RouterClient({ bin: 'x', spawn: () => proc, timeouts: { ...router.TIMEOUTS, shutdown: 300 } });
  await c.start();
  const r = await c.request({ query: 'q' }, 2000);
  assert.equal(r.name, 'Zürich Labs');
  await c.close();
});

// ---- 37 ---------------------------------------------------------------------------------------------------------
test('37: a paid answer that is still running is collected with the free job check', async () => {
  const J = FX['job-postings'];
  const f = fake({ answers: [{ ...J.step1.json, __text: J.step1.text }, { ...env('job-postings'), status: 'running', job: 'job-9' }, env('job-postings')] });
  const [r] = await router.runRound([need], { client: client(f, { collect: 2000, poll: 10 }) });
  assert.equal(r.ok, true, JSON.stringify(r));
  const calls = f.log().filter((l) => l.call).map((l) => l.call);
  assert.deepEqual(calls.at(-1), { job: 'job-9' });
});

// ---- 56 ---------------------------------------------------------------------------------------------------------
test('56: after tenjin mcp exits, the next calls fail at once instead of waiting out a timeout', async () => {
  const proc = mockProc({ reply: (m, p) => { if (m.method === 'initialize') p.stdout.write(ok(m.id, {})); } });
  const c = new router.RouterClient({ bin: 'x', spawn: () => proc, timeouts: { ...router.TIMEOUTS, shutdown: 300 } });
  await c.start();
  proc.emit('exit', 1);
  const t0 = Date.now();
  await assert.rejects(c.request({ query: 'q' }, 30_000), /exited/);
  assert.ok(Date.now() - t0 < 500);
});

// ---- 57 ---------------------------------------------------------------------------------------------------------
test('57: a need the router answered but code cannot read does not go to the router again', async () => {
  reset();
  const unknown = { ...FX['x-posts'].step1.json, __text: 'Request: GET https://unknown-seller.example/search\n' };
  const J = FX['job-postings'];
  const f = fake({ answers: [{ ...J.step1.json, __text: J.step1.text }, env('job-postings'), unknown, sp('exa-search'), env('exa-search')] });
  await routed.routedRounds({ profile: prof, fetch: fakeFetch({}), client: client(f), now: NOW });
  const s = store.loadState();
  const pending = s.search.needPending.find((n) => n.kind === 'x_hiring_posts');
  assert.equal(pending.routerAnswered, true);
  const item = work.buildWorkList(s, empty, NOW, prof).items.find((i) => i.key === 'need:x_hiring_posts');
  assert.match(item.gate, /Do not send the need to the router again/);
});

// ---- 59 ---------------------------------------------------------------------------------------------------------
test('59: the round estimate follows the real number of variants', () => {
  const one = prices.roundCents({ search: { role: 'e' } });
  assert.ok(Math.abs(prices.roundCents({ search: { role: 'e', variants: ['a', 'b'] } }) - one * 3) < 1e-9);
  assert.ok(Math.abs(prices.roundCents({ search: { role: 'e', variants: Array.from({ length: 9 }, (_, i) => `v${i}`) } }) - one * 10) < 1e-9);
  assert.match(prices.hintLines({ search: { role: 'e', variants: ['a', 'b'] } }).daily_search, /About \d+(\.\d)?¢ a round, the role and 2 variants\./);
  assert.match(prices.hintLines({ search: { role: 'e' } }).daily_search, /About \d+(\.\d)?¢ a round\.$/);
  assert.equal(JSON.stringify(require_graph()).includes('variantsPerRound'), false);
  function require_graph() { return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'graph.json'), 'utf8')); }
});
