import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fixture, mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const emp = await import('../../skills/job-search/scripts/lib/employer.mjs');
const ing = await import('../../skills/job-search/scripts/lib/ingest.mjs');
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const ap = await import('../../skills/job-search/scripts/lib/apply.mjs');
const g = await import('../../skills/job-search/scripts/lib/guard.mjs');
const report = await import('../../skills/job-search/scripts/lib/report.mjs');
const work = await import('../../skills/job-search/scripts/lib/work.mjs');
const fo = await import('../../skills/job-search/scripts/lib/fillonly.mjs');
const plat = await import('../../skills/job-search/scripts/lib/platforms.mjs');

const NOW = Date.parse('2026-11-23T10:00:00Z');
const empty = { rules: [], lessons: [] };
const GH = 'https://boards-api.greenhouse.io/v1/boards';
const LV = 'https://api.lever.co/v0/postings';
const AB = 'https://api.ashbyhq.com/posting-api/job-board';
const ghBoard = (name, jobs) => ({ jobs: jobs.map((j) => ({ id: j.id, title: j.title, company_name: name, location: { name: j.loc || 'Berlin, Germany' }, first_published: j.at || '2026-11-15T00:00:00Z', content: '' })) });
const posting = (over = {}) => ({ title: 'Software Engineer', employer: 'Acme, Inc.', city: 'Berlin', region: '', country: 'DE', remote: false, postedAt: '2026-11-16T00:00:00Z', employmentType: 'Full-time', salary: null, applyLinks: [{ url: 'https://www.linkedin.com/jobs/view/1', publisher: 'LinkedIn' }], description: 'x', sourceUrl: 'https://www.linkedin.com/jobs/view/1', employerWebsite: 'https://www.acme.com', ...over });
const doc = (postings) => ({ need: 'job_postings', query: { role: 'software engineer', place: 'Berlin', remote: false, since: null }, status: 'fulfilled', fullResultPath: '/x', postings });
const run = (obj, f) => ing.ingest({ obj, state: store.loadState(), profile: { places: ['Berlin'], includeOld: true }, overlay: empty, fetch: f, now: NOW });
const reset = () => store.updateState((s) => { Object.assign(s, store.emptyState()); });
const only = () => Object.values(store.loadState().jobs)[0];

test('step 1: an apply link on Greenhouse, Lever or Ashby is exact; a platform link is ignored', () => {
  const c = emp.classifyLinks([{ url: 'https://www.linkedin.com/jobs/view/1', publisher: 'LinkedIn' }, { url: 'https://jobs.lever.co/acme/abc-1/apply', publisher: 'Lever' }]);
  assert.equal(c.target.ats, 'lever');
  assert.equal(c.target.url, 'https://jobs.lever.co/acme/abc-1');
  assert.equal(c.platform.length, 1);
  assert.equal(emp.classifyLinks([{ url: 'https://www.linkedin.com/jobs/view/1', publisher: '' }]).target, null);
});

test('the guess: normalize, drop one trailing suffix, exactly three candidates', () => {
  assert.deepEqual(emp.employerWords('Acme, Inc.'), ['acme']);
  assert.deepEqual(emp.employerWords('Müller Handels GmbH'), ['müller', 'handels']);
  assert.deepEqual(emp.employerWords('Acme Co Ltd'), ['acme', 'co'], 'only one suffix is dropped');
  assert.deepEqual(emp.employerWords('Inc'), ['inc'], 'a name that is only a suffix stays');
  assert.deepEqual(emp.candidates('Big Data Corp.', 'https://www.bigdata.io/careers'), ['bigdata', 'big-data']);
  assert.deepEqual(emp.candidates('Big Data Corp.', 'https://bigdatalabs.io'), ['bigdata', 'big-data', 'bigdatalabs']);
  assert.deepEqual(emp.candidates('Acme', null), ['acme']);
  assert.equal(emp.websiteLabel('https://www.acme.co.uk/jobs'), 'acme');
  assert.equal(emp.websiteLabel('acme.com'), 'acme');
  assert.equal(emp.websiteLabel('not a url'), null);
});

test('step 2 asks at most nine boards and never anything but the candidates', async () => {
  const f = fakeFetch({});
  const r = await emp.probeBoards(posting({ employer: 'Big Data Corp.', employerWebsite: 'bigdatalabs.io' }), { fetch: f, now: NOW });
  assert.equal(r.reason, 'no_board');
  assert.equal(f.calls.length, 9);
  const tokens = new Set(f.calls.map((u) => /boards\/([^/]+)\/jobs|postings\/([^?/]+)|job-board\/([^?/]+)/.exec(u).slice(1).find(Boolean)));
  assert.deepEqual([...tokens].sort(), ['big-data', 'bigdata', 'bigdatalabs']);
  const one = fakeFetch({});
  await emp.probeBoards(posting({ employer: 'Acme', employerWebsite: null }), { fetch: one, now: NOW });
  assert.equal(one.calls.length, 3);
});

