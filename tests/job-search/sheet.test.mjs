import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, mkJob, tmpHome } from './helpers/env.mjs';
import { nearMatch } from '../../skills/job-search/scripts/lib/answers.mjs';

tmpHome();
const s = await import('../../skills/job-search/scripts/lib/sheet.mjs');
const profile = { resumePath: '/r.pdf', facts: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', phone: '+4915112345678', location: 'Berlin', authorized_to_work: 'Yes' }, eeoText: 'Decline every voluntary demographic question (test placeholder).' };
// the skill's per-job match of the person's own text to this form's own options (judgment in the skill, recorded by J eeo answer)
const matched = { gender: 'Female', 'veteran status': 'I am not a protected veteran' };
const mkJobM = (over = {}) => mkJob({ eeoAnswers: matched, ...over });
const questions = () => s.parseGreenhouseQuestions(fixture('greenhouse-questions.json'));

test('a sheet comes from a Greenhouse questions=true response', () => {
  const qs = questions();
  assert.deepEqual(qs.map((q) => q.label), ['First Name', 'Last Name', 'Email', 'Resume/CV', 'Why do you want to work here?', 'Are you legally authorized to work in the US?', 'Location (City)', 'Gender', 'Veteran Status']);
  assert.equal(qs.find((q) => q.label.startsWith('Why')).maxLength, 400);
  const sheet = s.buildSheet({ job: mkJobM(), questions: qs, profile, drafts: { 'Why do you want to work here?': 'I like building tools that people use every day.' } });
  assert.deepEqual(sheet.unanswered, []);
  assert.equal(sheet.fields.find((f) => f.label === 'Email').value, 'ada@example.com');
  assert.equal(sheet.fields.find((f) => f.label === 'Gender').value, 'Female');
  assert.equal(sheet.fields.find((f) => f.label === 'Why do you want to work here?').tag, 'new_writing');
  assert.equal(s.checkSheet(sheet).ok, true);
  assert.match(sheet.hash, /^[0-9a-f]{16}$/);
});

test('an unknown required field stops the job; no fact is invented', () => {
  const sheet = s.buildSheet({ job: mkJobM(), questions: questions(), profile, drafts: {} });
  assert.deepEqual(sheet.unanswered.map((u) => u.label), ['Why do you want to work here?']);
  const c = s.checkSheet(sheet);
  assert.equal(c.ok, false);
  assert.match(c.problems[0], /Why do you want/);
});

test('a draft that fails the checks never enters the sheet', () => {
  const bad = ['see https://example.com', 'mail me at x@y.com', 'call 555 123 4567 89', 'I am [YOUR COMPANY] fan', 'x'.repeat(401)];
  for (const d of bad) {
    const sheet = s.buildSheet({ job: mkJobM(), questions: questions(), profile, drafts: { 'Why do you want to work here?': d } });
    assert.equal(sheet.unanswered.length, 1, d);
  }
  assert.deepEqual(s.checkDraft('Ada here, ada@example.com', { profile }), []);
  assert.ok(s.checkDraft('', {}).includes('empty'));
});

test('a label asking for an ID, birth date or bank stops', () => {
  for (const label of ['Date of birth', 'Social Security Number', 'Passport number', 'Bank account number', 'Government ID', 'Password']) {
    const sheet = s.buildSheet({ job: mkJobM(), questions: [{ label, required: false, type: 'input_text' }], profile });
    assert.deepEqual(sheet.forbidden, [label]);
    assert.equal(s.checkSheet(sheet).ok, false);
  }
});

test('EEO is the person\'s own text: a form with the fields needs it, the match to the form\'s options is recorded per job, and nothing is guessed', () => {
  const drafts = { 'Why do you want to work here?': 'Fine.' };
  const none = s.buildSheet({ job: mkJob(), questions: questions(), profile: { ...profile, eeoText: undefined }, drafts });
  assert.equal(none.eeoMissing, true);
  assert.equal(none.eeoFields[0].noText, true, 'no saved text yet: the one plain question comes first');
  assert.match(s.checkSheet(none).problems.join(' '), /voluntary demographic/);
  const saved = { ...profile, eeoText: 'Gender: Female (test placeholder)' };
  const unmatched = s.buildSheet({ job: mkJob(), questions: questions(), profile: saved, drafts });
  assert.equal(unmatched.eeoMissing, true, 'text saved, but this form\'s field is not matched to its options yet: never guessed');
  assert.equal(unmatched.fields.some((f) => f.label === 'Gender'), false);
  assert.equal(unmatched.eeoFields[0].noText, false);
  const matched = s.buildSheet({ job: mkJob({ eeoAnswers: { gender: 'Female' } }), questions: questions(), profile: saved, drafts });
  assert.equal(matched.fields.find((f) => f.label === 'Gender').value, 'Female');
  assert.equal(matched.fields.find((f) => f.label === 'Gender').tag, 'fact');
});

test('a changed live form stops: a new required field, a new field, a forbidden one', () => {
  const sheet = s.buildSheet({ job: mkJobM(), questions: questions(), profile, drafts: { 'Why do you want to work here?': 'Fine.' } });
  const live = questions().map((q) => ({ label: q.label, required: q.required }));
  assert.equal(s.checkSheet(sheet, live).ok, true);
  assert.match(s.checkSheet(sheet, [...live, { label: 'Expected salary in euros', required: true }]).problems[0], /required field the sheet lacks/);
  assert.match(s.checkSheet(sheet, [...live, { label: 'Favourite colour', required: false }]).problems[0], /field the sheet lacks/);
  assert.match(s.checkSheet(sheet, [...live, { label: 'Date of birth', required: false }]).problems[0], /asks for Date of birth/);
});

test('a read-back that does not match the sheet stops before submit', () => {
  const sheet = s.buildSheet({ job: mkJobM(), questions: questions(), profile, drafts: { 'Why do you want to work here?': 'Fine.' } });
  const read = sheet.fields.map((f) => ({ label: f.label, value: f.value }));
  assert.equal(s.checkReadBack(sheet, read).ok, true);
  const changed = read.map((r) => (r.label === 'Email' ? { ...r, value: 'other@example.com' } : r));
  assert.deepEqual(s.checkReadBack(sheet, changed).problems, ['read-back differs: Email']);
  assert.equal(s.checkReadBack(sheet, read.filter((r) => r.label !== 'Last Name')).ok, false);
});

test('a saved answer is reused for the same question; a near match goes to the person', () => {
  const entries = [{ q: 'will you now or in the future require sponsorship', answer: 'No', how: 'typed', type: 'input_text', options: null }];
  const qs = [{ label: 'Will you now or in the future require sponsorship?', required: true, type: 'input_text' }];
  const sheet = s.buildSheet({ job: mkJobM(), questions: qs, profile: { ...profile, facts: {} }, answers: entries });
  assert.equal(sheet.fields[0].tag, 'answer');
  assert.deepEqual(nearMatch('Do you now or in the future require visa sponsorship', entries).exact, false);
  assert.equal(nearMatch('Will you now or in the future require sponsorship', entries).exact, true);
  assert.equal(nearMatch('Favourite colour', entries), null);
});

test('the sheet hash changes when a value changes', () => {
  const a = s.buildSheet({ job: mkJob({ key: 'k' }), questions: questions(), profile, drafts: { 'Why do you want to work here?': 'One.' } });
  const b = s.buildSheet({ job: mkJob({ key: 'k' }), questions: questions(), profile, drafts: { 'Why do you want to work here?': 'Two.' } });
  assert.notEqual(a.hash, b.hash);
});
