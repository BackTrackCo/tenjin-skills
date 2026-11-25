import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeFetch, mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const work = await import('../../skills/job-search/scripts/lib/work.mjs');
const ap = await import('../../skills/job-search/scripts/lib/apply.mjs');
const ing = await import('../../skills/job-search/scripts/lib/ingest.mjs');
const emp = await import('../../skills/job-search/scripts/lib/employer.mjs');
const report = await import('../../skills/job-search/scripts/lib/report.mjs');
const graph = (await import('../../skills/job-search/scripts/lib/graph.mjs')).graph();

const NOW = Date.parse('2026-11-23T12:00:00Z');
const empty = { rules: [], lessons: [] };
const reset = (jobs = []) => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'rules.json'), { force: true });
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; });
};
const noPosting = (i, over = {}) => mkJob({ key: `https://www.example-jobs.test/view/${i}`, status: 'reviewed', employerPosting: null, openConfirmed: false, unresolved: 'no_board', company: 'Acme Robotics', title: 'Platform Engineer', city: 'Berlin', employerWebsite: 'https://www.acmerobotics.test', applyLinks: [`https://www.example-jobs.test/view/${i}`], fit: 85, v: 1, ...over });
const careers = (job, extra = {}) => ({ need: 'careers_page', jobKey: job.key, careersUrl: 'https://careers.acmerobotics.test/jobs', status: 'fulfilled', boardLinks: [], otherLinks: [], signIn: false, ...extra });
const listing = (over = {}) => ({ title: 'Platform Engineer', url: 'https://acme.wd1.test/en/job/77', city: 'Berlin', remote: false, ...over });
const ingestCareers = (obj) => ing.ingest({ obj, state: store.loadState(), profile: {}, overlay: empty, fetch: fakeFetch({}), now: NOW });

// ---- apply anywhere except a deny list ---------------------------------------------------------
test('a careers page on the employer\'s own domain that lists the job confirms an application page on any other system', async () => {
  const job = noPosting(1);
  reset([job]);
  await ingestCareers(careers(job, { listings: [listing()] }));
  const j = store.loadState().jobs[job.key];
  assert.deepEqual([j.employerPosting.url, j.employerPosting.system, j.employerPosting.source, j.employerPosting.confidence], ['https://acme.wd1.test/en/job/77', 'employer_site', 'careers_page', 'confirmed']);
  assert.equal(j.openConfirmed, true);
  assert.equal(j.board, null, 'no board API, so no board name');
  assert.ok(j.verifiedAt);
});

test('apply next hands that job out on a host that is on no list, and never gates by host', async () => {
  const job = mkJob({ status: 'apply_ready', fit: 80, sheet: { hash: 'sh1', passed: true, eeoMissing: false, fields: [] }, verifiedAt: new Date(NOW - 3600000).toISOString(), ats: 'employer_site', employerPosting: { url: 'https://acme.wd1.test/en/job/77', system: 'employer_site', token: null, jobId: null, source: 'careers_page', confidence: 'confirmed', checkedAt: new Date(NOW).toISOString() } });
  const s = store.emptyState();
  s.jobs[job.key] = job;
  s.approvals[job.key] = { sheetHash: 'sh1' };
  const r = ap.applyNext({ state: s, profile: { eeoText: 'Decline every voluntary demographic question (test placeholder).' }, overlay: empty, mode: 'attended', now: NOW, batchOpen: true });
  assert.equal(r.handout.url, 'https://acme.wd1.test/en/job/77');
  // a deny-listed host is the only host gate
  job.employerPosting.url = 'https://www.linkedin.com/jobs/view/5';
  assert.equal(ap.applyNext({ state: s, profile: { eeoText: 'Decline every voluntary demographic question (test placeholder).' }, overlay: empty, mode: 'attended', now: NOW, batchOpen: true }).queue[0].reason, 'platform_url');
  // unattended rules may name any hiring system, or any
  const u = { roles: ['engineer'], places: ['Berlin'], minScore: 70, hosts: ['*'] };
  assert.deepEqual(ap.unattendedProblems({ eeoText: 'Decline every voluntary demographic question (test placeholder).', unattended: u }), []);
});

