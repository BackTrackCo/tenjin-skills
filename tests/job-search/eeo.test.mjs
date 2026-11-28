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
  assert.match(r.json.error, /eeo is an old field/);
  assert.equal(J('profile', 'set', JSON.stringify({ eeo: { answers: { gender: 'x' } } })).code, 2);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(ROOT).filter((x) => /\.(md|mjs)$/.test(x))) {
    const t = fs.readFileSync(f, 'utf8');
    // the one place that names the old value is the converter that reads it
    if (f.endsWith(path.join('lib', 'profile.mjs'))) continue;
    assert.doesNotMatch(t, /decline_all/, f);
  }
});

test('an old saved EEO shape is never converted: any command but J profile is refused with the field named, and J profile removes it', () => {
  reset({ eeo: 'decline_all' });
  const r = J('work');
  assert.equal(r.code, 2);
  assert.match(r.json.error, /old field/);
  assert.match(r.json.error, /eeo \(/, 'the field is named');
  assert.equal(J('arm').code, 2);
  const old = J('profile', 'get').json;
  assert.equal(old.eeo, 'decline_all', 'nothing was converted');
  assert.equal(old.eeoText, undefined);
  assert.equal(J('profile', 'set', JSON.stringify({ frequency: 'weekly' })).code, 2, 'the old field is still refused');
  assert.equal(J('profile', 'set', JSON.stringify({ eeo: null })).code, 0);
  const after = J('profile', 'get').json;
  assert.equal(after.eeo, undefined);
  assert.equal(after.eeoText, undefined, 'removed, not converted');
  assert.equal(J('work').code, 0);
  reset({ eeo: { answers: { gender: 'placeholder' } } });
  assert.match(J('work').json.error, /eeo \(/);
  assert.equal(eeoTextOf({ eeo: 'decline_all' }), null, 'the reader reads only eeoText');
  assert.equal(eeoTextOf({ eeoText: ' my words ' }), 'my words');
});

const OPT = (f) => ({ ...f, required: false });

test('an optional field the saved text does not answer is asked in the same plain question, marked optional, with the skip said', () => {
  reset({ eeoText: 'Veteran status: placeholder. (test text)' });
  const j = job(5);
  J('sheet', 'build', j.key, '--questions', file([Q('First name'), OPT(GENDER), VET]));
  const fields = store.loadState().jobs[j.key].sheet.eeoFields;
  assert.deepEqual(fields.map((f) => [f.label, f.required]), [['Gender', false], ['Veteran status', true]]);
  const r = J('eeo', 'question', '--key', j.key).json;
  assert.equal(r.questions, undefined, 'still a plain question');
  assert.match(r.plain, /Gender \(optional\); Veteran status\./);
  assert.doesNotMatch(r.plain, /Veteran status \(optional\)/, 'a required field is not marked optional');
  assert.match(r.plain, /can also be skipped: say skip/);
  const allRequired = J('eeo', 'question', '--key', job(6).key).json;
  assert.doesNotMatch(allRequired.plain, /skip/, 'no skip is offered when no field is optional');
});

test('a skip leaves the optional field empty, is saved with the person\'s text, and a later form does not ask about it again', () => {
  reset({ eeoText: 'Veteran status: placeholder. (test text)' });
  const j = job(7);
  const qf = file([Q('First name'), OPT(GENDER), VET]);
  J('sheet', 'build', j.key, '--questions', qf);
  const sk = J('eeo', 'skip', j.key, 'Gender');
  assert.equal(sk.code, 0, sk.stdout);
  assert.deepEqual(J('profile', 'get').json.eeoSkipped, ['gender']);
  assert.equal(J('profile', 'get').json.eeoText, 'Veteran status: placeholder. (test text)', 'the text is kept as it was');
  J('eeo', 'answer', j.key, 'Veteran status', 'I am not a veteran');
  J('sheet', 'build', j.key, '--questions', qf);
  const sheet = store.loadState().jobs[j.key].sheet;
  assert.equal(sheet.fields.some((f) => f.label === 'Gender'), false, 'left empty');
  assert.equal(sheet.eeoMissing, false, 'the skipped optional field no longer holds the job');
  // a later form with the same optional field: not asked again
  const k = job(8);
  J('sheet', 'build', k.key, '--questions', qf);
  assert.deepEqual(store.loadState().jobs[k.key].sheet.eeoFields.map((f) => f.label), ['Veteran status']);
  // a skip needs no saved text at all
  reset();
  const m = job(9);
  J('sheet', 'build', m.key, '--questions', file([OPT(GENDER)]));
  assert.equal(J('eeo', 'skip', m.key, 'Gender').code, 0);
  J('sheet', 'build', m.key, '--questions', file([OPT(GENDER)]));
  assert.equal(store.loadState().jobs[m.key].sheet.eeoMissing, false);
});

test('a required field cannot be skipped, and nothing is guessed for it', () => {
  reset({ eeoText: 'Gender: placeholder. (test text)' });
  const j = job(10);
  const qf = file([Q('First name'), GENDER, VET]);
  J('sheet', 'build', j.key, '--questions', qf);
  const r = J('eeo', 'skip', j.key, 'Veteran status');
  assert.equal(r.code, 4);
  assert.match(r.json.error, /required on this form: it cannot be skipped/);
  assert.equal(J('profile', 'get').json.eeoSkipped, undefined);
  // even a saved skip for the same label does not skip a required field on another form
  J('profile', 'set', JSON.stringify({ eeoSkipped: ['veteran status'] }));
  const k = job(11);
  J('sheet', 'build', k.key, '--questions', qf);
  const sheet = store.loadState().jobs[k.key].sheet;
  assert.equal(sheet.eeoMissing, true);
  assert.ok(sheet.eeoFields.some((f) => f.label === 'Veteran status' && f.required === true));
  assert.equal(J('eeo', 'skip', k.key, 'Nonexistent field').code, 2);
});

test('the unattended consent needs no EEO text; a woken turn holds the first unanswered EEO form as eeo_missing with one push, and the next attended turn asks the plain question', async () => {
  const work = await import(`${S}work.mjs`);
  reset({ unattended: { roles: ['engineer'], places: ['Berlin'], minScore: 70, hosts: ['*'] } });
  assert.equal(J('consent', 'record', 'unattended', '--optional-writing', 'skip').code, 0, 'no EEO text is needed');
  const j = job(12);
  const qf = file([Q('First name'), GENDER]);
  J('sheet', 'build', j.key, '--questions', qf);
  const woken = J('sheet', 'check', j.key, '--live', qf, '--unattended');
  assert.equal(woken.code, 4);
  assert.deepEqual(store.loadState().jobs[j.key].parked.reasons, ['eeo_missing']);
  assert.equal(woken.json.ask, undefined, 'nobody is asked in a woken turn');
  const first = work.workList({ now: Date.now(), commit: true });
  assert.match(first.notify, /1 stop needs you at Acme \(a demographic question\)/, 'the usual push');
  assert.equal(work.workList({ now: Date.now(), commit: true }).notify, null, 'one push, not a second');
  // the next attended turn asks the plain question
  const q = J('eeo', 'question', '--key', j.key).json;
  assert.match(q.plain, /Gender/);
  assert.equal(q.questions, undefined);
});

test('the defaults merge in loadState stays: a state that lacks a newer key is filled, and nothing is renamed or moved', () => {
  reset();
  const f = store.stateFile();
  const old = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete old.shown;
  delete old.chrome;
  old.jobs = { 'https://x.test/1': { key: 'https://x.test/1', title: 'Kept' } };
  fs.writeFileSync(f, JSON.stringify(old));
  const s = store.loadState();
  assert.deepEqual(s.shown, {}, 'a missing key gets its default');
  assert.equal(s.chrome, null);
  assert.equal(s.jobs['https://x.test/1'].title, 'Kept', 'what is stored is untouched');
});
