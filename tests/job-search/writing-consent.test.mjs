import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const ap = await import('../../skills/job-search/scripts/lib/apply.mjs');
const ans = await import('../../skills/job-search/scripts/lib/answers.mjs');
const sheet = await import('../../skills/job-search/scripts/lib/sheet.mjs');
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const ov = await import('../../skills/job-search/scripts/lib/overlay.mjs');
const work = await import('../../skills/job-search/scripts/lib/work.mjs');
const g = await import('../../skills/job-search/scripts/lib/batch.mjs');

const NOW = Date.parse('2026-11-23T12:00:00Z');
const empty = { rules: [], lessons: [] };
const U = { roles: ['engineer'], places: ['Berlin'], remote: false, minScore: 70, hosts: ['greenhouse'] };
const profile = { eeoText: 'Decline every voluntary demographic question (test placeholder).', resumePath: '/r.pdf', facts: { first_name: 'Ada', email: 'ada@example.com', authorized_to_work: 'Yes' }, unattended: U };
const Q = [
  { label: 'First Name', required: true, type: 'input_text' },
  { label: 'Resume/CV', required: true, type: 'input_file' },
  { label: 'Why do you want to work here?', required: true, type: 'textarea', maxLength: 300 },
  { label: 'Anything else?', required: false, type: 'textarea', maxLength: 300 },
  { label: 'Gender', required: false, type: 'input_text' },
  { label: 'Preferred start date', required: true, type: 'select', options: ['Immediately', 'In a month'] },
];
const DRAFTS = { 'Why do you want to work here?': 'I enjoy building developer tools.', 'Anything else?': 'Happy to talk.', 'Preferred start date': 'Immediately' };
const build = (over = {}) => sheet.buildSheet({ job: mkJob({ key: 'k1', eeoAnswers: { gender: 'Decline to self-identify' } }), questions: Q, profile, drafts: DRAFTS, answers: [], ...over });
const tagOf = (sh, label) => sh.fields.find((f) => f.label === label).tag;

test('each source tag is set correctly', () => {
  const sh = build();
  assert.equal(tagOf(sh, 'First Name'), 'fact');
  assert.equal(tagOf(sh, 'Resume/CV'), 'upload');
  assert.equal(tagOf(sh, 'Gender'), 'fact', 'the EEO choice is a fact');
  assert.equal(tagOf(sh, 'Why do you want to work here?'), 'new_writing');
  const earlier = [{ q: 'why do you want to work here', answer: 'I like compilers.', how: 'approved', type: 'textarea', options: null }];
  assert.equal(tagOf(build({ answers: earlier }), 'Why do you want to work here?'), 'answer');
  assert.ok(sheet.checkSheet(sh).ok);
});

test('a required field with no tag fails sheet check', () => {
  const sh = build();
  sh.fields[0].tag = undefined;
  assert.match(sheet.checkSheet(sh).problems.join(' '), /no source tag/);
  const noDraft = build({ drafts: {} });
  assert.ok(noDraft.unanswered.length >= 1);
  assert.equal(sheet.checkSheet(noDraft).ok, false);
});

test('normalization: case, spacing, required marks and end punctuation do not matter; one changed word does', () => {
  const entries = [{ q: ans.normalizeQuestion('Why do you want to work here?'), answer: 'A', how: 'typed', type: 'textarea', options: null }];
  const field = (label, extra = {}) => ({ label, type: 'textarea', ...extra });
  for (const l of ['  WHY do   you want to work here ', 'Why do you want to work here? *', 'Why do you want to work here (required)', 'Why do you want to work here:', 'Ｗhy do you want to work here?']) assert.ok(ans.matchAnswer(field(l), entries), l);
  assert.equal(ans.matchAnswer(field('Why do you want to work with us?'), entries), null, 'a question with one word changed is new writing');
  const sh = build({ answers: [{ ...entries[0], q: ans.normalizeQuestion('Why do you want to work there?') }] });
  assert.equal(tagOf(sh, 'Why do you want to work here?'), 'new_writing');
});

