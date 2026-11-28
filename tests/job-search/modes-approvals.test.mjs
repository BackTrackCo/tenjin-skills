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
const sheet = await import(`${S}sheet.mjs`);
const ap = await import(`${S}apply.mjs`);
const work = await import(`${S}work.mjs`);
const approval = await import(`${S}approval.mjs`);
const open = await import(`${S}open.mjs`);

const NOW = Date.now();
const empty = { rules: [], lessons: [] };
const J = (...a) => runJobs(home, a);
const reset = (jobs = [], profile = null) => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'rules.json'), { force: true });
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; });
  if (profile) J('profile', 'set', JSON.stringify(profile));
};
const ready = (n, over = {}) => mkJob({ key: `https://boards.greenhouse.io/acme/jobs/${n}`, status: 'apply_ready', company: `Co${n}`, fit: 80, verifiedAt: new Date().toISOString(), sheet: { hash: `h${n}`, passed: true, eeoMissing: false, fields: [{ label: 'Email', value: 'a@b.test', tag: 'fact', required: true }] }, v: 1, ...over });

// ---- choices only when the options hold the answer ----------------------------------------------
test('no question or option text names the free-text option; a form option that starts with Other is fine', () => {
  const bad = { questions: [{ header: 'X', question: 'Pick one, or type under Other.', options: [{ label: 'A (Recommended)', description: 'a' }, { label: 'B', description: 'b' }] }] };
  assert.match(qs.validateAsk(bad)[0], /names the free-text option/);
  const bad2 = { questions: [{ header: 'X', question: 'Pick one.', options: [{ label: 'A (Recommended)', description: 'tell me more through Other' }, { label: 'B', description: 'b' }] }] };
  assert.ok(qs.validateAsk(bad2).length);
  const ok = { questions: [{ header: 'Missing fact', question: 'How did you hear?', options: [{ label: 'Other job boards', description: 'the form\'s option' }, { label: 'LinkedIn', description: 'x' }] }] };
  assert.deepEqual(qs.validateAsk(ok), []);
  assert.equal(qs.START_RESUME_QUESTION, undefined);
  for (const p of [qs.startQuestions(), qs.followUpQuestion({ company: 'A', title: 'B' }), qs.approveListQuestion(3), qs.autoModeQuestion()]) assert.doesNotMatch(JSON.stringify(p), /through Other|under Other|Other:/);
});

test('a place or a role is a plain question with the guess in its text; a fact uses the form\'s own options or a plain list', () => {
  assert.match(qs.placeQuestion({ guess: 'Berlin', remote: true }).plain, /From your resume I would search Berlin and remote\. Where should I search\?/);
  assert.match(qs.roleQuestion({ guess: 'platform engineer' }).plain, /platform engineer/);
  const fit = qs.factQuestion({ label: 'Export control?', options: ['I am a US person', 'I am not a US person'] });
  assert.deepEqual(fit.questions[0].options.map((o) => o.label), ['I am a US person', 'I am not a US person', 'Skip this job'], 'word for word');
  assert.deepEqual(qs.validateAsk(fit), []);
  const many = qs.factQuestion({ label: 'Status?', options: ['a', 'b', 'c', 'd'] });
  assert.match(many.plain, /Its options are: a; b; c; d\./);
  assert.match(qs.factQuestion({ label: 'Phone?' }).plain, /What should I answer/);
});

test('the follow-up has no "through Other" option and asks what they said in a plain question', () => {
  const f = qs.followUpQuestion({ company: 'Acme', title: 'Engineer' });
  assert.deepEqual(f.questions[0].options.map((o) => o.label), ['No reply yet (Recommended)', 'They replied', 'Interview', 'Rejected']);
  assert.deepEqual(qs.validateAsk(f), []);
  assert.match(qs.followUpDetail({ company: 'Acme' }).plain, /What did Acme say/);
});

