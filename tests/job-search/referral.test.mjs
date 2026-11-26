import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const ref = await import(`${S}referral.mjs`);
const qs = await import(`${S}questions.mjs`);
const sheet = await import(`${S}sheet.mjs`);
const warm = await import(`${S}warmpath.mjs`);
const routed = await import(`${S}routed.mjs`);
const router = await import(`${S}router.mjs`);
const J = (...a) => runJobs(home, a);
const EEO = 'Decline every voluntary demographic question (test placeholder).';
const U = { roles: ['engineer'], places: ['Berlin'], remote: false, minScore: 50, hosts: ['*'] };
const NOW = Date.parse('2026-11-25T12:00:00Z');
const prof = (extra = {}) => ({ eeoText: EEO, applyMode: 'auto_write', unattended: U, ...extra });
const reset = (jobs = [], profile = prof()) => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'rules.json'), { force: true });
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; });
  J('profile', 'set', JSON.stringify(profile));
};
const job = (n, company, over = {}) => mkJob({ key: `https://jobs.site${n}.test/${company}/jobs/${n}`, status: 'apply_ready', company, title: 'Software Engineer', city: 'Berlin', fit: 90, verifiedAt: new Date().toISOString(), employerPosting: { url: `https://jobs.site${n}.test/${company}/jobs/${n}`, system: 'employer_site', token: null, jobId: null, source: 'careers_page', confidence: 'confirmed' }, sheet: { hash: `h${n}`, passed: true, eeoMissing: false, unanswered: [], forbidden: [], fields: [] }, ...over });
const profileFile = () => JSON.parse(fs.readFileSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), 'utf8'));

test('an unattended submit is refused while the company\'s referral question is open and while its referral is pending; "no one" lets it go', () => {
  const j = job(1, 'Acme Placeholder');
  assert.equal(ref.referralHold(prof(), j), 'referral_check');
  assert.equal(ref.referralHold(prof({ referrals: { 'acme placeholder': { status: 'pending', pendingAt: new Date(NOW).toISOString() } } }), j), 'referral_pending');
  for (const status of ['none', 'in', 'without']) assert.equal(ref.referralHold(prof({ referrals: { 'acme placeholder': { status } } }), j), null, status);
});

test('through the CLI: apply next --unattended names the hold, and may-submit refuses it', () => {
  const a = job(2, 'Acme Placeholder');
  reset([a]);
  J('rules', 'add', '--effect', 'period_max', '--value', '5', '--words', 'five');
  J('consent', 'record', 'unattended', '--optional-writing', 'skip');
  J('dryrun', 'record', a.key, '{}');
  J('dryrun', 'confirm');
  J('batch', 'open', '--unattended');
  let r = J('apply', 'next', '--unattended');
  assert.deepEqual(r.json.queue, [{ key: a.key, reason: 'referral_check' }]);
  J('batch', 'close');
  store.updateState((s) => { s.jobs[a.key].parked = null; });
  const p = profileFile();
  fs.writeFileSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), JSON.stringify({ ...p, referrals: { 'acme placeholder': { status: 'pending', pendingAt: new Date().toISOString() } } }));
  J('batch', 'open', '--unattended');
  r = J('apply', 'next', '--unattended');
  assert.deepEqual(r.json.queue, [{ key: a.key, reason: 'referral_pending' }]);
  J('batch', 'close');
  store.updateState((s) => { s.jobs[a.key].parked = null; });
  fs.writeFileSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), JSON.stringify({ ...p, referrals: { 'acme placeholder': { status: 'none' } } }));
  J('batch', 'open', '--unattended');
  r = J('apply', 'next', '--unattended');
  assert.equal(r.json.handout.key, a.key, 'no one: the job goes on');
  fs.writeFileSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), JSON.stringify({ ...p, referrals: { 'acme placeholder': { status: 'pending', pendingAt: new Date().toISOString() } } }));
  assert.equal(J('may-submit', a.key, 'h2').json.why, 'referral_pending');
});