test('board ownership: the Greenhouse board name or the website label, nothing else', async () => {
  const jobs = [{ id: 1, title: 'Software Engineer' }];
  // Greenhouse name equals the employer name (suffix dropped)
  let r = await emp.probeBoards(posting(), { fetch: fakeFetch({ [`${GH}/acme/`]: ghBoard('Acme Inc', jobs) }), now: NOW });
  assert.equal(r.match.employerPosting.confidence, 'confirmed');
  assert.equal(r.match.employerPosting.source, 'board_probe');
  // a board under the guessed token but another company's name is not the employer's
  r = await emp.probeBoards(posting({ employerWebsite: null }), { fetch: fakeFetch({ [`${GH}/acme/`]: ghBoard('Acme Hospitality', jobs) }), now: NOW });
  assert.equal(r.reason, 'unconfirmed_board');
  // the token equals the website label
  r = await emp.probeBoards(posting({ employer: 'Acme Corporation Holdings' }), { fetch: fakeFetch({ [`${GH}/acme/`]: ghBoard('Whatever', jobs) }), now: NOW });
  assert.ok(r.match, 'token acme equals the label of acme.com');
  // Lever has no board name: only the label counts
  const lever = [{ id: 'abc', text: 'Software Engineer', categories: { location: 'Berlin', commitment: 'Full-time' }, createdAt: Date.parse('2026-11-15'), workplaceType: 'onsite' }];
  r = await emp.probeBoards(posting({ employerWebsite: null }), { fetch: fakeFetch({ [`${LV}/acme`]: lever }), now: NOW });
  assert.equal(r.reason, 'unconfirmed_board');
  r = await emp.probeBoards(posting(), { fetch: fakeFetch({ [`${LV}/acme`]: lever }), now: NOW });
  assert.equal(r.match.employerPosting.system, 'lever');
});

test('the job match: titles, place, dates, exactly one hit; two hits, none and an unconfirmed board give no match', async () => {
  const f = (jobs, name = 'Acme') => fakeFetch({ [`${GH}/acme/`]: ghBoard(name, jobs) });
  const p = (over) => emp.probeBoards(posting(over), { fetch: f(over.__jobs || [{ id: 1, title: 'Software Engineer' }]), now: NOW });
  assert.ok((await p({})).match);
  assert.equal((await p({ __jobs: [{ id: 1, title: 'software  engineer!' }] })).match.job.sourceId, '1', 'titles compare after normalizing');
  assert.equal((await p({ __jobs: [{ id: 1, title: 'Senior Software Engineer' }] })).reason, 'no_match');
  assert.equal((await p({ __jobs: [{ id: 1, title: 'Software Engineer', loc: 'Paris, France' }] })).reason, 'no_match');
  assert.ok((await p({ remote: true, city: '', __jobs: [{ id: 1, title: 'Software Engineer', loc: 'Remote' }] })).match, 'both remote agree');
  assert.equal((await p({ remote: true, __jobs: [{ id: 1, title: 'Software Engineer', loc: 'Paris' }] })).reason, 'no_match', 'remote against a Paris onsite job');
  assert.equal((await p({ __jobs: [{ id: 1, title: 'Software Engineer', at: '2026-08-01T00:00:00Z' }] })).reason, 'no_match', 'published more than 60 days apart');
  assert.ok((await p({ postedAt: null, __jobs: [{ id: 1, title: 'Software Engineer', at: '2026-08-01T00:00:00Z' }] })).match, 'a missing date does not block');
  assert.equal((await p({ __jobs: [{ id: 1, title: 'Software Engineer' }, { id: 2, title: 'Software Engineer' }] })).reason, 'multiple_matches');
  assert.equal((await emp.probeBoards(posting({ employerWebsite: null }), { fetch: f([{ id: 1, title: 'Software Engineer' }], 'Other Co'), now: NOW })).reason, 'unconfirmed_board');
});