// ---- answers from the skill's own records ---------------------------------------------------------
const HEAR = (options, type = 'multi_value_single_select') => [{ label: 'How did you hear about this role?', required: true, type, options, maxLength: null }];
const build = (job, questions, extra = {}) => sheet.buildSheet({ job, questions, profile: { facts: {}, eeoText: 'Decline every voluntary demographic question (test placeholder).' }, ...extra });
test('record: where you heard comes from the recorded source, mapped to the form\'s own option, with a record tag', () => {
  const board = mkJob({});
  assert.deepEqual(build(board, HEAR(['LinkedIn', 'Other job boards', 'Referral', 'LLMs'])).fields[0], { label: 'How did you hear about this role?', value: 'Other job boards', tag: 'record', required: true });
  assert.equal(build(board, HEAR(['Company website', 'Other job boards'])).fields[0].value, 'Company website');
  assert.equal(build({ ...board, via: 'routed', sourceUrl: 'https://www.linkedin.com/jobs/view/1' }, HEAR(['LinkedIn', 'Other job boards'])).fields[0].value, 'LinkedIn');
  assert.equal(build({ ...board, fromPost: 'https://x.com/someone/status/1' }, HEAR(['X', 'Social media', 'Referral'])).fields[0].value, 'X');
  assert.equal(build({ ...board, fromPost: 'https://x.com/someone/status/1' }, HEAR(['Social media', 'Referral'])).fields[0].value, 'Social media');
  assert.equal(build({ ...board, via: 'hn' }, HEAR(['Hacker News', 'Other job boards'])).fields[0].value, 'Hacker News');
  assert.equal(build({ ...board, via: 'hn' }, HEAR(['Developer communities', 'Other'])).fields[0].value, 'Developer communities');
  assert.equal(build({ ...board, via: 'routed' }, HEAR(['Other job boards', 'LinkedIn'])).fields[0].value, 'Other job boards');
});
test('record: a saved answer wins, a free-text field gets a short phrase, no match holds as a new question, LLMs and Referral are never chosen', () => {
  const board = mkJob({});
  const saved = [{ q: 'how did you hear about this role', answer: 'LLMs', how: 'typed', type: 'multi_value_single_select', options: null }];
  assert.deepEqual([build(board, HEAR(['Other job boards', 'LLMs']), { answers: saved }).fields[0].value, build(board, HEAR(['Other job boards', 'LLMs']), { answers: saved }).fields[0].tag], ['LLMs', 'answer']);
  assert.equal(build(board, HEAR(null, 'input_text')).fields[0].value, 'Greenhouse job board');
  assert.equal(build({ ...board, via: 'hn' }, HEAR(null, 'input_text')).fields[0].value, 'Hacker News');
  const none = build(board, HEAR(['Referral', 'LLMs', 'A friend']));
  assert.equal(none.fields.length, 0);
  assert.equal(none.unanswered.length, 1, 'no matching option: a normal new question');
  assert.ok(sheet.TAGS.includes('record'));
  assert.deepEqual(sheet.checkSheet(build(board, HEAR(['Other job boards']))), { ok: true, problems: [] }, 'a record field needs no writing consent');
});

// ---- fill it, I submit; the mode; may-submit; withdraw; the state line ---------------------------------
test('"Fill it, I submit" is in every approval and records fill-only for that job only, with one state line', () => {
  const a = ready(1);
  const b = ready(2);
  reset([a, b]);
  const ask = J('ask', 'approval', '--key', a.key).json;
  assert.deepEqual(ask.questions[0].options.map((o) => o.label), ['Yes, apply (Recommended)', 'Fill it, I submit', 'Not this one']);
  const r = J('approve', a.key, '--fill-only');
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.state, 'Submitted: none. Filling, never submitting: Co1.');
  const s = store.loadState();
  assert.equal(s.jobs[a.key].fillOnly, true);
  assert.equal(s.jobs[b.key].fillOnly, undefined, 'other jobs are unchanged');
  assert.match(J('approve', b.key).json.state, /^Submitted: none\. Applying next: Co2\.$/);
  // the list question and its groups of 12
  assert.deepEqual(qs.approveListQuestion(7).questions[0].options.map((o) => o.label), ['Approve all 7 listed (Recommended)', 'Fill all 7, I submit', 'Pick in groups of 12', 'Not now']);
  const c = ready(3); const d = ready(4);
  store.updateState((st) => { st.jobs[c.key] = c; st.jobs[d.key] = d; });
  assert.equal(J('approve', '--all', '--fill-only').json.fillOnly, true);
  assert.equal(store.loadState().jobs[c.key].fillOnly, true);
});