test('an attended approval shows the pending referral and offers to wait beside the usual options', () => {
  const j = job(3, 'Acme Placeholder');
  const q = qs.approvalQuestions(j, 'employer', { referral: { status: 'pending', referrer: 'Placeholder Person' } });
  assert.deepEqual(q.questions[0].options.map((o) => o.label), ['Yes, apply (Recommended)', 'Fill it, I submit', 'Wait for the referral', 'Not this one']);
  assert.ok(q.application.some((l) => /referral pending at Acme Placeholder: Placeholder Person/.test(l)));
  assert.equal(qs.approvalQuestions(j, 'employer', { referral: { status: 'none' } }).questions[0].options.length, 3);
  assert.deepEqual(qs.validateAsk({ questions: q.questions }), []);
});

test('one question per company, merged across companies; "no one" is never asked again; nothing is asked in a woken turn', () => {
  const jobs = [job(4, 'Acme Placeholder'), job(5, 'Acme Placeholder'), job(6, 'Beta Placeholder')];
  reset(jobs);
  const r = J('ask', 'referral');
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.count, 2);
  assert.equal(r.json.calls.length, 1);
  assert.deepEqual(r.json.calls[0].questions.map((x) => x.question.replace(/ \(.*$/, '')), ['Can someone at Acme Placeholder refer you?', 'Can someone at Beta Placeholder refer you?']);
  assert.deepEqual(r.json.calls[0].questions[0].options.map((o) => o.label), ["Someone can refer me (I'll wait for it)", 'No one, apply as usual', 'Skip these jobs']);
  assert.equal(r.json.calls[0].questions[1].options[2].label, 'Skip this job');
  assert.equal(J('ask', 'referral', '--unattended').json.asked, false);
  assert.equal(J('referral', 'answer', 'acme placeholder', 'none').code, 0);
  const again = J('ask', 'referral');
  assert.equal(again.json.count, 1, 'only the other company');
  J('referral', 'answer', 'beta placeholder', 'none');
  assert.equal(J('ask', 'referral').json.count, 0, 'never asked again');
  assert.equal(profileFile().referrals['acme placeholder'].status, 'none');
});