test('step 3, the careers page: a linked board is confirmed, another system is named, a sign-in page is a stop', async () => {
  const jobs = [{ id: 7, title: 'Software Engineer' }];
  const p = { title: 'Software Engineer', employer: 'Acme', city: 'Berlin', remote: false, postedAt: '2026-11-16T00:00:00Z' };
  const linked = emp.parseCareersPage({ status: 200, finalUrl: 'https://acme.test/careers', text: '<a href="https://job-boards.greenhouse.io/acmeco/jobs/1">Jobs</a>' });
  assert.deepEqual(linked.boards, [{ ats: 'greenhouse', token: 'acmeco', region: 'us' }]);
  const r = await emp.resolveFromCareersPage(p, linked, { fetch: fakeFetch({ [`${GH}/acmeco/`]: ghBoard('Totally Different Name', jobs) }), now: NOW });
  assert.equal(r.match.employerPosting.source, 'careers_page');
  assert.equal(r.match.employerPosting.confidence, 'confirmed', 'linked from the employer\'s own page, so no name check');
  const two = await emp.resolveFromCareersPage(p, linked, { fetch: fakeFetch({ [`${GH}/acmeco/`]: ghBoard('X', [...jobs, { id: 8, title: 'Software Engineer' }]) }), now: NOW });
  assert.equal(two.reason, 'multiple_matches');
  const other = emp.parseCareersPage({ status: 200, finalUrl: 'https://acme.test/careers', text: 'Apply: https://acme.wd5.myworkdayjobs.com/en-US/External/job/1' });
  assert.deepEqual((await emp.resolveFromCareersPage(p, other, { fetch: fakeFetch({}) })).other.system, 'Workday');
  for (const page of [{ status: 403, text: '' }, { status: 200, finalUrl: 'https://acme.test/login?next=/careers', text: '' }, { status: 200, finalUrl: 'https://acme.test/careers', text: '<input type="password" name="p">' }]) {
    assert.equal(emp.parseCareersPage(page).kind, 'sign_in');
    assert.equal((await emp.resolveFromCareersPage(p, emp.parseCareersPage(page), { fetch: fakeFetch({}) })).reason, 'sign_in_wall');
  }
  assert.equal(emp.parseCareersPage({ status: 200, finalUrl: 'https://acme.test/careers', text: 'nothing here' }).kind, 'none');
});

test('through ingest: a platform-only posting resolves by a board probe, and the platform URL is kept off the job', async () => {
  reset();
  const f = fakeFetch({ [`${GH}/acme/`]: ghBoard('Acme', [{ id: 55, title: 'Software Engineer' }]) });
  const r = await run(doc([posting()]), f);
  assert.equal(r.added, 1);
  const j = only();
  assert.equal(j.employerPosting.url, 'https://boards.greenhouse.io/acme/jobs/55');
  assert.equal(j.employerPosting.source, 'board_probe');
  assert.equal(j.employerPosting.confidence, 'confirmed');
  assert.ok(f.calls.every((u) => !/linkedin/.test(u)), 'the platform is never fetched');
});

