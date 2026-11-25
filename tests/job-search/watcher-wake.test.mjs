import test from 'node:test';
import assert from 'node:assert/strict';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const work = await import('../../skills/job-search/scripts/lib/work.mjs');
const lease = await import('../../skills/job-search/scripts/lib/lease.mjs');
const watcher = await import('../../skills/job-search/scripts/lib/watcher.mjs');
const report = await import('../../skills/job-search/scripts/lib/report.mjs');
const dedupe = await import('../../skills/job-search/scripts/lib/dedupe.mjs');

const NOW = Date.parse('2026-11-23T12:00:00Z');
const empty = { rules: [], lessons: [] };
const reviewedNoPosting = (i) => mkJob({ key: `https://www.example-jobs.test/view/${i}`, status: 'reviewed', employerPosting: null, openConfirmed: false, unresolved: 'no_board', company: `Co${i}`, title: `Engineer ${i}`, applyLinks: [`https://www.example-jobs.test/view/${i}`], v: 1 });
import fs from 'node:fs';
import path from 'node:path';
const reset = (jobs = []) => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'rules.json'), { force: true }); // rules from an earlier test must not leak
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; });
};
const tick = async (seen, at) => (await watcher.tick({ holder: 'w', now: at, seen })).lines;
const arm = async () => { await lease.claimLease({ holder: 'w', now: NOW }); };

test('37 left employer_page items give no wake, and show in the report as left alone', async () => {
  const jobs = Array.from({ length: 37 }, (_, i) => reviewedNoPosting(i));
  reset(jobs);
  await arm();
  assert.equal(work.workList({ now: NOW }).items.filter((i) => i.reason === 'employer_page').length, 37);
  assert.equal(runJobs(home, ['leave', ...jobs.map((j) => j.key), '--reason', 'low_score']).json.left, 37);
  const wl = work.workList({ now: NOW });
  assert.equal(wl.items.length, 0);
  assert.equal(wl.inventory.filter((i) => i.left === 'low_score').length, 37, 'left items are inventory');
  assert.equal(wl.empty, true);
  assert.deepEqual(await tick({ sig: null }, NOW + 1000), [], 'no wake');
  const text = report.renderReport(store.loadState(), empty, { now: NOW });
  assert.match(text, /## Left alone \(37\)/);
  assert.match(text, /Engineer 3, Co3: low_score/);
  assert.equal(runJobs(home, ['leave']).code, 2, 'a reason is needed');
  for (const bad of ['whatever', 'because', 'no-match']) assert.equal(runJobs(home, ['leave', jobs[0].key, '--reason', bad]).code, 2, `${bad} is not in the closed list`);
  for (const ok of ['low_score', 'no_match', 'no_careers_page', 'sign_in', 'other_system', 'not_a_job', 'duplicate']) assert.equal(runJobs(home, ['leave', jobs[0].key, '--reason', ok]).code, 0, ok);
  const rec = store.loadState().jobs[jobs[0].key].left;
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'inputs', 'reason']);
  assert.match(rec.inputs, /^[0-9a-f]{16}$/);
});

test('a new item wakes once; the same due set again, even after a restart or a re-arm, gives no second wake', async () => {
  const jobs = [reviewedNoPosting(1)];
  reset(jobs);
  await arm();
  const first = await tick({ sig: null }, NOW + 1000);
  assert.equal(first.length, 1);
  assert.match(first[0], /1 employer_page/);
  // a new process (a re-arm) has no memory, but the fingerprint is kept in state
  for (let i = 0; i < 3; i++) assert.deepEqual(await tick({ sig: null }, NOW + 60000 * (i + 2)), []);
  assert.deepEqual(await tick({ sig: null }, NOW + 24 * 3600000 * 3), [], 'no repeat on a timer');
  assert.ok(store.loadState().watcher.fingerprint.includes('employer_page'));
  // a second item arrives: one wake, naming only the new one
  store.updateState((s) => { const j = reviewedNoPosting(2); s.jobs[j.key] = j; });
  const second = await tick({ sig: null }, NOW + 25 * 3600000 * 3);
  assert.equal(second.length, 1);
  assert.match(second[0], /1 employer_page/);
  assert.deepEqual(await tick({ sig: null }, NOW + 26 * 3600000 * 3), []);
  // an item's state version changes: it wakes again
  store.updateState((s) => { s.jobs[jobs[0].key].fit = 55; }); // any write to the item raises its version
  assert.equal((await tick({ sig: null }, NOW + 27 * 3600000 * 3)).length, 1);
  // the due set only shrinks: no wake
  store.updateState((s) => { delete s.jobs[jobs[0].key]; });
  assert.deepEqual(await tick({ sig: null }, NOW + 28 * 3600000 * 3), []);
});