test('the fill-only mode: every job is handed out as fill-only with no per-job yes, and never submits', () => {
  const j = ready(5);
  const s = store.emptyState();
  s.jobs[j.key] = j;
  const base = { state: s, overlay: empty, mode: 'attended', now: NOW, batchOpen: true };
  assert.equal(ap.applyNext({ ...base, profile: { eeoText: 'Decline every voluntary demographic question (test placeholder).' } }).queue[0].reason, 'no_recorded_yes');
  const h = ap.applyNext({ ...base, profile: { eeoText: 'Decline every voluntary demographic question (test placeholder).', applyMode: 'fill_only' } }).handout;
  assert.deepEqual([h.fillOnly, h.submit], [true, false]);
  assert.equal(ap.applyNext({ ...base, profile: { eeoText: 'Decline every voluntary demographic question (test placeholder).', applyMode: 'open_only' } }).queue[0].reason, 'open_only_mode');
  reset([]);
  assert.equal(J('start', 'record', '--mode', 'fill_only').code, 0);
  assert.equal(J('profile', 'get').json.applyMode, 'fill_only');
  assert.equal(J('start', 'record', '--mode', 'open_only').code, 0);
  assert.equal(J('start', 'record', '--mode', 'nonsense').code, 2);
  assert.equal(work.waitsForPerson(s, { applyMode: 'fill_only' }, { reason: 'apply_ready', key: j.key }), false, 'a fill needs no yes, so the item is work, not a wait');
});

test('may-submit answers no after fill-only, a withdraw, a changed sheet, a closed batch or a stop', () => {
  const j = ready(6);
  reset([j]);
  J('approve', j.key);
  // the job was handed out (apply next), which may-submit now requires
  const st = () => { const s = store.loadState(); s.jobs[j.key].inFlight = { at: new Date().toISOString(), host: 'h', mode: 'attended', submit: true, sheetHash: 'h6' }; return s; };
  const may = (over = {}, open = true) => approval.maySubmit({ ...st(), ...over }, {}, empty, j.key, 'h6', open);
  assert.equal(may().ok, true);
  assert.equal(may({}, false).why, 'batch_closed');
  assert.equal(approval.maySubmit(st(), { applyMode: 'fill_only' }, empty, j.key, 'h6', true).why, 'fill_only');
  assert.equal(approval.maySubmit(st(), {}, empty, j.key, 'other', true).why, 'sheet_changed');
  const stopped = st(); stopped.jobs[j.key].parked = { key: 'k', reasons: ['captcha'] };
  assert.equal(approval.maySubmit(stopped, {}, empty, j.key, 'h6', true).why, 'stopped');
  const r = J('approve', j.key, '--withdraw');
  assert.equal(r.code, 0);
  assert.equal(store.loadState().approvals[j.key], undefined);
  assert.equal(approval.maySubmit(st(), {}, empty, j.key, 'h6', true).why, 'no_yes');
  assert.equal(J('may-submit', j.key).code, 2);
  J('approve', j.key);
  J('fillonly', j.key, 'on');
  assert.equal(approval.maySubmit(st(), {}, empty, j.key, 'h6', true).why, 'fill_only');
  const a = ready(7); const b = ready(8);
  store.updateState((s) => { s.jobs[a.key] = a; s.jobs[b.key] = b; });
  J('approve', a.key); J('approve', b.key);
  assert.equal(J('approve', '--withdraw', '--all').json.withdrawn >= 2, true);
  assert.deepEqual(Object.keys(store.loadState().approvals), []);
});

test('a form\'s own legal terms are their own question with the form\'s text and link', () => {
  const t = J('ask', 'acknowledge', '--json', JSON.stringify({ company: 'Acme', text: 'I accept the privacy notice', link: 'https://acme.test/privacy' })).json;
  assert.match(t.questions[0].question, /I accept the privacy notice \(https:\/\/acme\.test\/privacy\)/);
  assert.deepEqual(t.questions[0].options.map((o) => o.label), ['Yes, I accept', 'Skip this job']);
});

// ---- just open the pages --------------------------------------------------------------------------
const fakeOpen = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-'));
  const log = path.join(dir, 'log');
  const bin = path.join(dir, 'open');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$1" >> "${log}"\n`, { mode: 0o755 });
  return { bin, urls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
};
test('J open opens the exact https URL in the default browser, allows a deny-listed host, refuses local and plain http', () => {
  assert.equal(open.checkOpenUrl('https://www.linkedin.com/jobs/view/1'), null);
  for (const bad of ['http://acme.test/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://u:p@acme.test/x', 'nonsense']) assert.ok(open.checkOpenUrl(bad), bad);
  const f = fakeOpen();
  process.env.JOB_SEARCH_OPEN_BIN = f.bin;
  try {
    const j = ready(11, { otherSystem: { system: 'linkedin.com', url: 'https://www.linkedin.com/jobs/view/9' } });
    reset([j]);
    const item = work.workList({ now: NOW }).items.find((i) => i.key === j.key);
    assert.equal(item.reason, 'open_ready', 'a job on a deny-listed host falls back to opening the page');
    assert.equal(item.waitsForPerson, true);
    const r = J('open', j.key);
    assert.equal(r.json.opened, 1, r.stdout);
    assert.deepEqual(f.urls(), ['https://www.linkedin.com/jobs/view/9']);
    assert.ok(store.loadState().jobs[j.key].openedAt);
    assert.equal(work.workList({ now: NOW }).items.some((i) => i.key === j.key && i.reason === 'open_ready'), false, 'opened pages are not due again');
    J('submitted', j.key);
    const after = store.loadState();
    assert.equal(after.jobs[j.key].status, 'submitted');
    assert.equal(after.jobs[j.key].applied.source, 'person');
    assert.equal(J('open', 'nonsense').json.results[0].opened, false);
    J('batch', 'open', '--unattended');
    assert.equal(J('open', j.key).code, 4, 'attended turns only');
    J('batch', 'close');
  } finally { delete process.env.JOB_SEARCH_OPEN_BIN; }
});

