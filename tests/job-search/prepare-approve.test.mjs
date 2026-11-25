import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL, mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const prep = await import(`${S}prepare.mjs`);
const work = await import(`${S}work.mjs`);
const report = await import(`${S}report.mjs`);
const qs = await import(`${S}questions.mjs`);

const empty = { rules: [], lessons: [] };
const dir = () => path.join(process.env.TENJIN_SKILLS_DIR, 'job-search');
const J = (...a) => runJobs(home, a);
const reset = (jobs = [], profile = { facts: { first_name: 'Ada', email: 'ada@example.test' }, eeoText: 'Decline every voluntary demographic question (test placeholder).', resumeText: 'Ada builds compilers.' }) => {
  fs.rmSync(path.join(dir(), 'rules.json'), { force: true });
  fs.rmSync(path.join(dir(), 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; });
  J('profile', 'set', JSON.stringify({ ...profile, updates: false }));
  return profile;
};
const plain = [{ label: 'First name', required: true, type: 'input_text' }, { label: 'Email', required: true, type: 'input_text' }, { label: 'Resume', required: true, type: 'input_file' }];
const citizen = { label: 'Are you a US citizen?', required: true, type: 'multi_value_single_select', options: ['Yes', 'No'] };
const planned = (n, over = {}) => mkJob({ key: `https://boards.greenhouse.io/acme/jobs/${n}`, status: 'reviewed', fit: 90 - n, company: `Co${n}`, title: `Engineer ${n}`, questions: plain, v: 1, ...over });

test('a job the skill plans to apply to is prepared with no question and no shortlist step; one outside the period\'s set is left alone', async () => {
  const a = planned(1);
  const b = planned(2);
  const profile = reset([a, b]);
  J('rules', 'add', '--effect', 'period_max', '--value', '1', '--words', 'one a period');
  assert.deepEqual(work.plannedJobs(store.loadState(), profile, (await import(`${S}overlay.mjs`)).loadOverlay()).map((j) => j.key), [a.key]);
  const r = await prep.prepareInCode({ fetch: null, profile });
  assert.deepEqual(r.ready, [a.key], 'no offer to prepare, no shortlist: reviewed went straight to a checked sheet');
  const s = store.loadState();
  assert.equal(s.jobs[a.key].status, 'apply_ready');
  assert.equal(s.jobs[b.key].status, 'reviewed', 'outside this period\'s most');
  assert.ok(!work.buildWorkList(s, empty, Date.now(), profile).items.some((i) => i.reason === 'prepare_due'), 'no prepare item for the model');
  // a posting that is not exact or confirmed is not planned
  reset([planned(3, { employerPosting: { ...planned(3).employerPosting, confidence: 'unconfirmed' } })]);
  assert.deepEqual((await prep.prepareInCode({ fetch: null, profile })).ready, []);
});

test('attended: a missing fact is asked inside the approval, with its fixed answers and "Skip this job"; the yes covers the completed sheet', async () => {
  const j = planned(4, { questions: [...plain, citizen, { label: 'Do you hold a security clearance?', required: true, type: 'input_text' }] });
  const profile = reset([j]);
  await prep.prepareInCode({ fetch: null, profile });
  const held = store.loadState().jobs[j.key];
  assert.equal(held.status, 'prepared');
  assert.equal(held.awaitingApproval, true);
  assert.equal(held.parked, null, 'not parked: nothing is asked before the approval');
  assert.deepEqual(held.missingFacts.sort(), ['security_clearance', 'us_citizen']);
  const ask = J('ask', 'approval', '--key', j.key).json;
  assert.equal(ask.step, 'facts first', 'a fact never shares a call with the approval');
  assert.equal(ask.questions[0].header, 'Missing fact');
  assert.deepEqual(ask.questions[0].options.map((o) => o.label), ['Yes', 'No', 'Skip this job'], 'the form\'s own options, word for word');
  assert.deepEqual(ask.plain.map((p) => p.fact), ['security_clearance'], 'a fact with no fixed answers is a plain question');
  assert.deepEqual(qs.validateAsk({ questions: ask.questions }), []);
  assert.ok(ask.application.some((l) => /^Email: ada@example\.test \(fact\)/.test(l)), 'the prepared application is shown');
  // no yes without the completed sheet
  assert.equal(J('approve', j.key).code, 4);
  const before = store.loadState().jobs[j.key].sheet.hash;
  assert.equal(J('approve', j.key, '--facts', '{"us_citizen":"Yes"}').code, 4, 'still one fact short');
  const done = J('approve', j.key, '--facts', '{"security_clearance":"None"}');
  assert.equal(done.code, 0, done.stdout);
  assert.equal(store.loadState().approvals[j.key], undefined, 'saving facts approves nothing');
  const ask2 = J('ask', 'approval', '--key', j.key).json;
  assert.equal(ask2.questions[0].header, 'Apply', 'the approval comes after, with the completed sheet');
  assert.deepEqual(ask2.questions[0].options.map((o) => o.label), ['Yes, apply (Recommended)', 'Fill it, I submit', 'Not this one']);
  const ok = J('approve', j.key);
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.json.state, /^Submitted: none\. Applying next: /);
  const s = store.loadState();
  assert.equal(s.jobs[j.key].status, 'apply_ready');
  assert.notEqual(s.jobs[j.key].sheet.hash, before);
  assert.equal(s.approvals[j.key].sheetHash, s.jobs[j.key].sheet.hash, 'the yes covers the completed sheet');
  assert.equal(J('profile', 'get').json.facts.us_citizen, 'Yes');
});