test('the type, option and length checks', () => {
  const e = (extra) => [{ q: 'pick one', answer: 'In a month', how: 'typed', type: 'select', options: ['Immediately', 'In a month'], ...extra }];
  assert.ok(ans.matchAnswer({ label: 'Pick one', type: 'select', options: ['Immediately', 'In a month'] }, e()));
  assert.equal(ans.matchAnswer({ label: 'Pick one', type: 'input_text' }, e()), null, 'type must match');
  assert.equal(ans.matchAnswer({ label: 'Pick one', type: 'select', options: ['Now', 'Later'] }, e()), null, 'the answer must still be an option');
  const long = [{ q: 'tell us', answer: 'x'.repeat(50), how: 'typed', type: 'textarea', options: null }];
  assert.ok(ans.matchAnswer({ label: 'Tell us', type: 'textarea', maxLength: 50 }, long));
  assert.equal(ans.matchAnswer({ label: 'Tell us', type: 'textarea', maxLength: 49 }, long), null, 'the text must fit the limit');
});

test('the earlier-answer store keeps question, answer, how, date and source application', () => {
  const e = ans.addAnswer({ question: 'Why us? *', answer: 'Because.', how: 'typed', source: 'k0', type: 'textarea', now: NOW });
  assert.deepEqual(Object.keys(e).sort(), ['answer', 'date', 'how', 'options', 'q', 'source', 'type']);
  assert.equal(e.q, 'why us');
  assert.equal(e.date, '2026-11-23');
  assert.ok(fs.existsSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'answers.json')));
  assert.throws(() => ans.addAnswer({ question: 'x', answer: 'y', how: 'guessed' }), /typed or approved/);
});

// ---- apply next -------------------------------------------------------
const readyJob = (sh, over = {}) => mkJob({ status: 'apply_ready', fit: 80, sheet: { ...sh, passed: true }, verifiedAt: new Date(NOW - 3600000).toISOString(), ...over });
const consentedState = (job, optionalWriting = 'skip') => {
  const s = store.emptyState();
  s.jobs[job.key] = job;
  ap.recordConsent(s, profile, empty, NOW, optionalWriting);
  s.consent.dryRun = { records: [{ key: 'd' }], confirmedAt: new Date(NOW).toISOString(), rulesHash: ov.rulesHash(profile, empty) };
  return s;
};
const next = (s, o = {}) => ap.applyNext({ state: s, profile, overlay: empty, mode: 'unattended', now: NOW, batchOpen: true, writingRulesText: '', ...o });

test('writing_needs_yes: no submit without the writing consent', () => {
  const j = readyJob(build());
  const r = next(consentedState(j));
  assert.equal(r.handout, null);
  assert.deepEqual(r.queue, [{ key: j.key, reason: 'writing_needs_yes' }]);
});

test('a fact-only and an earlier-answer-only job go through with no writing consent', () => {
  const factOnly = readyJob(sheet.buildSheet({ job: mkJob({ key: 'k2', eeoAnswers: { gender: 'Decline to self-identify' } }), questions: [Q[0], Q[1]], profile, answers: [], drafts: {} }), { key: 'k2' });
  assert.ok(next(consentedState(factOnly)).handout);
  const entries = [{ q: 'why do you want to work here', answer: 'I like compilers.', how: 'approved', type: 'textarea', options: null }, { q: 'preferred start date', answer: 'Immediately', how: 'approved', type: 'select', options: ['Immediately', 'In a month'] }];
  const reuse = readyJob(build({ answers: entries, drafts: {} }), { key: 'k3' });
  assert.ok(reuse.sheet.fields.every((f) => f.tag !== 'new_writing'));
  assert.ok(next(consentedState(reuse)).handout, 'a later unattended run reuses an approved draft');
});

test('writing_needs_yes sends one notification and the job stays out of the queue', () => {
  const j = readyJob(build());
  const s = consentedState(j);
  s.jobs[j.key].company = 'Globex';
  const r = next(s);
  work.park(s.jobs[j.key], [r.queue[0].reason]);
  const ov0 = empty;
  const a = work.notifyLine(s, ov0, NOW);
  assert.match(a.line, /Globex/);
  assert.match(a.line, /writing needs yes/);
  s.notified = a.next;
  assert.equal(work.notifyLine(s, ov0, NOW).line, null, 'one notification');
  assert.equal(work.buildWorkList(s, ov0, NOW, {}).items.length, 0);
});