test('"Just open the pages" opens each prepared job\'s employer page, in rank order, and counts it toward the positions', () => {
  const f = fakeOpen();
  process.env.JOB_SEARCH_OPEN_BIN = f.bin;
  try {
    const a = ready(21, { fit: 90 }); const b = ready(22, { fit: 70 });
    reset([a, b], { applyMode: 'open_only' });
    const items = work.workList({ now: Date.now(), commit: true }).items.filter((i) => i.reason === 'open_ready');
    assert.equal(items.length, 2);
    assert.equal(J('open', a.key, b.key).json.opened, 2);
    assert.deepEqual(f.urls(), [a.employerPosting.url, b.employerPosting.url]);
    assert.ok(store.loadState().jobs[a.key].broughtAt);
  } finally { delete process.env.JOB_SEARCH_OPEN_BIN; }
});

// ---- Claude in Chrome, and what the reminder shows --------------------------------------------------
test('with Chrome off every option that needs it carries the note, once in the question text; on adds none', () => {
  const off = qs.startQuestions({ chromeOff: true }).questions[0];
  const need = off.options.filter((o) => o.description.includes(qs.CHROME_NOTE)).map((o) => o.label);
  assert.deepEqual(need, ['Ask me each time (Recommended)', 'Auto apply', 'Fill only, I submit']);
  assert.ok(off.question.includes(qs.CHROME_SENTENCE));
  assert.equal(off.question.split(qs.CHROME_SENTENCE).length, 2, 'said once');
  assert.ok(!off.options.at(-1).description.includes(qs.CHROME_NOTE), 'Just open the pages needs no Chrome');
  assert.doesNotMatch(JSON.stringify(qs.startQuestions({ chromeOff: false })), /Needs Claude in Chrome/);
  const job = ready(31);
  const ap1 = qs.approvalQuestions(job, 'ask', { chromeOff: true }).questions[0];
  const noted = ap1.options.filter((o) => o.description.includes(qs.CHROME_NOTE)).map((o) => o.label);
  assert.deepEqual(noted, ['Employer\'s site (I apply)', 'Fill it, I submit']);
  const plainApproval = qs.approvalQuestions(job, 'employer', { chromeOff: true }).questions[0].options.filter((o) => o.description.includes(qs.CHROME_NOTE)).map((o) => o.label);
  assert.deepEqual(plainApproval, ['Yes, apply (Recommended)', 'Fill it, I submit']);
  const list = qs.approveListQuestion(4, { chromeOff: true }).questions[0].options.filter((o) => o.description.includes(qs.CHROME_NOTE)).map((o) => o.label);
  assert.deepEqual(list, ['Approve all 4 listed (Recommended)', 'Fill all 4, I submit']);
  assert.deepEqual(qs.validateAsk(qs.startQuestions({ chromeOff: true })), []);
  reset([ready(32)]);
  J('chrome', 'set', 'off');
  assert.match(J('ask', 'start').json.questions[0].options[0].description, /Needs Claude in Chrome/);
  const r = J('approve', ready(32).key);
  assert.equal(r.code, 0, 'the pick is still recorded');
  assert.match(r.json.state, /Waiting: Claude in Chrome is off in this session/, 'and the reply gives the steps at once');
  const j = ready(33);
  store.updateState((s) => { s.jobs[j.key] = j; });
  assert.match(J('approve', j.key).json.state, /Waiting: Claude in Chrome is off in this session.*claude --chrome --resume/);
});

