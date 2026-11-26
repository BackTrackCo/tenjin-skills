import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIX, mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const facts = await import(`${S}facts.mjs`);
const sheet = await import(`${S}sheet.mjs`);
const parts = await import(`${S}parts.mjs`);
const J = (...a) => runJobs(home, a);
const LIVE = JSON.parse(fs.readFileSync(path.join(FIX, 'live-date-parts.json'), 'utf8'));
const file = (v) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-')), 'x.json'); fs.writeFileSync(f, JSON.stringify(v)); return f; };
const DATE = LIVE[1];
const reset = () => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'answers.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState()); });
  J('profile', 'set', JSON.stringify({ facts: { email: 'ada@example.test' } }));
};
const job = (n, extra = {}) => mkJob({ key: `https://boards.greenhouse.io/acme/jobs/${n}`, status: 'prepared', company: `Acme Placeholder ${n}`, ...extra });

test('a live read with a month and a year dropdown builds one date field with its parts; a summary of a list is refused, never rewritten', () => {
  reset();
  const j = job(1);
  store.updateState((s) => { s.jobs[j.key] = j; });
  const ok = J('sheet', 'build', j.key, '--questions', file(LIVE));
  assert.equal(ok.code, 0, ok.stdout);
  const bad = [LIVE[0], { ...DATE, type: 'multi_value_single_select', parts: undefined, options: ['Month: January..December', 'Year: 2027..1908'] }];
  const b = J('sheet', 'build', j.key, '--questions', file(bad));
  assert.equal(b.code, 2);
  assert.match(b.json.error, /field "When can you start a new role\?" has an option that summarizes a list \("Month: January\.\.December"\)/);
  assert.match(b.json.error, /"parts"/);
  const c = J('sheet', 'check', j.key, '--live', file(bad));
  assert.equal(c.code, 2);
  assert.match(c.json.error, /summarizes a list/);
  assert.equal(store.loadState().jobs[j.key].sheet.unanswered.length, 1, 'the sheet is untouched by a refused read');
  const inPart = [{ ...DATE, parts: [{ name: 'Month', options: ['January..December'] }, { name: 'Year', options: ['2027'] }] }];
  assert.match(J('sheet', 'check', j.key, '--live', file(inPart)).json.error, /part "Month".*summarizes a list/);
  assert.match(J('sheet', 'check', j.key, '--live', file([{ ...DATE, parts: [{ options: [] }] }])).json.error, /parts that are not/);
  assert.deepEqual(parts.partsProblems(LIVE), [], 'real labels pass');
});

test('a date, or a field with parts, is one plain line that asks for the parts by name, never a choice', () => {
  reset();
  const j = job(2);
  store.updateState((s) => { s.jobs[j.key] = j; });
  J('sheet', 'build', j.key, '--questions', file(LIVE));
  const built = facts.buildFactQuestions(facts.collectFacts(store.loadState()));
  assert.deepEqual(built.calls, [], 'no choice question');
  assert.equal(built.plain.ids.length, 1);
  assert.match(built.plain.message, /When can you start a new role\? \(For: Acme Placeholder 2\) Give a month and a year\./);
  assert.doesNotMatch(built.plain.message, /Options|\.\./);
  // a date with no parts is plain too; a real choice for a start date (Immediately, In 2 weeks) stays a choice
  const dateOnly = facts.buildFactQuestions([{ id: 'q:x', label: 'Available from', factKey: null, jobs: [{ key: 'k', company: 'C', title: 't', label: 'Available from', type: 'date', options: ['A', 'B'], required: true }], shown: ['A', 'B'] }]);
  assert.deepEqual(dateOnly.calls, []);
  assert.match(dateOnly.plain.message, /Give a date\./);
  const choice = facts.buildFactQuestions([{ id: 'fact:start_date', label: 'When can you start?', factKey: 'start_date', jobs: [{ key: 'k', company: 'C', title: 't', label: 'When can you start?', type: 'multi_value_single_select', options: ['Immediately', 'In 2 weeks'], required: true }] }]);
  assert.equal(choice.calls.length, 1);
  assert.equal(choice.plain, null);
});