test('"someone can refer me" keeps the name the person gives, and the follow-up comes after the delay (7 days, or the person\'s own)', () => {
  reset([job(7, 'Acme Placeholder')]);
  J('ask', 'referral');
  assert.match(J('referral', 'answer', 'acme placeholder', 'someone').json.next, /referrer's name/);
  assert.equal(J('referral', 'name', 'acme placeholder', 'Placeholder', 'Person').code, 0);
  assert.equal(profileFile().referrals['acme placeholder'].referrer, 'Placeholder Person');
  const waiting = (at, overlay = { rules: [] }) => ref.referralWaiting(store.loadState(), profileFile(), overlay, at);
  const pendingAt = Date.parse(profileFile().referrals['acme placeholder'].pendingAt);
  assert.equal(waiting(pendingAt + 6 * 86400000).due.length, 0);
  assert.equal(waiting(pendingAt + 8 * 86400000).due.length, 1, 'after 7 days');
  assert.equal(waiting(pendingAt + 3 * 86400000, { rules: [{ effect: 'referral_delay_days', value: 2 }] }).due.length, 1, 'the person\'s own delay');
  const f = ref.followUpQuestion('Acme Placeholder').questions[0];
  assert.equal(f.question, 'Is your referral at Acme Placeholder in?');
  assert.deepEqual(f.options.map((o) => o.label), ['Yes, apply now', 'Not yet', 'Apply without it']);
  assert.equal(J('referral', 'in', 'acme placeholder').code, 0);
  assert.equal(profileFile().referrals['acme placeholder'].status, 'in');
  assert.equal(J('referral', 'notyet', 'acme placeholder').code, 0);
});

test('a referral field gets the name the person gave, never a guess, and wins over the where-you-heard mapping', () => {
  const j = job(8, 'Acme Placeholder', { source: 'indeed' });
  const questions = [
    { label: 'Referred by', required: true, type: 'input_text' },
    { label: 'How did you hear about this job?', required: true, type: 'multi_value_single_select', options: ['Job board', 'Employee referral', 'Other'] },
  ];
  const base = { job: j, questions, answers: [], drafts: {} };
  const withName = sheet.buildSheet({ ...base, profile: { referrals: { 'acme placeholder': { status: 'pending', referrer: 'Placeholder Person' } } } });
  assert.deepEqual(withName.fields.map((f) => [f.label, f.value, f.tag]), [['Referred by', 'Placeholder Person', 'fact'], ['How did you hear about this job?', 'Employee referral', 'fact']]);
  const without = sheet.buildSheet({ ...base, profile: {} });
  assert.deepEqual(without.unanswered.map((u) => u.label), ['Referred by'], 'no name given: nothing is guessed');
  assert.ok(!without.fields.some((f) => f.label === 'Referred by'));
  const none = sheet.buildSheet({ ...base, profile: { referrals: { 'acme placeholder': { status: 'none' } } } });
  assert.ok(!none.fields.some((f) => f.label === 'Referred by'), 'no referral: the name is not used');
});

test('a referral-link apply is recorded on the person\'s word', () => {
  const j = job(9, 'Acme Placeholder');
  reset([j]);
  const r = J('submitted', j.key, '--referral-link');
  assert.equal(r.code, 0, r.stdout);
  const s = store.loadState();
  assert.equal(s.jobs[j.key].status, 'submitted');
  assert.deepEqual([s.jobs[j.key].applied.source, s.jobs[j.key].applied.via], ['person', 'referral_link']);
  assert.equal(s.applications.length, 1);
});

test('the request draft is saved as a draft and never sent: no email draft or handout is made', () => {
  reset([job(10, 'Acme Placeholder')]);
  J('ask', 'referral');
  J('referral', 'answer', 'acme placeholder', 'someone');
  assert.equal(J('referral', 'draft', 'acme placeholder').code, 2, 'the name comes first');
  J('referral', 'name', 'acme placeholder', 'Placeholder Person');
  const d = J('referral', 'draft', 'acme placeholder');
  assert.match(d.json.prompt, /at most 90 words/);
  const file = path.join(home, 'draft.txt');
  fs.writeFileSync(file, 'Hi Placeholder Person, would you be willing to refer me for the engineering role at Acme Placeholder? Thank you.');
  const saved = J('referral', 'draft-save', 'acme placeholder', '--text', file);
  assert.equal(saved.code, 0, saved.stdout);
  assert.match(saved.json.next, /Nothing is sent without that yes/);
  assert.match(profileFile().referrals['acme placeholder'].draft.text, /refer me/);
  fs.writeFileSync(file, 'Hi [name], please refer me.');
  assert.equal(J('referral', 'draft-save', 'acme placeholder', '--text', file).code, 2, 'a placeholder is refused');
  const s = store.loadState();
  assert.deepEqual(Object.keys((s.emails && s.emails.drafts) || {}), [], 'no email draft exists');
  assert.equal(J('email', 'next').json.handout, null);
});

test('a referral command is refused in an unattended batch', () => {
  reset([job(11, 'Acme Placeholder')]);
  J('batch', 'open', '--unattended');
  assert.equal(J('referral', 'answer', 'acme placeholder', 'none').code, 4);
});

// ---- the "also worked at" hints --------------------------------------------------------------------------------
test('only a small past employer gives a hint without the checks; the ranges are read by their upper bound', () => {
  for (const small of ['1-10', '11-50', '2-10']) assert.equal(warm.isSmall(small), true, small);
  for (const big of ['51-200', '201-500', '501-1K', '1K-5K', '10K+', '', null]) assert.equal(warm.isSmall(big), false, String(big));
});

test('a big-employer hint needs both an overlap and a shared team word; a generic word alone is no match; no titles or dates means no hint', () => {
  const me = [{ company: 'Placeholder Labs', title: 'Payments Engineer', start: '2018-06', end: '2021-02' }];
  const cand = (over) => [{ company: 'Placeholder Labs', title: 'Senior Payments Engineer', start: '2019-01', end: '2022-01', ...over }];
  assert.deepEqual(warm.bigEmployerMatch(me, cand(), 'Placeholder Labs', NOW).team, 'payments');
  assert.equal(warm.bigEmployerMatch(me, cand({ start: '2021-06', end: '2023-01' }), 'Placeholder Labs', NOW), null, 'same team, no overlap');
  assert.equal(warm.bigEmployerMatch(me, cand({ title: 'Staff Software Engineer' }), 'Placeholder Labs', NOW), null, 'overlap, generic words only');
  assert.equal(warm.sharedTeamWord('Senior Software Engineer', 'Engineering Manager'), null);
  assert.equal(warm.bigEmployerMatch(me, cand({ title: '' }), 'Placeholder Labs', NOW), null, 'no title');
  assert.equal(warm.bigEmployerMatch(me, cand({ start: null }), 'Placeholder Labs', NOW), null, 'no dates');
  assert.equal(warm.bigEmployerMatch([{ company: 'Placeholder Labs', title: 'Payments Engineer' }], cand(), 'Placeholder Labs', NOW), null, 'the person\'s own dates are missing');
  assert.equal(warm.bigEmployerMatch([], cand(), 'Placeholder Labs', NOW), null);
  assert.equal(warm.bigEmployerMatch(me, cand({ company: 'Other Co' }), 'Placeholder Labs', NOW), null, 'another employer');
});

// A router client that answers by the need: a spec, then the run. It counts the profile reads.
function fakeRouter({ employees, leads, histories }) {
  const reads = [];
  let last = null;
  const client = {
    timeouts: router.TIMEOUTS,
    async start() {},
    async close() {},
    async request(args) {
      if (args.tool === 'companyenrich-properties') { last = 'company'; return { status: 'spec', id: 'o-company', __text: 'company profile lookup' }; }
      if (typeof args.query === 'string') {
        if (/people search/.test(args.query)) { last = 'people'; return { status: 'spec', id: 'o-people', __text: 'POST https://x402.orthogonal.com/people/search' }; }
        last = 'profile';
        last = { profile: /linkedin\.com\/in\/([\w-]+)/.exec(args.query)[1] };
        return { status: 'spec', id: 'o-profile', __text: 'POST https://api.getanyapi.com/v1/run/linkedin.profile' };
      }
      if (args.id === 'o-company') return { status: 'fulfilled', result: JSON.stringify({ name: 'Placeholder Labs', domain: 'placeholderlabs.test', employees, socials: {} }), cost: ['x'] };
      if (args.id === 'o-people') return { status: 'fulfilled', supplier: 'x402.orthogonal.com', result: JSON.stringify({ success: true, total: leads.length, leads }), cost: ['x'] };
      const handle = (last && last.profile) || '';
      reads.push(handle);
      return { status: 'fulfilled', supplier: 'api.getanyapi.com', result: JSON.stringify({ output: { found: true, data: { firstName: handle, lastName: 'Sample', headline: 'x', experience: histories[handle] || [] } } }), cost: ['x'] };
    },
  };
  return { client, reads };
}
const lead = (handle) => ({ firstname: handle, lastname: 'Sample', headline: 'Engineer at Target Placeholder', profileUrl: `https://www.linkedin.com/in/${handle}`, lastJobTitle: 'Software Engineer', lastCompanyName: 'Target Placeholder', address: 'Berlin' });
const exp = (title, start, end) => [{ position: title, companyName: 'Placeholder Labs', startDate: start, endDate: end }];
const history = [{ company: 'Placeholder Labs', title: 'Payments Engineer', start: '2018-06', end: '2021-02' }];

test('small past employer: each person now at the target who also worked there is a hint, with no profile read', async () => {
  reset([job(20, 'Target Placeholder')]);
  const f = fakeRouter({ employees: '11-50', leads: [lead('alex'), lead('sam')], histories: {} });
  const log = await routed.routeWarmPaths({ profile: prof({ resumeHistory: history }), client: f.client, now: NOW });
  assert.equal(log[0].small, true);
  assert.deepEqual(f.reads, [], 'no overlap check for a small employer');
  const hints = store.loadState().alsoWorked['target placeholder'].hints;
  assert.deepEqual(hints.map((h) => [h.name, h.pastCompany, h.basis]), [['alex Sample', 'Placeholder Labs', 'small employer'], ['sam Sample', 'Placeholder Labs', 'small employer']]);
});

test('big past employer: one profile read per candidate, and only the overlap plus the team word makes a hint', async () => {
  reset([job(21, 'Target Placeholder')]);
  const f = fakeRouter({
    employees: '1K-5K',
    leads: [lead('alex'), lead('sam'), lead('kim')],
    histories: { alex: exp('Senior Payments Engineer', 'Jan 2019', 'Jan 2022'), sam: exp('Software Engineer', 'Jan 2019', 'Jan 2022'), kim: exp('Payments Engineer', '2022-06', '2023-01') },
  });
  await routed.routeWarmPaths({ profile: prof({ resumeHistory: history }), client: f.client, now: NOW });
  assert.deepEqual(f.reads.sort(), ['alex', 'kim', 'sam'], 'one read for each candidate');
  const hints = store.loadState().alsoWorked['target placeholder'].hints;
  assert.deepEqual(hints.map((h) => h.name), ['alex Sample']);
  assert.match(hints[0].basis, /same team \(payments\) and overlapping dates/);
  // no titles or dates of the person's own: no hint, and no call is made at all
  const g = fakeRouter({ employees: '1K-5K', leads: [lead('alex')], histories: {} });
  const none = await routed.routeWarmPaths({ profile: prof({}), client: g.client, now: NOW });
  assert.equal(none[0].ok, false);
  assert.deepEqual(g.reads, []);
});

test('hints are shown as contacts marked "also worked at", and nothing reads or stores connections', () => {
  const text = (f) => fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'scripts', f), 'utf8');
  reset([job(22, 'Target Placeholder')]);
  store.updateState((s) => { s.alsoWorked = { 'target placeholder': { company: 'Target Placeholder', hints: [{ name: 'Alex Sample', title: 'Engineer', url: 'https://www.linkedin.com/in/alex', pastCompany: 'Placeholder Labs', basis: 'small employer' }] } }; });
  const out = J('report', '--all').stdout;
  assert.match(out, /Also worked at \(people you could ask; the skill never contacts them, and none counts as a referral unless you say so\)/);
  assert.match(out, /Target Placeholder: Alex Sample, Engineer: also worked at Placeholder Labs \(small employer\)/);
  for (const f of ['lib/warmpath.mjs', 'lib/referral.mjs']) assert.doesNotMatch(text(f).replace(/\/\/.*$/gm, ''), /connections?\b/i, f);
  assert.doesNotMatch(text('lib/suppliers/linkedin-history.mjs').replace(/\/\/.*$/gm, ''), /connection/i);
});