test('J chrome set on clears chrome_disconnected and no_chrome_tools holds and job.noChromeTools', () => {
  const j = ready(41, { noChromeTools: true });
  const k = ready(42);
  reset([j, k]);
  store.updateState((s) => { s.held.push({ reason: 'chrome_disconnected', detail: 'Co42' }, { reason: 'no_chrome_tools', detail: 'Co41' }, { reason: 'update_waiting', detail: 'x' }); });
  assert.deepEqual(J('chrome', 'set', 'off').json.cleared, 0);
  assert.equal(store.loadState().held.length, 3, 'off clears nothing');
  const r = J('chrome', 'set', 'on');
  assert.equal(r.json.cleared, 3);
  const s = store.loadState();
  assert.deepEqual(s.held.map((h) => h.reason), ['update_waiting']);
  assert.equal(s.jobs[j.key].noChromeTools, false);
  assert.equal(ap.jobFailure({ job: s.jobs[j.key], state: s, profile: { eeoText: 'Decline every voluntary demographic question (test placeholder).' }, overlay: empty, mode: 'attended', now: Date.now() }) === 'no_chrome_tools', false);
  assert.equal(J('chrome', 'set', 'maybe').code, 2);
});

test('the reminder is built from what is known: unknown both sentences, on the /config sentence, a sent push the rest', () => {
  const both = qs.rcReminder({ rc: 'unknown' });
  assert.match(both, /^Type \/rc to get these notifications on your phone and answer from the Claude app while this session keeps running here\. Then open \/config and turn on "Push when actions required" and "Push when Claude decides", so questions and updates reach your phone\.$/);
  assert.equal(qs.rcReminder({ rc: 'on' }), 'Then open /config and turn on "Push when actions required" and "Push when Claude decides", so questions and updates reach your phone.');
  assert.equal(qs.rcReminder({ rc: 'unknown', pushSent: true }), 'Then open /config and turn on "Push when actions required", so questions reach your phone.', 'a sent push proves Remote Control and the other setting');
  reset();
  assert.equal(J('start', 'record', '--mode', 'attended').json.reminder, both);
  J('rc', 'set', 'on');
  assert.equal(J('start', 'record', '--mode', 'attended').json.reminder, qs.rcReminder({ rc: 'on' }));
  assert.equal(J('rc', 'set', 'maybe').code, 2);
  assert.equal(J('ask', 'start').json.reminder, qs.rcReminder({ rc: 'on' }));
  J('notify', 'result', 'sent');
  assert.equal(J('start', 'record', '--mode', 'attended').json.reminder, qs.rcReminder({ rc: 'on', pushSent: true }), 'a push that was sent proves Remote Control and one setting');
  assert.doesNotMatch(JSON.stringify(qs.startQuestions()), /Remote Control/);
});

test('a push that comes back not sent says its sentence once, by reason: off the /config sentence, none both, present nothing', () => {
  reset();
  const off = J('notify', 'result', 'not_sent', '--reason', 'off').json;
  assert.equal(off.say, 'Then open /config and turn on "Push when actions required" and "Push when Claude decides", so questions and updates reach your phone.');
  assert.equal(J('notify', 'result', 'not_sent', '--reason', 'none').json.say, null, 'once only');
  reset();
  assert.equal(J('notify', 'result', 'not_sent', '--reason', 'none').json.say, qs.rcReminder({ rc: 'unknown' }));
  reset();
  assert.equal(J('notify', 'result', 'not_sent', '--reason', 'present').json.say, null);
  assert.equal(J('notify', 'result', 'sent', '--reason', 'off').code, 2, 'a reason goes with not_sent');
  assert.equal(J('notify', 'result', 'not_sent', '--reason', 'weird').code, 2);
});

test('SKILL.md: the every-start order, approvals only from J ask, withdraw first, may-submit, plain questions, under 10,000 characters', () => {
  const skill = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'SKILL.md'), 'utf8');
  assert.ok(skill.length <= 10000, `${skill.length}`);
  const start = skill.indexOf('`J start status`, `J chrome set on|off`');
  assert.ok(start > 0 && start < skill.indexOf('`J arm`') && skill.indexOf('`J arm`') < skill.indexOf('then `J work --commit`'));
  assert.match(skill, /`J rc set on\|unknown`/);
  assert.match(skill, /Approvals come only from `J ask approval\|approve`/);
  assert.match(skill, /`J approve <key\|--all> --withdraw`/);
  assert.match(skill, /`J may-submit <key> <sheet hash>`/);
  const q = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'references', 'questions.md'), 'utf8');
  assert.match(q, /plain question with your guess in its text/);
  assert.match(q, /No question or option text names the tool's own free-text option/);
  assert.match(skill, /references\/questions\.md has every rule/, 'SKILL.md points to the one place');
  const setup = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'references', 'setup.md'), 'utf8');
  assert.match(setup, /After `claude --chrome --resume` nothing runs by itself/);
  assert.doesNotMatch(skill + setup, /v0-\d\d/);
});