test('in an auto mode nobody is asked: a missing fact holds the job as needs_facts', async () => {
  const j = planned(5, { questions: [...plain, citizen] });
  const profile = reset([j], { facts: { first_name: 'Ada', email: 'ada@example.test' }, eeoText: 'Decline every voluntary demographic question (test placeholder).', applyMode: 'auto_no_new' });
  await prep.prepareInCode({ fetch: null, profile });
  const held = store.loadState().jobs[j.key];
  assert.deepEqual(held.parked.reasons, ['needs_facts']);
  assert.notEqual(held.awaitingApproval, true);
});

test('the mode description says it prepares, shows and waits for the yes; the fill and the submit are one pass after it; nothing offers to prepare', () => {
  assert.equal(qs.startQuestions().questions[0].options[0].description, 'I prepare each application, show it, and submit only after your yes.');
  const apply = fs.readFileSync(path.join(SKILL, 'references', 'apply.md'), 'utf8');
  assert.match(apply, /one browser pass after the yes/);
  assert.match(apply, /read-back against the sheet hash/);
  const text = [path.join(SKILL, 'SKILL.md'), ...fs.readdirSync(path.join(SKILL, 'references')).map((f) => path.join(SKILL, 'references', f))].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.doesNotMatch(text, /shortlisted it from the report|said yes to a list|Want me to prepare|offer to prepare/i);
});

const mine = (n, fit, company) => mkJob({ key: `https://www.example-jobs.test/view/${n}`, status: 'reviewed', employerPosting: null, openConfirmed: false, unresolved: 'no_board', company, fit, title: `Role ${n}`, v: 1 });

test('the default report is short: a count line, the planned jobs, what needs the person now, and the --all line; --all is the full report', () => {
  const ready = planned(6, { status: 'apply_ready', sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [{ label: 'Why us?', value: 'Because compilers.', tag: 'new_writing', required: true }] } });
  const profile = reset([ready, mine(1, 70, 'MixRank'), mine(2, 68, 'Ledgebrook'), mine(3, 66, 'Rippling'), mine(4, 40, 'Lowfit')]);
  store.updateState((s) => { s.held = [{ reason: 'source_empty', detail: 'Figma: rate limited (429)' }]; s.watched = { ok: 1, checked: 2 }; });
  const out = J('report').stdout;
  assert.match(out, /^# Job Search report/);
  assert.match(out, /\n4 new jobs; 1 planned to apply to; 4 for you to apply to yourself \(best you can apply to yourself: MixRank, Ledgebrook, Rippling\)\./);
  assert.doesNotMatch(out, /Lowfit/, 'at most three, by fit, by company only');
  assert.match(out, /## Planned to apply to \(1\)\n- 84 \| Engineer 6, Co6, Berlin \| waiting for your yes/);
  assert.match(out, /## Need your yes \(1\)\n- Co6, Engineer 6\n {2}- new answer, "Why us\?": Because compilers\./);
  assert.match(out, /`J report --all`, or ask for the full report/);
  for (const gone of ['Sources held', 'Watched boards', 'Cost the router', 'Apply yourself (', 'Left alone', 'Found on the employer', 'Model wakes']) assert.doesNotMatch(out, new RegExp(gone.replace(/[()]/g, '\\$&')), `${gone} is behind --all`);
  assert.ok(out.split('\n').length < 25);
  const all = J('report', '--all').stdout;
  for (const here of ['## Sources held this run', '## Watched boards checked', 'Cost the router reported', '## Apply yourself (4)']) assert.ok(all.includes(here), `--all has ${here}`);
  assert.match(all, /Figma: rate limited/);
  assert.ok(fs.readFileSync(path.join(dir(), 'reports', `${new Date().toISOString().slice(0, 10)}.md`), 'utf8').includes('## Sources held this run'), 'the full report is always saved');
  assert.equal(profile.facts.first_name, 'Ada');
});

test('the contacts offer is a question with 5 first, and only when there are planned jobs', () => {
  reset([mine(1, 70, 'MixRank')]);
  assert.doesNotMatch(J('report').stdout, /Contacts: I can find someone/, 'no planned jobs, no offer');
  assert.doesNotMatch(J('report', '--all').stdout, /Contacts: I can find someone/);
  reset([planned(7)]);
  assert.match(J('report').stdout, /Contacts: I can find someone to write to/);
  assert.match(J('report', '--all').stdout, /Contacts: I can find someone to write to/);
  assert.equal(J('ask', 'contacts').json.questions[0].options[0].label, '5 jobs (Recommended)');
  const skill = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(skill, /J report --all/);
  assert.match(skill, /ends with a Contacts line/);
});
