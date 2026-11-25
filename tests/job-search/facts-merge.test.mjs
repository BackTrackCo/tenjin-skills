import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const facts = await import(`${S}facts.mjs`);
const work = await import(`${S}work.mjs`);
const J = (...a) => runJobs(home, a);
const EEO = 'Decline every voluntary demographic question (test placeholder).';
const q = (label, extra = {}) => ({ label, required: true, type: 'input_text', ...extra });
const sel = (label, options, extra = {}) => ({ label, required: true, type: 'multi_value_single_select', options, ...extra });
const reset = (profile = {}) => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'answers.json'), { force: true });
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState()); });
  J('profile', 'set', JSON.stringify({ eeoText: EEO, applyMode: 'attended', facts: { first_name: 'Pat', last_name: 'Example', email: 'pat@example.test' }, ...profile }));
};
// A job prepared with this form: its sheet is built and checked, so the missing facts are on it.
function prepared(n, company, questions) {
  const j = mkJob({ key: `https://boards.greenhouse.io/co${n}/jobs/${n}`, status: 'prepared', company, title: 'Engineer', verifiedAt: new Date().toISOString() });
  store.updateState((s) => { s.jobs[j.key] = j; });
  const file = path.join(home, `q${n}.json`);
  fs.writeFileSync(file, JSON.stringify([q('First Name'), q('Last Name'), q('Email'), ...questions]));
  assert.equal(J('sheet', 'build', j.key, '--questions', file).code, 0);
  J('sheet', 'check', j.key);
  return j;
}
const callsOf = (r) => r.json.calls.flatMap((c) => c.questions);

test('the same fact asked by two forms is one question that names both jobs and fills both', () => {
  reset();
  const a = prepared(1, 'Acme Placeholder', [q('Current company')]);
  const b = prepared(2, 'Beta Placeholder', [q('Current employer')]);
  const r = J('ask', 'facts');
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.count, 1, 'one merged question');
  const m = r.json.plain.message;
  assert.match(m, /Acme Placeholder, Beta Placeholder/);
  assert.equal(r.json.calls.length, 0, 'no fixed options: a plain message');
  const done = J('facts', 'answer', 'fact:current_company', 'Placeholder Corp');
  assert.equal(done.code, 0, done.stdout);
  assert.deepEqual(done.json.jobs.map((x) => x.missing), [0, 0], 'both sheets are complete');
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), 'utf8')).facts.current_company, 'Placeholder Corp');
  for (const k of [a.key, b.key]) assert.equal(store.loadState().jobs[k].sheet.passed, true);
  assert.equal(J('ask', 'facts').json.count, 0, 'nothing left to ask');
});

test('a fact the profile or an earlier answer already gives is never asked', () => {
  reset({ facts: { first_name: 'Pat', last_name: 'Example', email: 'pat@example.test', current_company: 'Placeholder Corp', school: 'Example University' } });
  prepared(3, 'Acme Placeholder', [q('Current company'), q('School')]);
  assert.equal(J('ask', 'facts').json.count, 0);
  // an earlier answer fills a later form
  reset();
  const a = prepared(4, 'Acme Placeholder', [sel('Are you open to relocation?', ['Yes', 'No'])]);
  const asked = J('ask', 'facts');
  assert.equal(asked.json.count, 1);
  const ans = J('facts', 'answer', 'q:are you open to relocation', 'Yes');
  assert.equal(ans.code, 0, ans.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'answers.json'), 'utf8')).entries.length, 1, ans.stdout);
  const b = prepared(5, 'Beta Placeholder', [sel('Are you open to relocation?', ['Yes', 'No'])]);
  assert.equal(J('ask', 'facts').json.count, 0, 'the same question is answered from the earlier answer');
  assert.equal(store.loadState().jobs[b.key].sheet.passed, true);
  assert.ok(a.key);
});

test('a fixed-option question goes through the question tool with the form\'s own options, and the answer fills every job', () => {
  reset();
  const a = prepared(6, 'Acme Placeholder', [sel('Are you authorized to work in the country?', ['Yes', 'No'])]);
  const b = prepared(7, 'Beta Placeholder', [sel('Are you authorized to work in the country?', ['Yes', 'No'])]);
  const r = J('ask', 'facts');
  const [only] = callsOf(r);
  assert.equal(r.json.calls.length, 1);
  assert.equal(only.header, 'Missing fact');
  assert.deepEqual(only.options.slice(0, 2).map((o) => o.label), ['Yes', 'No'], 'word for word');
  assert.match(only.question, /Acme Placeholder, Beta Placeholder/);
  assert.equal(r.json.plain, null);
  const id = r.json.calls[0].ids[0];
  const done = J('facts', 'answer', id, 'No');
  assert.deepEqual(done.json.jobs.map((x) => x.missing), [0, 0]);
  assert.equal(store.loadState().jobs[a.key].sheet.fields.find((f) => /authorized/.test(f.label)).value, 'No');
  assert.equal(store.loadState().jobs[b.key].sheet.fields.find((f) => /authorized/.test(f.label)).value, 'No');
});

