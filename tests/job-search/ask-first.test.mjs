import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const work = await import(`${S}work.mjs`);
const report = await import(`${S}report.mjs`);
const empty = { rules: [], lessons: [] };
const NOW = Date.now();
const dir = () => path.join(process.env.TENJIN_SKILLS_DIR, 'job-search');
const J = (...a) => runJobs(home, a);
const reset = (tenjin, jobs = [], extra = {}) => {
  fs.rmSync(path.join(dir(), 'rules.json'), { force: true });
  fs.rmSync(path.join(dir(), 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState(), { tenjin }, extra); for (const j of jobs) s.jobs[j.key] = j; });
  J('profile', 'set', JSON.stringify({ search: { role: 'software engineer', place: 'Berlin' } }));
};
const noPosting = (i) => mkJob({ key: `https://www.example-jobs.test/view/${i}`, status: 'reviewed', employerPosting: null, openConfirmed: false, unresolved: 'no_board', company: `Co${i}`, employerWebsite: `co${i}.test`, v: 1 });

test('askDue: Tenjin not ready, attended, and the session\'s ask unanswered; one answer clears every moment', () => {
  const st = (tenjin, extra = {}) => ({ ...store.emptyState(), tenjin, ...extra });
  assert.equal(work.askDue(st({ status: 'missing' })), true);
  assert.equal(work.askDue(st({ status: 'outdated' })), true);
  assert.equal(work.askDue(st({ status: 'unfunded' })), true);
  assert.equal(work.askDue(st({ status: 'ready' })), false);
  assert.equal(work.askDue(st({ status: 'missing' }), { unattended: true }), false, 'nobody there: no ask');
  assert.equal(work.askDue(st({ status: 'missing', askedHolder: 'none' })), false, 'answered this session');
  assert.equal(work.askFirst(st({ status: 'missing' }), 'daily_search').moment, 'daily_search');
  assert.equal(work.askFirst(st({ status: 'ready' }), 'daily_search'), null);
});

test('J search plan prints the ask in place of the free queries until the ask is answered', () => {
  reset({ status: 'missing' });
  const a = J('search', 'plan').json;
  assert.deepEqual([a.ask, a.moment], ['tenjin', 'daily_search']);
  assert.equal(a.queries, undefined, 'no free query is handed out before the ask');
  assert.match(a.hint.line, /router's job-posting search/);
  assert.equal(a.question.questions[0].options[0].label, 'Install Tenjin (Recommended)');
  assert.equal(J('search', 'plan').json.ask, 'tenjin', 'still due until answered');
  J('tenjin', 'ask-done', 'no');
  assert.equal(J('search', 'plan').json.queries.length, 5, 'Not now: the free search runs, and no second ask');
  // Tenjin ready: no ask
  reset({ status: 'ready' });
  assert.equal(J('search', 'plan').json.queries.length, 5);
});

test('unattended: no ask that waits, the free path runs', () => {
  reset({ status: 'missing' });
  assert.equal(J('search', 'plan', '--unattended').json.queries.length, 5);
  assert.equal(store.loadState().tenjin.askedHolder, undefined, 'the ask waits for the next attended moment');
});

test('a yes holds the round as tenjin_setup until Tenjin is ready; the next period runs the free path with no new ask', () => {
  reset({ status: 'missing' }, [noPosting(1)]);
  const before = work.buildWorkList(store.loadState(), empty, NOW, { search: { role: 'se' } }).items.map((i) => i.reason).sort();
  assert.deepEqual(before, ['employer_page', 'search_due']);
  assert.equal(J('tenjin', 'ask-done', 'yes').code, 0);
  const s = store.loadState();
  assert.ok(s.held.some((h) => h.reason === 'tenjin_setup'));
  assert.deepEqual(work.buildWorkList(s, empty, NOW, { search: { role: 'se' } }).items, [], 'held: neither the search round nor the careers read runs');
  assert.match(report.renderReport(s, empty, { now: NOW }), /## Waiting for Tenjin/);
  assert.equal(work.askDue(s), false, 'a yes is an answer');
  // ready: the hold ends and the round runs through the router
  store.updateState((x) => { x.tenjin.status = 'ready'; });
  assert.ok(work.buildWorkList(store.loadState(), empty, NOW, { search: { role: 'se' } }).items.some((i) => i.reason === 'search_due'));
  // still not ready at the next period: the free path runs, with its hint and no new ask
  store.updateState((x) => { x.tenjin.status = 'missing'; });
  const next = work.buildWorkList(store.loadState(), empty, NOW + 2 * 86400000, { search: { role: 'se' } });
  assert.ok(next.items.some((i) => i.reason === 'search_due'));
  assert.equal(work.askDue(store.loadState()), false);
});

test('J work prints the ask in place of the careers-page task text; contacts keep their free ways and ask when a job is left with none', () => {
  const j = noPosting(2);
  reset({ status: 'missing' }, [j], { contactsRequested: [j.key] });
  const w = J('work').json;
  const page = w.items.find((i) => i.reason === 'employer_page');
  assert.deepEqual([page.ask.ask, page.ask.moment], ['tenjin', 'employer_posting']);
  assert.equal(page.gate, undefined, 'no free-path task text before the ask');
  const c = w.items.find((i) => i.reason === 'contacts_requested');
  assert.ok(c.gate && !c.ask, 'the free ways come first, with their task text');
  const left = J('leave', `contacts:${j.key}`, '--reason', 'none_found').json;
  assert.deepEqual([left.askTenjin.ask, left.askTenjin.moment], ['tenjin', 'contacts']);
  // answered once: nothing asks again, at any moment
  J('tenjin', 'ask-done', 'no');
  const after = J('work').json.items.find((i) => i.reason === 'employer_page');
  assert.ok(after.gate && !after.ask);
  assert.equal(J('leave', `contacts:${j.key}`, '--reason', 'none_found').json.askTenjin, null);
  // unattended: the free path runs
  reset({ status: 'missing' }, [noPosting(3)]);
  const un = J('work', '--unattended').json.items.find((i) => i.reason === 'employer_page');
  assert.ok(un.gate && !un.ask);
});

test('Tenjin outdated gets the same ask, naming the update', () => {
  reset({ status: 'outdated', version: '0.1.0-alpha.20' });
  const a = J('search', 'plan').json;
  assert.equal(a.ask, 'tenjin');
  assert.match(a.hint.line, /Tenjin 0\.1\.0-alpha\.20 is out of date/);
  const l = work.askFirst(store.loadState(), 'linkedin_resume');
  assert.match(l.hint.line, /is out of date/);
});

test('SKILL.md: run a free path only from what those commands printed', () => {
  const skill = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'SKILL.md'), 'utf8');
  assert.match(skill, /only from what `J search plan`, `J resume set --url` and `J work` printed/);
});