test('the referral question is asked in every apply mode, attended and fill-only too; only an unattended submit is held', () => {
  for (const applyMode of ['attended', 'fill_only', 'open_only', 'auto_write']) {
    reset([job(20, 'Acme Placeholder')], prof({ applyMode }));
    const r = J('ask', 'referral');
    assert.equal(r.json.count, 1, applyMode);
    assert.equal(ref.referralWaiting(store.loadState(), profileFile(), { rules: [], lessons: [] }, NOW).check.length, 1, applyMode);
  }
  const j = job(21, 'Acme Placeholder');
  reset([j], prof({ applyMode: 'attended', referrals: { 'acme placeholder': { status: 'pending', pendingAt: new Date(NOW).toISOString() } } }));
  assert.equal(ref.referralNote(profileFile(), j), 'referral pending at Acme Placeholder');
});

test('the referral request goes through the email flow only to an address the person typed, with its own yes, never under the consent or unattended', () => {
  reset([job(30, 'Acme Placeholder')]);
  J('referral', 'answer', 'acme placeholder', 'someone');
  J('referral', 'name', 'acme placeholder', 'Placeholder Person');
  assert.equal(J('referral', 'email', 'acme placeholder', 'person@example.test').code, 2, 'save the draft first');
  const file = path.join(home, 'draft2.txt');
  fs.writeFileSync(file, 'Hi Placeholder Person, would you be willing to refer me for the engineering role at Acme Placeholder? Thank you.');
  J('referral', 'draft-save', 'acme placeholder', '--text', file);
  assert.equal(J('referral', 'email', 'acme placeholder', 'not an address').code, 2);
  assert.equal(J('referral', 'email', 'acme placeholder', 'person@example.test').code, 0);
  const b = J('email', 'batch');
  assert.deepEqual(b.json.drafts.map((d) => d.to), ['person@example.test']);
  J('email', 'connector', 'send');
  J('consent', 'record', 'email');
  assert.equal(J('email', 'next', '--unattended').json.handout, null, 'the consent and an unattended turn never send it');
  assert.equal(J('email', 'next').json.handout, null, 'not without its own yes');
  J('email', 'approve', b.json.drafts[0].id);
  const h = J('email', 'next').json.handout;
  assert.equal(h.to, 'person@example.test');
  assert.match(h.text, /refer me/);
});