test('more than 4 fixed-option questions give consecutive calls of at most 4, and many jobs are named by a count', () => {
  reset();
  const questions = Array.from({ length: 6 }, (_, i) => sel(`Pick option number ${i + 1}?`, ['Alpha', 'Beta']));
  for (let n = 10; n < 15; n++) prepared(n, `Company ${n} Placeholder`, questions);
  const r = J('ask', 'facts');
  assert.deepEqual(r.json.calls.map((c) => c.questions.length), [4, 2]);
  for (const c of r.json.calls) assert.ok(c.questions.length <= 4);
  assert.match(r.json.calls[0].questions[0].question, /and 2 more/);
  assert.ok(r.json.calls[0].questions[0].question.length <= 300);
});

test('questions with no fixed options come in one plain message, merged and naming their jobs', () => {
  reset();
  prepared(20, 'Acme Placeholder', [q('Earliest start date'), q('Notice period')]);
  prepared(21, 'Beta Placeholder', [q('When can you start?'), q('Notice period')]);
  const r = J('ask', 'facts');
  assert.equal(r.json.calls.length, 0);
  assert.equal(r.json.count, 2);
  assert.equal(r.json.plain.ids.length, 2);
  assert.match(r.json.plain.message, /1\. .*Acme Placeholder, Beta Placeholder/);
  assert.match(r.json.plain.message, /2\. .*Acme Placeholder, Beta Placeholder/);
});

test('forms with different option lists: one list is shown, a form that does not hold it is asked on its own', () => {
  const job = (key, company, options, required = true) => ({ key, company, title: 'T', label: 'Visa?', type: 'x', options, required });
  const g = { id: 'q:visa', label: 'Visa?', factKey: null, jobs: [job('a', 'A', ['Yes', 'No']), job('b', 'B', ['Yes', 'No']), job('c', 'C', ['Yes', 'No', 'Maybe']), job('d', 'D', ['Agree', 'Disagree'])] };
  const parts = facts.splitByOptions(g);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].shown, ['Yes', 'No']);
  assert.deepEqual(parts[0].jobs.map((j) => j.key), ['a', 'b', 'c']);
  assert.deepEqual(parts[1].jobs.map((j) => j.key), ['d']);
  assert.deepEqual(parts[1].shown, ['Agree', 'Disagree']);
});

test('nothing is asked in a turn the watcher woke: the jobs hold and the push says how many questions wait', () => {
  reset();
  prepared(30, 'Acme Placeholder', [q('Current company')]);
  prepared(31, 'Beta Placeholder', [sel('Pick option number 1?', ['Alpha', 'Beta'])]);
  const woken = J('ask', 'facts', '--unattended');
  assert.equal(woken.json.asked, false);
  assert.equal(woken.json.waiting, 2);
  J('batch', 'open', '--unattended');
  assert.equal(J('ask', 'facts').json.asked, false, 'a woken batch asks nothing');
  assert.equal(J('facts', 'answer', 'fact:current_company', 'Placeholder Corp').code, 4, 'and records no answer');
  J('batch', 'close');
  const line = work.notifyLine(store.loadState(), { rules: [], lessons: [] }, Date.now()).line;
  assert.match(line, /2 questions wait for your answers/);
});

test('every part of the push line is a plain phrase, never a bare reason code', () => {
  reset();
  const reasons = ['captcha', 'login', 'email_code', 'assessment', 'account', 'upload_blocked', 'needs_facts', 'unknown_field', 'forbidden_field', 'eeo_missing', 'fill_problem', 'injection_suspected', 'writing_needs_yes', 'needs_resume_file', 'form_changed'];
  for (const r of reasons) {
    reset();
    const j = mkJob({ key: `https://boards.greenhouse.io/x/jobs/${r}`, status: 'apply_ready', company: 'Acme Placeholder', parked: { key: 'k', reasons: [r] } });
    store.updateState((s) => { s.jobs[j.key] = j; });
    const line = work.notifyLine(store.loadState(), { rules: [], lessons: [] }, Date.now()).line;
    assert.ok(line, r);
    assert.doesNotMatch(line, /[a-z]+_[a-z_]+/, `${r}: ${line}`);
  }
  reset();
  store.updateState((s) => { s.held = ['chrome_disconnected', 'no_chrome_tools', 'update_waiting', 'update_failed', 'stopped'].map((reason) => ({ reason, detail: reason === 'stopped' ? 'Acme Placeholder: writing failed' : '' })); });
  const line = work.notifyLine(store.loadState(), { rules: [], lessons: [] }, Date.now()).line;
  assert.doesNotMatch(line, /[a-z]+_[a-z_]+/, line);
  assert.doesNotMatch(line, /needs you: stopped/);
  assert.match(line, /Claude in Chrome lost its connection/);
});
