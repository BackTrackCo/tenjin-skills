import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const qs = await import(`${S}questions.mjs`);
const { eeoTextOf } = await import(`${S}profile.mjs`);
const J = (...a) => runJobs(home, a);
const ROOT = path.join(import.meta.dirname, '..', '..', 'skills', 'job-search');
const pf = () => path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json');
const reset = (profile = {}) => {
  store.updateState((s) => { Object.assign(s, store.emptyState()); });
  fs.mkdirSync(path.dirname(pf()), { recursive: true });
  fs.writeFileSync(pf(), JSON.stringify({ facts: { first_name: 'Ada', email: 'ada@example.test' }, ...profile }));
};
const file = (v) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eeo-')), 'q.json'); fs.writeFileSync(f, JSON.stringify(v)); return f; };
const Q = (label, extra = {}) => ({ label, required: true, type: 'input_text', options: [], maxLength: null, ...extra });
const GENDER = Q('Gender', { type: 'multi_value_single_select', options: ['Female', 'Male', 'Decline to self-identify'] });
const VET = Q('Veteran status', { type: 'multi_value_single_select', options: ['I am a veteran', 'I am not a veteran', 'Decline to self-identify'] });
const job = (n = 1) => {
  const j = mkJob({ key: `https://boards.greenhouse.io/acme/jobs/${n}`, status: 'prepared', company: 'Acme' });
  store.updateState((s) => { s.jobs[j.key] = j; });
  return j;
};

test('EEO is never a choice question: J ask eeo is refused with a pointer, and no builder for it exists', () => {
  const r = J('ask', 'eeo');
  assert.equal(r.code, 2);
  assert.match(r.json.error, /never a choice question/);
  assert.match(r.json.error, /J eeo question/);
  assert.equal(qs.eeoFieldQuestion, undefined);
  const code = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'questions.mjs'), 'utf8');
  assert.doesNotMatch(code, /eeoFieldQuestion|q\('EEO'/);
  assert.equal(J('ask', 'eeo', '--json', '{"label":"Gender","options":["a","b"]}').code, 2);
});

test('the first form with the fields gets one plain question that names this form\'s fields, with no options', () => {
  reset();
  const j = job(1);
  const qf = file([Q('First name'), GENDER, VET]);
  J('sheet', 'build', j.key, '--questions', qf);
  const built = store.loadState().jobs[j.key].sheet;
  assert.equal(built.eeoMissing, true);
  const r = J('eeo', 'question', '--key', j.key);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.questions, undefined, 'no question-tool payload');
  assert.match(r.json.plain, /^The Acme form asks these voluntary demographic questions: Gender; Veteran status\./);
  assert.match(r.json.plain, /in your own words, or say decline/);
  assert.doesNotMatch(r.json.plain, /Female|Male|\(Recommended\)/, 'the form\'s options are not offered as choices');
  assert.equal(r.json.saved, false);
});

test('the answer is saved as the person\'s own text, in code, and more words are added to it', () => {
  reset();
  const j = job(2);
  const set = J('eeo', 'set', 'Gender: placeholder text one. Veteran status: decline.');
  assert.equal(set.code, 0, set.stdout);
  assert.equal(J('profile', 'get').json.eeoText, 'Gender: placeholder text one. Veteran status: decline.');
  assert.equal(J('eeo', 'add', 'Disability: decline.').code, 0);
  assert.equal(J('profile', 'get').json.eeoText, 'Gender: placeholder text one. Veteran status: decline.\nDisability: decline.');
  assert.equal(J('eeo', 'set').code, 2, 'empty text is refused');
  assert.ok(j.key);
});