test('the typed answer is matched to each part: a month by name or number, a 4-digit year, a day number; an unmatched part is never guessed', () => {
  const m = (p, t) => parts.matchParts(p, t);
  const MY = DATE.parts;
  assert.deepEqual(m(MY, 'March 2027'), [{ name: 'Month', value: 'March' }, { name: 'Year', value: '2027' }]);
  assert.deepEqual(m(MY, 'mar 2026'), [{ name: 'Month', value: 'March' }, { name: 'Year', value: '2026' }]);
  assert.deepEqual(m(MY, '3/2027').map((x) => x.value), ['March', '2027']);
  assert.deepEqual(m(MY, '2027-03').map((x) => x.value), ['March', '2027']);
  assert.equal(m(MY, 'March 1999'), null, 'a year the form does not offer');
  assert.equal(m(MY, 'March'), null, 'no year');
  assert.equal(m(MY, 'soon'), null);
  const DMY = [{ name: 'Day', options: ['1', '2', '15', '31'] }, { name: 'Month', options: ['01', '02', '03'] }, { name: 'Year', options: ['2027'] }];
  assert.deepEqual(m(DMY, '15 March 2027').map((x) => x.value), ['15', '03', '2027'], 'the form spells the month as a number');
  assert.deepEqual(m(DMY, '15/3/2027').map((x) => x.value), ['15', '03', '2027']);
  assert.equal(m(DMY, '16 March 2027'), null, 'a day the form does not offer');
  assert.equal(parts.partsPhrase(DMY), 'a day, a month and a year');
  assert.equal(parts.partsPhrase([{ name: 'Year' }]), 'a year');
});

test('J facts answer records each part as the form spells it, the sheet field carries the parts, and an unmatched answer goes to needsMapping', () => {
  reset();
  const j = job(3);
  store.updateState((s) => { s.jobs[j.key] = j; });
  J('sheet', 'build', j.key, '--questions', file(LIVE));
  J('ask', 'facts');
  const id = Object.keys(store.loadState().factPlan)[0];
  assert.equal(id, 'fact:start_date');
  const bad = J('facts', 'answer', id, 'sometime next year');
  assert.deepEqual(bad.json.needsMapping, [j.key]);
  assert.equal(loadAnswers().length, 0, 'nothing is guessed');
  J('ask', 'facts');
  const ok = J('facts', 'answer', id, 'March 2027');
  assert.deepEqual(ok.json.needsMapping, []);
  const entry = loadAnswers()[0];
  assert.deepEqual(entry.parts, [{ name: 'Month', value: 'March' }, { name: 'Year', value: '2027' }]);
  const f = store.loadState().jobs[j.key].sheet.fields.find((x) => x.label === 'When can you start a new role?');
  assert.deepEqual(f.parts, entry.parts);
  assert.equal(f.value, 'March 2027');
  assert.equal(store.loadState().jobs[j.key].sheet.unanswered.length, 0);
});

function loadAnswers() {
  const f = path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'answers.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).entries; } catch { return []; }
}

test('the read-back compares each part: a part that differs names the control, and a whole-field read still compares', () => {
  const pv = [{ name: 'Month', value: 'March' }, { name: 'Year', value: '2027' }];
  const sh = { fields: [{ label: 'When can you start a new role?', value: 'March 2027', tag: 'fact', parts: pv }], unanswered: [] };
  const label = 'When can you start a new role?';
  assert.equal(sheet.checkReadBack(sh, [{ label, parts: [{ name: 'Month', value: 'March' }, { name: 'Year', value: '2027' }] }]).ok, true);
  const wrong = sheet.checkReadBack(sh, [{ label, parts: [{ name: 'Month', value: 'March' }, { name: 'Year', value: '2026' }] }]);
  assert.equal(wrong.ok, false);
  assert.deepEqual(wrong.problems, [`read-back differs: ${label} (Year)`]);
  assert.equal(sheet.checkReadBack(sh, [{ label, parts: [{ name: 'Month', value: 'March' }] }]).ok, false, 'a missing part');
  assert.equal(sheet.checkReadBack(sh, [{ label, value: 'March 2027' }]).ok, true);
  assert.equal(sheet.checkReadBack(sh, [{ label, value: 'March 2026' }]).ok, false);
});

test('a required date field read live with parts is asked as a date, carrying its parts to the question', () => {
  reset();
  const j = job(4);
  store.updateState((s) => { s.jobs[j.key] = j; });
  J('sheet', 'build', j.key, '--questions', file([LIVE[0]]));
  const r = J('sheet', 'check', j.key, '--live', file(LIVE));
  assert.equal(r.code, 4, r.stdout);
  const u = store.loadState().jobs[j.key].sheet.unanswered.find((x) => /start a new role/.test(x.label));
  assert.equal(u.type, 'date');
  assert.deepEqual(u.parts.map((p) => p.name), ['Month', 'Year']);
  const built = facts.buildFactQuestions(facts.collectFacts(store.loadState()));
  assert.deepEqual(built.calls, []);
  assert.match(built.plain.message, /Give a month and a year\./);
});