test('the deny list holds the sites named in the plan, and only the deny list gates the browser', () => {
  for (const h of ['linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'monster.com', 'simplyhired.com', 'careerbuilder.com', 'dice.com', 'wellfound.com', 'ycombinator.com', 'workatastartup.com', 'x.com', 'twitter.com']) assert.ok(graph.neverHosts.includes(h), h);
  const batch = JSON.stringify(graph);
  assert.ok(graph.hosts.every((h) => ['greenhouse', 'lever', 'ashby'].includes(h)), 'the three systems stay as code adapters');
  assert.ok(batch.includes('applyHostNames'));
});

test('a listing off the employer\'s own domain, a sign-in page and a deny-listed application page are not confirmed', async () => {
  const a = noPosting(2);
  const b = noPosting(3);
  const c = noPosting(4);
  const d = noPosting(5);
  reset([a, b, c, d]);
  await ingestCareers(careers(a, { careersUrl: 'https://some-aggregator.test/acme', listings: [listing()] }));
  assert.equal(store.loadState().jobs[a.key].unresolved, 'no_careers_page', 'the page is not the employer\'s own');
  await ingestCareers(careers(b, { signIn: true }));
  assert.equal(store.loadState().jobs[b.key].unresolved, 'sign_in_wall');
  await ingestCareers(careers(c, { listings: [listing({ url: 'https://www.linkedin.com/jobs/view/9' })] }));
  const cj = store.loadState().jobs[c.key];
  assert.equal(cj.employerPosting, null);
  assert.equal(cj.unresolved, 'other_system');
  assert.equal(cj.otherSystem.url, 'https://www.linkedin.com/jobs/view/9');
  await ingestCareers(careers(d, { listings: [listing({ title: 'Office Manager' })] }));
  assert.equal(store.loadState().jobs[d.key].unresolved, 'no_match', 'title and place must match');
});

test('the open check: a later read that no longer lists the job closes it, and a stale check brings the item back', async () => {
  const job = noPosting(6);
  reset([job]);
  await ingestCareers(careers(job, { listings: [listing()] }));
  assert.equal(work.workList({ now: NOW }).items.some((i) => i.reason === 'employer_page'), false);
  const later = NOW + 30 * 3600000;
  const item = work.workList({ now: later }).items.find((i) => i.reason === 'employer_page');
  assert.ok(item && item.reverify, 'the careers page is read again once the check is a day old');
  await ingestCareers(careers(job, { listings: [listing({ title: 'Other Role', url: 'https://acme.wd1.test/en/job/1' })] }));
  assert.equal(store.loadState().jobs[job.key].status, 'closed');
});

test('classifyLinks no longer reports other systems; other_system means a deny-listed host only', () => {
  const r = emp.classifyLinks([{ url: 'https://acme.wd1.myworkdayjobs.com/en/job/1' }, { url: 'https://www.linkedin.com/jobs/view/3' }]);
  assert.equal(r.other, null);
  assert.equal(r.platform.length, 1);
});

test('the first application on a host shows once in the full report', () => {
  const job = mkJob({ status: 'submitted', employerPosting: { url: 'https://acme.wd1.test/en/job/77', system: 'employer_site', token: null, jobId: null, source: 'careers_page', confidence: 'confirmed' } });
  reset([job]);
  store.updateState((s) => { s.applications.push({ key: job.key, companyKey: 'x', at: new Date(NOW).toISOString() }); });
  assert.match(report.renderReport(store.loadState(), empty, { now: NOW, profile: {} }), /first application on acme\.wd1\.test/);
  runJobs(home, ['report', '--all']);
  assert.doesNotMatch(report.renderReport(store.loadState(), empty, { now: NOW, profile: {} }), /first application on acme\.wd1\.test/);
});

// ---- B1: the inputs hash is per reason ----------------------------------------------------------------
test('B1: saving a form fact or an answer revives no job left as low_score', () => {
  const job = noPosting(7, { unresolved: 'no_board' });
  reset([job]);
  runJobs(home, ['profile', 'set', JSON.stringify({ search: { role: 'platform engineer' } })]);
  assert.equal(runJobs(home, ['leave', job.key, '--reason', 'low_score']).code, 0);
  const due = () => work.workList({ now: NOW, commit: true }).items.map((i) => i.key).filter((k) => k !== 'search');
  assert.deepEqual(due(), []);
  for (const fact of [['citizenship', 'US'], ['visa', 'none'], ['clearance', 'no']]) runJobs(home, ['fact', 'set', ...fact]);
  assert.deepEqual(due(), [], 'the form facts are in no leave reason\'s hash');
  runJobs(home, ['answer', 'add', '--label', 'x', '--value', 'y']);
  assert.deepEqual(due(), []);
  runJobs(home, ['profile', 'set', JSON.stringify({ search: { role: 'staff engineer' } })]);
  assert.deepEqual(due(), [job.key], 'a changed role does bring it back');
});

// ---- B2: a push only for what the person was not shown -------------------------------------------------
test('B2: an item shown in the report leaves the notify set until its version changes', () => {
  const waiting = (n) => mkJob({ key: `https://boards.greenhouse.io/acme/jobs/${n}`, status: 'apply_ready', company: `Co${n}`, fit: 90, verifiedAt: new Date(NOW).toISOString(), sheet: { hash: 'h', passed: true, fields: [] }, v: 1 });
  const a = waiting(31);
  reset([a]);
  assert.match(work.notifyLine(store.loadState(), empty, NOW).line, /1 application waits|1 application wait/);
  runJobs(home, ['report']);
  const s = store.loadState();
  assert.equal(work.notifyLine(s, empty, NOW).line, null, 'shown, so no push');
  store.updateState((st) => { st.jobs[a.key].hash = 'changed'; });
  assert.match(work.notifyLine(store.loadState(), empty, NOW).line, /1 application/, 'a new version of the item pushes again');
  store.updateState((st) => { const b = waiting(32); st.jobs[b.key] = b; });
  assert.match(work.notifyLine(store.loadState(), empty, NOW).line, /2 application/);
  runJobs(home, ['shown', `yes:${a.key}`]);
  assert.match(work.notifyLine(store.loadState(), empty, NOW).line, /1 application/, 'J shown leaves one item out');
});

// ---- B3: a rule asked as a question -------------------------------------------------------------------
test('B3: J rules add --from-choice keeps the option label as the person\'s words', () => {
  reset();
  const r = runJobs(home, ['rules', 'add', '--from-choice', 'Skip clearance-restricted jobs', '--effect', 'exclude_term', '--value', 'clearance']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.words, 'Skip clearance-restricted jobs');
  assert.match(r.json.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(runJobs(home, ['rules', 'add', '--from-choice', '--effect', 'exclude_term', '--value', 'x']).code, 2, 'a label is needed');
});

// ---- where the person prefers to apply ---------------------------------------------------------
test('the start records where to apply as the person\'s setting; no answer means the employer\'s site', () => {
  reset();
  assert.equal(runJobs(home, ['start', 'record', '--mode', 'attended', '--frequency', 'daily', '--no-limit', '--where', 'linkedin']).code, 0);
  assert.deepEqual(runJobs(home, ['profile', 'get']).json.apply, { where: 'linkedin', source: 'person' });
  assert.equal(runJobs(home, ['start', 'record', '--where', 'nowhere']).code, 2);
  runJobs(home, ['start', 'record', '--mode', 'attended']);
  assert.deepEqual(runJobs(home, ['profile', 'get']).json.apply, { where: 'employer', source: 'person' });
  assert.ok(!runJobs(home, ['start', 'status']).json.missing.includes('start_questions'));
});

const li = 'https://www.linkedin.com/jobs/view/12345';
const liJob = (i, over = {}) => mkJob({ key: `https://boards.greenhouse.io/acme/jobs/${i}`, status: 'apply_ready', fit: 88, company: `Co${i}`, linkedinUrl: li, verifiedAt: new Date().toISOString(), sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [{ label: 'Email', value: 'a@b.test', tag: 'fact', required: true }] }, v: 1, ...over });

test('under the LinkedIn choice apply next never hands the job out; the link is shown with the answers', () => {
  const j = liJob(41);
  reset([j]);
  const profile = { eeoText: 'Decline every voluntary demographic question (test placeholder).', apply: { where: 'linkedin', source: 'person' } };
  assert.equal(ap.applyPathOf(j, profile), 'linkedin');
  const s = store.loadState();
  s.approvals[j.key] = { sheetHash: 'h' };
  assert.equal(ap.applyNext({ state: s, profile, overlay: empty, mode: 'attended', now: Date.now(), batchOpen: true }).queue[0].reason, 'linkedin_path');
  runJobs(home, ['profile', 'set', JSON.stringify(profile)]);
  const item = work.workList({ now: Date.now() }).items.find((i) => i.key === j.key);
  assert.equal(item.reason, 'linkedin_ready');
  const shown = runJobs(home, ['linkedin', 'show', j.key]);
  assert.equal(shown.json.link, li);
  assert.deepEqual(shown.json.answers.map((a) => a.label), ['Email']);
  assert.equal(work.workList({ now: Date.now() }).items.find((i) => i.key === j.key).reason, 'linkedin_applied', 'asked once after the link was shown');
});

test('a job with no LinkedIn link takes the employer site, and the employer choice never shows a link', () => {
  const none = mkJob({ status: 'apply_ready' });
  assert.equal(ap.applyPathOf(none, { apply: { where: 'linkedin', source: 'person' } }), 'employer');
  assert.equal(ap.applyPathOf(liJob(42), { apply: { where: 'employer', source: 'person' } }), 'employer');
  assert.equal(ap.applyPathOf(liJob(43), {}), 'employer', 'no answer means the employer\'s site');
  assert.equal(ap.applyPathOf(liJob(44), { apply: { where: 'ask', source: 'person' } }), 'ask');
  assert.equal(ap.applyPathOf(liJob(45, { employerPosting: null }), { apply: { where: 'ask', source: 'person' } }), 'linkedin', 'only LinkedIn exists: no choice to ask');
});

test('"Did you apply?" is a question; applied is recorded only on the person\'s word, source person', () => {
  const j = liJob(46);
  reset([j]);
  runJobs(home, ['profile', 'set', JSON.stringify({ apply: { where: 'linkedin', source: 'person' } })]);
  runJobs(home, ['linkedin', 'show', j.key]);
  const q = runJobs(home, ['ask', 'applied', '--key', j.key]).json;
  assert.deepEqual(q.questions[0].options.map((o) => o.label), ['Yes', 'Not yet', 'Skip this job']);
  assert.equal(store.loadState().jobs[j.key].status, 'apply_ready', 'nothing is recorded by showing the link');
  runJobs(home, ['linkedin', 'applied', j.key, 'not_yet']);
  assert.equal(work.workList({ now: Date.now() }).items.some((i) => i.key === j.key), false, 'not yet: not asked again until the job changes');
  store.updateState((s) => { s.jobs[j.key].fit = 91; });
  assert.equal(work.workList({ now: Date.now() }).items.find((i) => i.key === j.key).reason, 'linkedin_applied', 'a changed job asks again');
  assert.equal(runJobs(home, ['linkedin', 'applied', j.key, 'maybe']).code, 2);
  runJobs(home, ['linkedin', 'applied', j.key, 'yes']);
  const after = store.loadState();
  assert.equal(after.jobs[j.key].status, 'submitted');
  assert.deepEqual([after.jobs[j.key].applied.source, after.applications.at(-1).source], ['person', 'person']);
});

test('"Ask me each job" puts the choice in the approval call, and a plain approve is refused until it is made', () => {
  const j = liJob(47);
  reset([j]);
  runJobs(home, ['profile', 'set', JSON.stringify({ apply: { where: 'ask', source: 'person' } })]);
  const q = runJobs(home, ['ask', 'approval', '--key', j.key]).json;
  assert.deepEqual(q.questions[0].options.map((o) => o.label), ['Employer\'s site (I apply)', 'Fill it, I submit', 'LinkedIn (you apply)', 'Skip this job']);
  assert.equal(runJobs(home, ['approve', j.key]).code, 4, 'no approval before the where is chosen');
  assert.equal(runJobs(home, ['approve', j.key, '--via', 'linkedin']).json.via, 'linkedin');
  assert.equal(ap.applyPathOf(store.loadState().jobs[j.key], { apply: { where: 'ask' } }), 'linkedin');
  const k = liJob(48);
  store.updateState((s) => { s.jobs[k.key] = k; });
  assert.equal(runJobs(home, ['approve', k.key, '--via', 'employer']).code, 0);
  assert.equal(store.loadState().jobs[k.key].applyVia, 'employer');
  assert.ok(store.loadState().approvals[k.key]);
});

test('a LinkedIn job counts toward period_max once its link and answers are brought', () => {
  const jobs = [liJob(51, { fit: 90 }), liJob(52, { fit: 80 }), liJob(53, { fit: 70 })];
  reset(jobs);
  runJobs(home, ['profile', 'set', JSON.stringify({ apply: { where: 'linkedin', source: 'person' } })]);
  runJobs(home, ['rules', 'add', '--effect', 'period_max', '--value', '2', '--words', 'two a period']);
  const wl = work.workList({ now: Date.now(), commit: true });
  assert.deepEqual(wl.items.filter((i) => i.reason === 'linkedin_ready').map((i) => i.key), [jobs[0].key, jobs[1].key]);
  assert.equal(wl.heldForPeriod, 1);
  assert.equal(work.workList({ now: Date.now() }).items.filter((i) => i.reason === 'linkedin_ready').length, 2, 'brought ones stay, the third waits for the next period');
});

test('the LinkedIn link is read from the posting\'s apply options and never fetched', async () => {
  const p = { title: 'Platform Engineer', employer: 'Acme', employerWebsite: null, city: 'Berlin', region: '', country: '', remote: false, employmentType: '', postedAt: new Date(NOW).toISOString().slice(0, 10), salary: null, applyLinks: [{ url: li, publisher: 'LinkedIn' }], description: 'x', sourceUrl: 'https://www.example-jobs.test/p/1' };
  const obj = { need: 'job_postings', status: 'fulfilled', query: { role: 'engineer', place: 'Berlin', remote: false, since: null }, postings: [p] };
  const f = fakeFetch({});
  await ing.ingest({ obj, state: store.loadState(), profile: {}, overlay: empty, fetch: f, now: NOW });
  const job = Object.values(store.loadState().jobs).find((j) => j.company === 'Acme');
  assert.equal(job.linkedinUrl, li);
  assert.ok(!f.calls.some((u) => /linkedin\.com/.test(u)), 'LinkedIn is never fetched');
});

test('SKILL.md and apply.md: gate 4 is the deny list, LinkedIn is only shown, rules come from choices', () => {
  const skill = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'SKILL.md'), 'utf8');
  assert.ok(skill.length <= 10000, `SKILL.md is ${skill.length} characters`);
  assert.match(skill, /except the deny list: LinkedIn, Indeed/);
  assert.match(skill, /A form that needs an account or a sign-in is a stop/);
  assert.doesNotMatch(skill, /on Greenhouse, Lever or Ashby, found/);
  assert.match(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'references', 'questions.md'), 'utf8'), /J rules add --from-choice/, 'the rule lives in questions.md only');
  assert.doesNotMatch(skill, /from-choice/);
  assert.match(skill, /J linkedin show <key>/);
  const apply = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'references', 'apply.md'), 'utf8');
  assert.match(apply, /the host is on the deny list, the form needs an account, a bot check appeared, or no employer posting was found/);
  assert.match(apply, /never opens, fetches or fills it/);
  assert.match(apply, /Employer's site \(I apply\)/);
});