test('a field the saved text does not answer is never guessed: it is asked again, plainly, for only that field, and the answer joins the text', () => {
  reset({ eeoText: 'Gender: placeholder. (test text)' });
  const j = job(3);
  const qf = file([Q('First name'), GENDER, VET]);
  J('sheet', 'build', j.key, '--questions', qf);
  assert.equal(store.loadState().jobs[j.key].sheet.eeoFields.length, 2, 'nothing is matched yet: no field is filled');
  // the skill matches the saved text to the form's own options, one field it can
  assert.equal(J('eeo', 'answer', j.key, 'Gender', 'Not an option').code, 2, 'the value must be one of the form\'s options');
  assert.equal(J('eeo', 'answer', j.key, 'Gender', 'Female').code, 0);
  J('sheet', 'build', j.key, '--questions', qf);
  const sheet = store.loadState().jobs[j.key].sheet;
  assert.equal(sheet.fields.find((f) => f.label === 'Gender').value, 'Female');
  assert.equal(sheet.fields.some((f) => f.label === 'Veteran status'), false, 'the unanswered field is not guessed');
  assert.deepEqual(sheet.eeoFields.map((f) => f.label), ['Veteran status']);
  assert.equal(sheet.eeoMissing, true);
  const again = J('eeo', 'question', '--key', j.key).json;
  assert.match(again.plain, /Veteran status/);
  assert.doesNotMatch(again.plain, /Gender/, 'asked again only for the field the text does not answer');
  assert.equal(again.saved, true);
  J('eeo', 'add', 'Veteran status: placeholder.');
  assert.match(J('profile', 'get').json.eeoText, /Veteran status: placeholder\./);
  J('eeo', 'answer', j.key, 'Veteran status', 'I am not a veteran');
  J('sheet', 'build', j.key, '--questions', qf);
  assert.equal(store.loadState().jobs[j.key].sheet.eeoMissing, false);
});

test('a required EEO field on the live form is asked in the session before the fill, and nobody is asked in a woken turn', () => {
  reset();
  const j = job(4);
  const base = [Q('First name')];
  J('sheet', 'build', j.key, '--questions', file(base));
  const live = [Q('First name'), GENDER];
  const r = J('sheet', 'check', j.key, '--live', file(live));
  assert.equal(r.code, 4, r.stdout);
  assert.deepEqual(store.loadState().jobs[j.key].parked.reasons, ['eeo_missing'], 'held with no fill');
  assert.equal(store.loadState().jobs[j.key].sheet.eeoFields[0].label, 'Gender');
  const q = J('eeo', 'question', '--key', j.key).json;
  assert.match(q.plain, /Gender/);
  assert.equal(q.questions, undefined);
  const woken = J('sheet', 'check', j.key, '--live', file(live), '--unattended');
  assert.equal(woken.json.ask, undefined, 'no question in a woken turn');
});

test('decline_all is gone: J profile set refuses the old field, and the code and docs no longer name it', () => {
  reset();
  const r = J('profile', 'set', JSON.stringify({ eeo: 'decline_all' }));
  assert.equal(r.code, 2);
  assert.match(r.json.error, /eeo is no longer a profile field/);
  assert.equal(J('profile', 'set', JSON.stringify({ eeo: { answers: { gender: 'x' } } })).code, 2);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(ROOT).filter((x) => /\.(md|mjs)$/.test(x))) {
    const t = fs.readFileSync(f, 'utf8');
    // the one place that names the old value is the converter that reads it
    if (f.endsWith(path.join('lib', 'profile.mjs'))) continue;
    assert.doesNotMatch(t, /decline_all/, f);
  }
});

test('the old saved shapes become the person\'s text once, on read', () => {
  reset({ eeo: 'decline_all' });
  const a = J('profile', 'get').json;
  assert.equal(a.eeo, undefined);
  assert.equal(a.eeoText, 'Decline to answer every voluntary demographic question.');
  reset({ eeo: { answers: { gender: 'placeholder one', 'veteran status': 'placeholder two' } } });
  const b = J('profile', 'get').json;
  assert.equal(b.eeo, undefined);
  assert.equal(b.eeoText, 'gender: placeholder one\nveteran status: placeholder two');
  assert.equal(eeoTextOf({ eeo: { answers: {} } }), null);
  // another command still works on the old profile, and the next write stores the text
  assert.equal(J('profile', 'set', JSON.stringify({ frequency: 'weekly' })).code, 0);
  const stored = JSON.parse(fs.readFileSync(pf(), 'utf8'));
  assert.equal(stored.eeo, undefined);
  assert.match(stored.eeoText, /placeholder two/);
});