test('each "apply yourself" reason', async () => {
  const cases = [
    ['no_apply_link', posting({ applyLinks: [], sourceUrl: 'https://src.test/1' }), {}],
    ['no_board', posting(), {}],
    ['unconfirmed_board', posting({ employerWebsite: null }), { [`${GH}/acme/`]: ghBoard('Other Co', [{ id: 1, title: 'Software Engineer' }]) }],
    ['multiple_matches', posting(), { [`${GH}/acme/`]: ghBoard('Acme', [{ id: 1, title: 'Software Engineer' }, { id: 2, title: 'Software Engineer' }]) }],
    ['no_match', posting(), { [`${GH}/acme/`]: ghBoard('Acme', [{ id: 1, title: 'Cook' }]) }],
  ];
  for (const [reason, p, map] of cases) {
    reset();
    const rr = await run(doc([p]), fakeFetch(map));
    assert.equal(rr.added, 1, reason);
    const j = only();
    assert.equal(j.unresolved, reason, reason);
    assert.equal(j.employerPosting, null);
    const text = report.renderReport(store.loadState(), empty, { now: NOW });
    assert.match(text, /## Apply yourself \(1\)/);
    assert.ok(text.includes(report.REASONS[reason]), reason);
  }
});

test('careers-page outcomes through ingest: no page, a sign-in wall, another system, a linked board', async () => {
  const setup = async () => {
    reset();
    await run(doc([posting()]), fakeFetch({}));
    const j = only();
    store.updateState((s) => { s.jobs[j.key].status = 'reviewed'; });
    return j;
  };
  const careers = (j, careersUrl = 'https://acme.test/careers') => ({ need: 'careers_page', jobKey: j.key, careersUrl, status: 'fulfilled', fullResultPath: '/x' });
  const step = (j, map, o) => ing.ingest({ obj: careers(j, o), state: store.loadState(), profile: {}, overlay: empty, fetch: fakeFetch(map), now: NOW });
  let j = await setup();
  assert.ok(work.workList({ now: NOW }).items.some((i) => i.reason === 'employer_page'), 'a reviewed job without an employer posting asks for the careers page');
  await step(j, { 'https://acme.test/careers': '<html>nothing</html>' });
  assert.equal(only().unresolved, 'no_careers_page');
  assert.equal(work.workList({ now: NOW }).items.some((i) => i.reason === 'employer_page'), false, 'asked once');
  j = await setup();
  await step(j, { 'https://acme.test/careers': { __page: true, status: 403, text: '' } });
  assert.equal(only().unresolved, 'sign_in_wall');
  j = await setup();
  await step(j, { 'https://acme.test/careers': 'Apply at https://jobs.smartrecruiters.com/Acme/1' });
  assert.equal(only().otherSystem.system, 'SmartRecruiters');
  assert.match(report.renderReport(store.loadState(), empty, { now: NOW }), /Apply on the employer's site \(1\)[\s\S]*SmartRecruiters/);
  j = await setup();
  await step(j, { 'https://acme.test/careers': '<a href="https://boards.greenhouse.io/acmeco">jobs</a>', [`${GH}/acmeco/`]: ghBoard('Elsewhere', [{ id: 9, title: 'Software Engineer' }]) });
  const done = only();
  assert.equal(done.employerPosting.source, 'careers_page');
  assert.equal(done.employerPosting.confidence, 'confirmed');
  assert.equal(done.ats, 'greenhouse');
  // a platform or private address is never fetched as a careers page
  j = await setup();
  const bad = await step(j, {}, 'https://www.linkedin.com/company/acme');
  assert.equal(only().unresolved, 'no_careers_page');
  assert.ok(bad);
});

test('a Y Combinator link is never opened, and a YC-only posting with nothing else reports the Work at a Startup link', async () => {
  reset();
  const yc = posting({ employer: 'Widgets', employerWebsite: 'widgets.test', applyLinks: [{ url: 'https://www.workatastartup.com/jobs/123', publisher: 'Work at a Startup' }, { url: 'https://news.ycombinator.com/item?id=1', publisher: 'HN' }], sourceUrl: 'https://www.workatastartup.com/jobs/123' });
  const f = fakeFetch({});
  await run(doc([yc]), f);
  assert.ok(f.calls.every((u) => !/ycombinator|workatastartup/.test(u)));
  const j = only();
  assert.equal(j.unresolved, 'yc_platform_only');
  assert.equal(j.workAtStartupUrl, 'https://www.workatastartup.com/jobs/123');
  assert.match(report.renderReport(store.loadState(), empty, { now: NOW }), /Widgets: a Y Combinator job[\s\S]*https:\/\/www\.workatastartup\.com\/jobs\/123/);
  // with another posting found, it resolves like any platform job
  reset();
  await run(doc([yc]), fakeFetch({ [`${GH}/widgets/`]: ghBoard('Widgets', [{ id: 3, title: 'Software Engineer' }]) }));
  assert.equal(only().employerPosting.url, 'https://boards.greenhouse.io/widgets/jobs/3');
});

test('platform and YC URLs are never handed out, and the guard denies them', () => {
  const j = (url, over = {}) => mkJob({ status: 'apply_ready', fit: 90, sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [] }, ...over, employerPosting: { url, system: 'greenhouse', token: 'x', jobId: '1', source: 'apply_link', confidence: 'exact', checkedAt: '' } });
  const run1 = (job) => { const s = store.emptyState(); s.jobs[job.key] = job; s.approvals[job.key] = { sheetHash: 'h' }; return ap.applyNext({ state: s, profile: { eeo: 'decline_all' }, overlay: empty, mode: 'attended', now: NOW, guard: { ok: true }, deepseek: { enabled: false } }); };
  for (const url of ['https://www.linkedin.com/jobs/view/1', 'https://de.indeed.com/viewjob?jk=1', 'https://www.glassdoor.com/job-listing/1', 'https://www.ziprecruiter.com/c/x', 'https://www.workatastartup.com/jobs/1', 'https://news.ycombinator.com/item?id=1', 'https://www.ycombinator.com/companies/x']) {
    assert.equal(run1(j(url)).queue[0].reason, 'platform_url', url);
    assert.equal(plat.isNeverAutomated(url), true, url);
  }
  const unconfirmed = j('https://boards.greenhouse.io/acme/jobs/1');
  unconfirmed.employerPosting.confidence = 'unconfirmed';
  assert.equal(run1(unconfirmed).queue[0].reason, 'no_employer_posting');
  assert.equal(run1(mkJob({ status: 'apply_ready', employerPosting: null, sheet: { hash: 'h', passed: true, fields: [] } })).queue[0].reason, 'no_employer_posting');
  assert.ok(run1(j('https://boards.greenhouse.io/acme/jobs/1')).handout);
  assert.equal(plat.isNeverAutomated('https://boards.greenhouse.io/acme'), false);
  for (const mode of ['attended', 'unattended']) {
    const p = g.openBatch({ mode, uploadPath: '/r.pdf' });
    for (const url of ['https://www.workatastartup.com/jobs/1', 'https://news.ycombinator.com/item?id=1', 'https://www.ycombinator.com/jobs', 'https://www.glassdoor.com/x', 'https://www.ziprecruiter.com/x', 'https://de.indeed.com/x', 'https://www.linkedin.com/x']) {
      assert.equal(g.decide({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { url } }, p).decision, 'deny', `${mode} ${url}`);
      assert.equal(g.decide({ tool_name: 'WebFetch', tool_input: { url } }, p).decision, 'deny', `${mode} fetch ${url}`);
    }
    g.closeBatch();
  }
});

test('fill-only never submits, reaches fill_ready, and "I submitted it" makes the job applied', () => {
  const j = mkJob({ status: 'apply_ready', fit: 90, company: 'Globex', sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [] } });
  const s = store.emptyState();
  s.jobs[j.key] = j;
  const next = (o = {}) => ap.applyNext({ state: s, profile: { eeo: 'decline_all' }, overlay: empty, mode: 'attended', now: NOW, guard: { ok: true }, deepseek: { enabled: false }, ...o });
  assert.equal(next().queue[0].reason, 'no_recorded_yes');
  assert.equal(fo.isFillOnly(j, empty), false);
  j.fillOnly = true;
  let h = next().handout;
  assert.equal(h.submit, false);
  assert.equal(h.fillOnly, true);
  assert.equal(h.url, j.employerPosting.url);
  j.fillOnly = false;
  assert.equal(next({ overlay: { rules: [{ effect: 'fill_only', value: true }], lessons: [] } }).handout.submit, false, 'a rule for every job');
  assert.equal(next({ overlay: { rules: [{ effect: 'fill_only', value: 'globex' }], lessons: [] } }).handout.submit, false, 'a rule for a named company');
  assert.equal(next({ overlay: { rules: [{ effect: 'fill_only', value: 'initech' }], lessons: [] } }).handout, null);
  fo.markFillReady(s, j.key, NOW);
  assert.equal(next({ overlay: { rules: [{ effect: 'fill_only', value: true }], lessons: [] } }).handout, null, 'a filled job is not handed out again');
  const wl = work.buildWorkList(s, empty, NOW);
  assert.ok(wl.items.some((i) => i.reason === 'fill_ready' && i.key === j.key));
  assert.equal(wl.items.some((i) => i.reason === 'apply_ready'), false);
  const n = work.notifyLine(s, empty, NOW);
  assert.match(n.line, /1 filled, waiting for your submit/);
  s.notified = n.next;
  assert.equal(work.notifyLine(s, empty, NOW).line, null, 'one notification');
  assert.match(report.renderReport(s, empty, { now: NOW }), /## Filled, waiting for your submit \(1\)/);
  fo.markSubmitted(s, j.key, store.applyOp, NOW);
  assert.equal(s.jobs[j.key].status, 'submitted');
  assert.equal(s.jobs[j.key].fillReady, null);
  assert.equal(s.applications.length, 1);
  assert.throws(() => fo.markSubmitted(s, j.key, store.applyOp), /not filled and waiting/);
});

test('fill-only through the CLI: the rule, the handout and fill done', () => {
  const j = mkJob({ status: 'apply_ready', key: 'https://boards.greenhouse.io/acme/jobs/31' });
  store.updateState((s) => { Object.assign(s, store.emptyState()); s.jobs[j.key] = j; });
  assert.equal(runJobs(home, ['fillonly', j.key, 'on']).json.fillOnly, true);
  assert.equal(runJobs(home, ['fill', 'done', j.key]).code, 0);
  assert.ok(store.loadState().jobs[j.key].fillReady);
  assert.equal(runJobs(home, ['submitted', j.key]).code, 0);
  assert.equal(store.loadState().jobs[j.key].status, 'submitted');
  assert.equal(runJobs(home, ['rules', 'add', '--effect', 'fill_only', '--value', 'true', '--words', 'never submit for me']).json.value, true);
});