test('a submit goes through once the writing consent exists; a changed writing rule makes it stale', () => {
  const j = readyJob(build());
  const s = consentedState(j);
  ap.recordWritingConsent(s, '- short sentences', NOW);
  assert.ok(next(s, { writingRulesText: '- short sentences' }).handout);
  assert.equal(next(s, { writingRulesText: '- short sentences\n- no adverbs' }).queue[0].reason, 'writing_needs_yes', 'stale after a rule change');
  assert.equal(next(s, { writingRulesText: '' }).queue[0].reason, 'writing_needs_yes');
  ap.recordWritingConsent(s, '- short sentences\n- no adverbs', NOW);
  assert.ok(next(s, { writingRulesText: '- short sentences\n- no adverbs' }).handout);
});

test('revoking writing stops only submits with new writing; revoking unattended stops every unattended submit', () => {
  const nw = readyJob(build(), { key: 'k4' });
  const fact = readyJob(sheet.buildSheet({ job: mkJob({ key: 'k5', eeoAnswers: { gender: 'Decline to self-identify' } }), questions: [Q[0], Q[1]], profile, answers: [], drafts: {} }), { key: 'k5' });
  const s = consentedState(nw);
  s.jobs[fact.key] = fact;
  ap.recordWritingConsent(s, '', NOW);
  assert.equal(next(s).handout.key, nw.key.length ? next(s).handout.key : null);
  ap.revokeConsent(s, 'writing');
  const r = next(s);
  assert.equal(r.handout.key, 'k5', 'fact-only submits go on');
  assert.deepEqual(r.queue, [{ key: 'k4', reason: 'writing_needs_yes' }]);
  ap.revokeConsent(s, 'unattended');
  assert.equal(next(s).refused, 'no_consent');
  assert.throws(() => ap.revokeConsent(s, 'everything'), /revoke unattended, writing or email/);
});

test('optional writing fields skip or wait as recorded', () => {
  const sh = sheet.buildSheet({ job: mkJob({ key: 'k6', eeoAnswers: { gender: 'Decline to self-identify' } }), questions: Q.filter((q) => ['First Name', 'Resume/CV', 'Anything else?'].includes(q.label)), profile, answers: [], drafts: DRAFTS });
  const j = readyJob(sh, { key: 'k6' });
  const skip = next(consentedState(j, 'skip'));
  assert.deepEqual(skip.handout.skipFields, ['Anything else?']);
  const wait = next(consentedState(j, 'wait'));
  assert.equal(wait.handout, null);
  assert.equal(wait.queue[0].reason, 'writing_needs_yes');
  const s = consentedState(j, 'wait');
  ap.recordWritingConsent(s, '', NOW);
  assert.deepEqual(next(s).handout.skipFields, [], 'with the writing consent the optional text is filled');
});

test('consent record unattended refuses without the choice; there is no default', () => {
  const s = store.emptyState();
  for (const c of [undefined, '', 'default', 'yes']) assert.throws(() => ap.recordConsent(s, profile, empty, NOW, c), /skip or wait/);
  assert.equal(s.consent.unattended, null);
  runJobs(home, ['profile', 'set', JSON.stringify(profile)]);
  const r = runJobs(home, ['consent', 'record', 'unattended']);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /skip or wait/);
});

test('attended mode is unchanged: the person sees the draft and says yes', () => {
  const j = readyJob(build());
  const s = store.emptyState();
  s.jobs[j.key] = j;
  s.approvals[j.key] = { sheetHash: j.sheet.hash };
  assert.ok(ap.applyNext({ state: s, profile, overlay: empty, mode: 'attended', now: NOW, batchOpen: true }).handout);
});

