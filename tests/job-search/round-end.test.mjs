import test from 'node:test';
import assert from 'node:assert/strict';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const b = await import('../../skills/job-search/scripts/lib/batch.mjs');
const store = await import('../../skills/job-search/scripts/lib/store.mjs');

const profile = { eeo: 'decline_all', resumePath: '/r.pdf', unattended: { roles: ['engineer'], places: ['Berlin'], minScore: 70, hosts: ['greenhouse'] }, search: { role: 'engineer', place: 'Berlin' } };
const hasSearch = () => runJobs(home, ['work']).json.items.some((i) => i.reason === 'search_due');
const setup = (jobs = []) => {
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; });
  runJobs(home, ['profile', 'set', JSON.stringify(profile)]);
};
const open = (mode) => runJobs(home, ['batch', 'open', ...(mode === 'unattended' ? ['--unattended'] : []), '--upload', '/r.pdf']);
const ago = (ms) => store.updateState((s) => { s.batch.touchedAt = new Date(Date.now() - ms).toISOString(); });

test('an unattended round that ends closes the batch in code, and the search comes back', () => {
  setup();
  runJobs(home, ['consent', 'record', 'unattended', '--optional-writing', 'skip']);
  runJobs(home, ['dryrun', 'record', 'k', '{}']);
  runJobs(home, ['dryrun', 'confirm']);
  open('unattended');
  assert.equal(hasSearch(), false, 'the search waits while the batch is open');
  const r = runJobs(home, ['apply', 'next', '--unattended']);
  assert.equal(r.json.handout, null);
  assert.equal(r.json.batchClosed, true);
  assert.equal(b.batchExists(), false);
  assert.equal(hasSearch(), true, 'search_due is back');
  assert.equal(runJobs(home, ['apply', 'next', '--unattended']).json.refused, 'no_batch', 'no batch, nothing to hand out');
});

test('a round with a job left to submit stays open; held and parked jobs end it', () => {
  const j = mkJob({ status: 'apply_ready', fit: 90, verifiedAt: new Date().toISOString(), sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [] } });
  setup([j]);
  runJobs(home, ['consent', 'record', 'unattended', '--optional-writing', 'skip']);
  runJobs(home, ['dryrun', 'record', 'k', '{}']);
  runJobs(home, ['dryrun', 'confirm']);
  open('unattended');
  const first = runJobs(home, ['apply', 'next', '--unattended']);
  assert.equal(first.json.handout.key, j.key);
  assert.equal(first.json.batchClosed, false);
  assert.equal(b.batchExists(), true);
  runJobs(home, ['park', j.key, 'captcha']);
  assert.equal(runJobs(home, ['apply', 'next', '--unattended']).json.batchClosed, true);
});

test('a captcha, chrome_disconnected or no_chrome_tools stop closes an unattended batch; an attended batch stays', () => {
  const j = mkJob();
  for (const kind of ['captcha', 'chrome_disconnected', 'no_chrome_tools']) {
    setup([j]);
    open('unattended');
    const r = runJobs(home, ['stop', j.key, '--kind', kind]);
    assert.equal(r.json.batchClosed, true, kind);
    assert.equal(b.batchExists(), false);
  }
  setup([j]);
  open('attended');
  assert.equal(runJobs(home, ['stop', j.key, '--kind', 'captcha']).json.batchClosed, false);
  assert.equal(b.batchExists(), true);
  runJobs(home, ['batch', 'close']);
});

test('batch close works in both modes', () => {
  for (const mode of ['attended', 'unattended']) {
    setup();
    open(mode);
    assert.equal(runJobs(home, ['batch', 'close']).json.closed, true);
    assert.equal(b.batchExists(), false);
  }
});

test('a stale batch (two hours with no activity) counts as closed, and the next work call cleans it up', () => {
  setup();
  open('unattended');
  assert.equal(b.STALE_MS, 2 * 3600 * 1000);
  ago(b.STALE_MS - 60000);
  assert.equal(b.isActive(), true);
  ago(b.STALE_MS + 60000);
  assert.equal(b.isActive(), false);
  assert.equal(b.isStale(), true);
  assert.equal(runJobs(home, ['consent', 'record', 'writing']).code, 0, 'a stale batch no longer blocks consent');
  const w = runJobs(home, ['work']);
  assert.equal(w.json.staleBatchClosed, true);
  assert.equal(b.batchExists(), false);
  assert.ok(w.json.items.some((i) => i.reason === 'search_due'));
});

test('activity keeps a batch alive: apply next refreshes the record', () => {
  setup();
  open('attended');
  ago(60 * 60 * 1000);
  runJobs(home, ['apply', 'next']);
  assert.ok(Date.now() - Date.parse(store.loadState().batch.touchedAt) < 60000);
  assert.equal(b.isStale(), false);
  runJobs(home, ['batch', 'close']);
});

test('no_chrome_tools: one reason, one notification, nothing submitted, not counted as applied', () => {
  const j = mkJob({ status: 'apply_ready', company: 'Initech', fit: 90, verifiedAt: new Date().toISOString(), sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [] } });
  setup([j]);
  store.updateState((s) => { s.approvals[j.key] = { sheetHash: 'h' }; });
  open('attended');
  const stop = runJobs(home, ['stop', j.key, '--kind', 'no_chrome_tools']);
  assert.equal(stop.code, 0);
  let s = store.loadState();
  assert.deepEqual(s.held.filter((h) => h.reason === 'no_chrome_tools').map((h) => h.detail), ['Initech']);
  assert.equal(s.applications.length, 0);
  assert.equal(s.jobs[j.key].status, 'apply_ready');
  const w1 = runJobs(home, ['work', '--commit']);
  assert.match(w1.json.notify, /no chrome tools/);
  assert.equal(runJobs(home, ['work', '--commit']).json.notify, null, 'one notification');
  const next = runJobs(home, ['apply', 'next']);
  assert.deepEqual(next.json.queue, [{ key: j.key, reason: 'no_chrome_tools' }]);
  assert.equal(next.json.handout, null);
  assert.equal(store.loadState().jobs[j.key].parked, null, 'held by its own reason, not parked a second time');
  runJobs(home, ['unpark', j.key]);
  s = store.loadState();
  assert.equal(s.held.some((h) => h.reason === 'no_chrome_tools'), false);
  assert.ok(runJobs(home, ['apply', 'next']).json.handout, 'it can be tried again after the person fixes it');
});