test('a left item comes back only on its triggers: news about the job, the person\'s answer, or a rule that affects it', async () => {
  const j = reviewedNoPosting(7);
  const k = reviewedNoPosting(8);
  reset([j, k]);
  const due = () => work.workList({ now: NOW, commit: true }).items.map((i) => i.key);
  runJobs(home, ['leave', j.key, '--reason', 'low_score']);
  assert.deepEqual(due(), [k.key]);
  // time alone does nothing
  assert.deepEqual(work.workList({ now: NOW + 90 * 86400000 }).items.map((i) => i.key), [k.key]);
  // a rule that does not affect it does nothing; one that does brings it back
  runJobs(home, ['rules', 'add', '--effect', 'notify_off', '--value', 'true', '--words', 'quiet']);
  assert.deepEqual(due(), [k.key]);
  runJobs(home, ['rules', 'add', '--effect', 'exclude_term', '--value', 'sales', '--words', 'no sales']);
  assert.deepEqual(due().sort(), [j.key, k.key].sort(), 'a rule change comes back');
  assert.equal(store.loadState().jobs[j.key].left, null);
  // news about the job: a changed posting (new data) bumps its version
  runJobs(home, ['leave', j.key, '--reason', 'no_match']);
  assert.deepEqual(due(), [k.key]);
  store.updateState((s) => { dedupe.mergeJobs(s, [{ ...s.jobs[j.key], desc: 'a changed posting', title: s.jobs[j.key].title }], new Date(NOW).toISOString()); });
  assert.ok(due().includes(j.key), 'new data comes back');
  // the person's answer
  runJobs(home, ['leave', j.key, '--reason', 'no_careers_page']);
  assert.deepEqual(due(), [k.key]);
  runJobs(home, ['fact', 'set', 'phone', '+49 151 0000000']);
  assert.ok(!due().includes(j.key), 'a saved form fact revives no left job (B1)');
  runJobs(home, ['leave', j.key, '--reason', 'sign_in']);
  runJobs(home, ['fact', 'set', 'account', 'example-jobs.test']);
  assert.ok(due().includes(j.key), 'the person says they have an account there: it comes back');
  // a board that could match joins the watch list: it comes back
  runJobs(home, ['leave', j.key, '--reason', 'no_match']);
  assert.deepEqual(due(), [k.key]);
  store.updateState((st) => { st.found = [{ board: 'greenhouse:co7', ats: 'greenhouse', token: 'co7', region: 'us', name: 'Co7', source: 'found', job: 'x', date: 'd', lastRoleJobAt: 'd' }]; });
  assert.ok(due().includes(j.key), 'a board that could match joins the list');
  // the person says "try again"
  runJobs(home, ['leave', j.key, '--reason', 'sign_in']);
  assert.ok(!due().includes(j.key));
  assert.equal(runJobs(home, ['retry', j.key]).json.retried, 1);
  assert.ok(due().includes(j.key), 'try again');
  // a re-verify that changes the content hash comes back; one that only touches the clock does not
  store.updateState((st) => { dedupe.mergeJobs(st, [{ ...st.jobs[k.key] }], new Date(NOW).toISOString()); }); // settle the content hash
  runJobs(home, ['leave', k.key, '--reason', 'low_score']);
  store.updateState((st) => { dedupe.mergeJobs(st, [{ ...st.jobs[k.key] }], new Date(NOW + 86400000).toISOString()); });
  assert.ok(!due().includes(k.key), 'verified again with no change: still left');
});

test('items that wait for the person never wake the model; they keep their one notification', async () => {
  const sheet = (over) => mkJob({ status: 'apply_ready', company: 'Initech', fit: 90, verifiedAt: new Date(NOW).toISOString(), sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [] }, v: 1, ...over });
  const waiting = sheet({});
  const filled = sheet({ key: 'https://boards.greenhouse.io/acme/jobs/50', fillReady: { at: new Date(NOW).toISOString() } });
  const follow = mkJob({ status: 'submitted', statusAt: new Date(NOW - 20 * 86400000).toISOString(), v: 1, key: 'https://boards.greenhouse.io/acme/jobs/51' });
  reset([waiting, filled, follow]);
  await arm();
  const wl = work.workList({ now: NOW });
  assert.deepEqual(wl.items.map((i) => [i.reason, i.waitsForPerson]).sort(), [['apply_ready', true], ['fill_ready', true], ['follow_up_due', true]]);
  // the first sight wakes once, for the notification only
  const first = await tick({ sig: null }, NOW + 1000);
  assert.equal(first.length, 1);
  assert.match(first[0], /notify: /);
  assert.doesNotMatch(first[0], /apply_ready|fill_ready|follow_up_due/);
  work.workList({ now: NOW, commit: true });
  for (let i = 2; i < 6; i++) assert.deepEqual(await tick({ sig: null }, NOW + i * 3600000), [], 'never again');
  // once the person says yes, the same sheet becomes work the model can act on
  store.updateState((s) => { s.approvals[waiting.key] = { sheetHash: 'h' }; });
  const actionable = work.workList({ now: NOW }).items.find((i) => i.key === waiting.key);
  assert.equal(actionable.waitsForPerson, false);
  const woke = await tick({ sig: null }, NOW + 7 * 3600000);
  assert.match(woke[0], /1 apply_ready/);
  // in an auto mode a ready sheet is work the model can act on
  reset([sheet({})]);
  runJobs(home, ['profile', 'set', JSON.stringify({ applyMode: 'auto_no_new' })]);
  assert.equal(work.workList({ now: NOW }).items[0].waitsForPerson, false);
});

test('a job is not left across search or post items: leave refuses an unknown key', () => {
  reset();
  assert.equal(runJobs(home, ['leave', 'search', '--reason', 'x']).code, 2);
});

test('SKILL.md says every handled item ends with its outcome command', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const skill = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'SKILL.md'), 'utf8');
  assert.match(skill, /Every handled item ends with its J outcome command/);
  assert.match(skill, /or the watcher shows it again/);
});