test('approving the text, as it is or edited, makes each field an earlier answer and returns the job to the queue', () => {
  runJobs(home, ['profile', 'set', JSON.stringify(profile)]);
  const j = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/77', url: 'https://boards.greenhouse.io/acme/jobs/77', status: 'apply_ready', company: 'Acme', fit: 90, eeoAnswers: { gender: 'Decline to self-identify' } });
  store.updateState((s) => { Object.assign(s, store.emptyState()); s.jobs[j.key] = j; });
  const q = path.join(home, 'q.json');
  fs.writeFileSync(q, JSON.stringify(Q));
  store.updateState((s) => { s.jobs[j.key].drafts = DRAFTS; });
  runJobs(home, ['sheet', 'build', j.key, '--questions', q]);
  runJobs(home, ['park', j.key, 'writing_needs_yes']);
  const edits = path.join(home, 'edits.json');
  fs.writeFileSync(edits, JSON.stringify({ 'Why do you want to work here?': 'I like small teams.' }));
  const r = runJobs(home, ['writing', 'approve', j.key, '--edits', edits]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.approved, 3);
  assert.equal(r.json.passed, true);
  const entries = ans.loadAnswers().entries.filter((e) => e.source === j.key);
  assert.equal(entries.length, 3);
  assert.equal(entries.find((e) => e.q === 'why do you want to work here').answer, 'I like small teams.');
  assert.ok(entries.every((e) => e.how === 'approved'));
  assert.equal(store.loadState().jobs[j.key].parked, null);
  const sh2 = store.loadState().jobs[j.key].sheet;
  assert.ok(sh2.fields.filter((f) => f.label !== 'Resume/CV').every((f) => f.tag !== 'new_writing'), 'the approved text is now an earlier answer');
});

test('consent record is refused while a batch is open; revoke is always allowed', () => {
  runJobs(home, ['profile', 'set', JSON.stringify(profile)]);
  g.openBatch({ mode: 'attended', uploadPath: '/r.pdf' });
  const refused = runJobs(home, ['consent', 'record', 'writing']);
  assert.equal(refused.code, 4);
  assert.equal(store.loadState().consent.writing, null);
  assert.equal(runJobs(home, ['consent', 'revoke', 'writing']).code, 0);
  g.closeBatch();
  const ok = runJobs(home, ['consent', 'record', 'writing']);
  assert.equal(ok.code, 0);
  assert.ok(store.loadState().consent.writing.hash);
  assert.equal(runJobs(home, ['consent', 'revoke', 'writing']).json.revoked, 'writing');
  assert.equal(store.loadState().consent.writing, null);
});

test('recording the writing consent returns jobs that only waited for it', () => {
  const j = mkJob({ status: 'apply_ready' });
  store.updateState((s) => { Object.assign(s, store.emptyState()); s.jobs[j.key] = j; work.park(s.jobs[j.key], ['writing_needs_yes']); });
  runJobs(home, ['consent', 'record', 'writing']);
  assert.equal(store.loadState().jobs[j.key].parked, null);
});

test('nothing else grants the writing consent: no rule, lesson, op, profile field or command in a batch', () => {
  for (const effect of ['writing_consent', 'consent', 'new_writing', 'allow_new_writing']) {
    assert.throws(() => ov.addRule({ effect, value: true, words: 'sure' }), /vocabulary/);
    assert.throws(() => ov.addLesson({ effect, subject: 'x' }), /tighten-only/);
  }
  assert.throws(() => store.applyOps([{ op: 'consent', which: 'writing' }]), /unknown op/);
  runJobs(home, ['profile', 'set', JSON.stringify({ consent: { writing: { at: 'x', hash: 'y' } } })]);
  store.updateState((s) => { Object.assign(s, store.emptyState()); });
  assert.equal(store.loadState().consent.writing, null);
  g.openBatch({ mode: 'attended', uploadPath: '/r.pdf' });
  assert.equal(runJobs(home, ['consent', 'record', 'writing']).code, 4, 'the CLI refuses it in a batch');
  g.closeBatch();
  assert.equal(ap.writingConsentCurrent(store.emptyState(), ''), false);
});
