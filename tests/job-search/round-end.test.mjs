import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const g = await import('../../skills/job-search/scripts/lib/guard.mjs');
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const work = await import('../../skills/job-search/scripts/lib/work.mjs');

const profile = { eeo: 'decline_all', resumePath: path.join(home, 'r.pdf'), unattended: { roles: ['engineer'], places: ['Berlin'], minScore: 70, hosts: ['greenhouse'] }, search: { role: 'engineer', place: 'Berlin' } };
const hasSearch = () => runJobs(home, ['work']).json.items.some((i) => i.reason === 'search_due');
const setup = (jobs = []) => {
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; });
  runJobs(home, ['profile', 'set', JSON.stringify(profile)]);
};
const openProven = (mode) => {
  runJobs(home, ['guard', 'install']);
  const open = runJobs(home, ['batch', 'open', ...(mode === 'unattended' ? ['--unattended'] : []), '--upload', profile.resumePath]);
  const p = JSON.parse(fs.readFileSync(g.policyFile(), 'utf8'));
  runJobs(home, ['guard', 'hook'], { input: JSON.stringify({ tool_name: 'Bash', session_id: 's', tool_input: { command: `${p.commandPrefix} guard probe ${open.json.nonce}` } }) });
};
const ago = (ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(g.activeFile(), t, t); };

test('an unattended round that ends closes the batch in code, and the search comes back', () => {
  setup();
  runJobs(home, ['consent', 'record', 'unattended', '--optional-writing', 'skip']);
  runJobs(home, ['dryrun', 'record', 'k', '{}']);
  runJobs(home, ['dryrun', 'confirm']);
  openProven('unattended');
  assert.equal(hasSearch(), false, 'the search waits while the batch is open');
  const r = runJobs(home, ['apply', 'next', '--unattended']);
  assert.equal(r.json.handout, null);
  assert.equal(r.json.batchClosed, true);
  assert.equal(g.batchExists(), false);
  assert.equal(hasSearch(), true, 'search_due is back');
  assert.equal(runJobs(home, ['apply', 'next', '--unattended']).json.batchClosed, false, 'no batch, nothing to close');
});

test('a round with a job left to submit stays open; held and parked jobs end it', () => {
  const j = mkJob({ status: 'apply_ready', fit: 90, verifiedAt: new Date().toISOString(), sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [] } });
  setup([j]);
  runJobs(home, ['consent', 'record', 'unattended', '--optional-writing', 'skip']);
  runJobs(home, ['dryrun', 'record', 'k', '{}']);
  runJobs(home, ['dryrun', 'confirm']);
  openProven('unattended');
  const first = runJobs(home, ['apply', 'next', '--unattended']);
  assert.equal(first.json.handout.key, j.key);
  assert.equal(first.json.batchClosed, false);
  assert.equal(g.batchExists(), true);
  runJobs(home, ['park', j.key, 'captcha']);
  assert.equal(runJobs(home, ['apply', 'next', '--unattended']).json.batchClosed, true);
});

test('a captcha or chrome_disconnected stop closes an unattended batch; an attended batch stays', () => {
  const j = mkJob();
  for (const kind of ['captcha', 'chrome_disconnected']) {
    setup([j]);
    openProven('unattended');
    const r = runJobs(home, ['stop', j.key, '--kind', kind]);
    assert.equal(r.json.batchClosed, true, kind);
    assert.equal(g.batchExists(), false);
  }
  setup([j]);
  openProven('attended');
  assert.equal(runJobs(home, ['stop', j.key, '--kind', 'captcha']).json.batchClosed, false);
  assert.equal(g.batchExists(), true);
  runJobs(home, ['batch', 'close']);
});

test('batch close works in both modes', () => {
  for (const mode of ['attended', 'unattended']) {
    setup();
    openProven(mode);
    assert.equal(runJobs(home, ['batch', 'close']).json.closed, true);
    assert.equal(g.batchExists(), false);
  }
});

test('a stale batch counts as closed, and the next work call cleans it up', () => {
  setup();
  openProven('unattended');
  assert.equal(g.STALE_MS, 2 * 3600 * 1000);
  ago(g.STALE_MS - 60000);
  assert.equal(g.isActive(), true);
  ago(g.STALE_MS + 60000);
  assert.equal(g.isActive(), false);
  assert.equal(g.isStale(), true);
  assert.equal(runJobs(home, ['consent', 'record', 'writing']).code, 0, 'a stale batch no longer blocks consent');
  assert.equal(g.batchExists(), true, 'the hook marker stays until work cleans it up');
  const w = runJobs(home, ['work']);
  assert.equal(w.json.staleBatchClosed, true);
  assert.equal(g.batchExists(), false);
  assert.ok(w.json.items.some((i) => i.reason === 'search_due'));
});

test('activity keeps a batch alive: every hook call refreshes the marker', () => {
  setup();
  openProven('attended');
  ago(60 * 60 * 1000);
  runJobs(home, ['guard', 'hook'], { input: JSON.stringify({ tool_name: 'Read', tool_input: {} }) });
  assert.ok(Date.now() - fs.statSync(g.activeFile()).mtimeMs < 60000);
  assert.equal(g.isStale(), false);
  runJobs(home, ['batch', 'close']);
});

test('a broken policy never leaves the person with no way out: only batch close is allowed through', () => {
  setup();
  openProven('unattended');
  fs.writeFileSync(g.policyFile(), '{ broken');
  const deny = (command) => runJobs(home, ['guard', 'hook'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }) }).stdout;
  const prefix = `node "${path.join(path.resolve(import.meta.dirname, '..', '..'), 'skills', 'job-search', 'scripts', 'jobs.mjs')}"`;
  assert.match(deny(`${prefix} work`), /deny/);
  assert.equal(deny(`${prefix} batch close`), '');
  assert.equal(runJobs(home, ['batch', 'close']).json.closed, true);
});
