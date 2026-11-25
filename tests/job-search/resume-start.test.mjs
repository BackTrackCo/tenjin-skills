import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';
import { spawnSync } from 'node:child_process';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const rs = await import(`${S}resume.mjs`);
const router = await import(`${S}router.mjs`);
const ap = await import(`${S}apply.mjs`);
const ov = await import(`${S}overlay.mjs`);
const work = await import(`${S}work.mjs`);
const report = await import(`${S}report.mjs`);
const qs = await import(`${S}questions.mjs`);
const li = await import(`${S}suppliers/linkedin.mjs`);
const prep = await import(`${S}prepare.mjs`);
const __filename = new URL(import.meta.url).pathname;
const ws = await import(`${S}suppliers/websearch.mjs`);
const sup = await import(`${S}suppliers/index.mjs`);
const net = await import(`${S}net.mjs`);
const FAKE = path.join(import.meta.dirname, 'helpers', 'fake-tenjin.mjs');
const empty = { rules: [], lessons: [] };
const pub = async () => [{ address: '93.184.216.34', family: 4 }]; // an injected lookup: every name is public
const stateDir = () => path.join(process.env.TENJIN_SKILLS_DIR, 'job-search');
const reset = (extra = {}) => {
  fs.rmSync(path.join(stateDir(), 'rules.json'), { force: true });
  fs.rmSync(path.join(stateDir(), 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState(), extra); });
};
const J = (...a) => runJobs(home, a);
function fake(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faketenjin-'));
  fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify(script));
  const bin = path.join(dir, 'tenjin');
  fs.writeFileSync(bin, `#!/bin/sh\nFAKE_SCRIPT="${dir}/s.json" FAKE_LOG="${dir}/l.jsonl" exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  return { bin, log: () => (fs.existsSync(`${dir}/l.jsonl`) ? fs.readFileSync(`${dir}/l.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}
const client = (f) => new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300 } });
// a fetch that serves a table and counts its calls
const resp = (status, { type = 'text/html', body = '', headers = {} } = {}) => ({ status, ok: status < 400, headers: { get: (k) => ({ 'content-type': type, ...headers })[k.toLowerCase()] ?? null }, text: async () => body, arrayBuffer: async () => Buffer.from(body) });
const serve = (table) => { const calls = []; const f = async (url) => { calls.push(url); const v = table[url]; return typeof v === 'function' ? v() : v || resp(404); }; f.calls = calls; return f; };

test('J start status asks for the resume itself, in any form, never "the path"', () => {
  reset();
  const r = J('start', 'status').json;
  assert.equal(r.next, 'ask for the resume as a plain question: a file, a link or the text; end with: Waiting for your resume: drop the file here, paste a link, or paste the text.');
  assert.doesNotMatch(JSON.stringify(r), /path/i);
});

test('a file is read in place (text) or kept by path (PDF); a missing file or a placeholder reads nothing; text is saved 0600', () => {
  reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  fs.writeFileSync(path.join(dir, 'cv.md'), 'Pat Example, engineer');
  fs.writeFileSync(path.join(dir, 'cv.pdf'), '%PDF-1.4');
  assert.equal(J('resume', 'set', '--file', path.join(dir, 'cv.md')).json.source, 'file');
  assert.equal(J('profile', 'get').json.resumeText, 'Pat Example, engineer');
  const pdf = J('resume', 'set', '--file', path.join(dir, 'cv.pdf')).json;
  assert.equal(pdf.needsText, true);
  assert.match(pdf.next, /J resume set --text/);
  assert.equal(J('resume', 'set', '--text', 'Pat Example, engineer. Built compilers.').json.source, 'file', 'the text of a saved file keeps its source');
  assert.equal(J('profile', 'get').json.resumePath, path.join(dir, 'cv.pdf'));
  assert.equal(J('resume', 'set', '--file', '[PATH TO RESUME]').json.read, false);
  assert.equal(J('resume', 'set', '--file', path.join(dir, 'nope.pdf')).json.read, false);
  fs.writeFileSync(path.join(dir, 'cv.exe'), 'x');
  assert.match(J('resume', 'set', '--file', path.join(dir, 'cv.exe')).json.ask, /PDF, a Word file, Markdown or text/);
  const t = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'scripts', 'jobs.mjs'), 'resume', 'set', '--text'], { input: 'Typed resume text', encoding: 'utf8', env: { ...process.env, HOME: home, TENJIN_SKILLS_DIR: process.env.TENJIN_SKILLS_DIR } });
  assert.equal(JSON.parse(t.stdout).source, 'text');
  assert.equal(fs.readFileSync(path.join(stateDir(), 'resume.txt'), 'utf8'), 'Typed resume text');
  assert.equal(fs.statSync(path.join(stateDir(), 'resume.txt')).mode & 0o777, 0o600);
  assert.equal(J('profile', 'get').json.resumePath, undefined, 'a text resume has no file');
});

test('a public link is fetched once by code: a PDF becomes resume.pdf, a page resume.txt, both 0600', async () => {
  reset();
  const pdf = serve({ 'https://cv.example.test/me.pdf': resp(200, { type: 'application/pdf', body: '%PDF-1.4 data' }) });
  const a = await rs.fetchResume('https://cv.example.test/me.pdf', pdf, { lookup: pub });
  assert.deepEqual([a.source, path.basename(a.resumePath), a.needsText], ['link', 'resume.pdf', true]);
  assert.equal(fs.statSync(a.resumePath).mode & 0o777, 0o600);
  assert.equal(pdf.calls.length, 1);
  const html = serve({ 'https://cv.example.test/page': resp(200, { body: `<html><body><h1>Pat Example</h1><p>${'Engineer who builds compilers and tools. '.repeat(4)}</p><script>x()</script></body></html>` }) });
  const b = await rs.fetchResume('https://cv.example.test/page', html, { lookup: pub });
  assert.match(b.resumeText, /^Pat Example Engineer who builds/);
  assert.doesNotMatch(b.resumeText, /x\(\)/);
  assert.equal(path.basename(b.resumeTextFile), 'resume.txt');
  assert.equal(html.calls.length, 1, 'fetched once');
});

test('a link is https only, follows at most 3 redirects, and refuses local, private and never-automated hosts at each hop', async () => {
  const redir = (to) => resp(302, { headers: { location: to } });
  const ok = resp(200, { body: 'Pat Example, engineer. '.repeat(10) });
  const chain = (n) => { const t = {}; for (let i = 0; i < n; i++) t[`https://a.test/${i}`] = redir(`https://a.test/${i + 1}`); t[`https://a.test/${n}`] = ok; return t; };
  assert.equal((await rs.fetchResume('https://a.test/0', serve(chain(3)), { lookup: pub })).source, 'link', '3 redirects are allowed');
  assert.match((await rs.fetchResume('https://a.test/0', serve(chain(4)), { lookup: pub })).why, /too many redirects/);
  for (const [name, link, to] of [
    ['http', 'http://a.test/x', null],
    ['local', 'https://localhost/x', null],
    ['private', 'https://192.168.1.5/x', null],
    ['never-automated', 'https://www.indeed.com/x', null],
    ['redirect to local', 'https://a.test/r1', 'https://127.0.0.1/x'],
    ['redirect to private', 'https://a.test/r2', 'https://10.0.0.8/x'],
    ['redirect to a platform', 'https://a.test/r3', 'https://www.glassdoor.com/x'],
    ['redirect to plain http', 'https://a.test/r4', 'http://a.test/x'],
  ]) {
    const f = serve({ [link]: to ? redir(to) : ok });
    const r = await rs.fetchResume(link, f, { lookup: pub });
    assert.equal(r.ask, true, name);
    assert.ok(f.calls.length <= 1, `${name}: nothing past the bad hop is fetched`);
  }
  assert.equal((await rs.fetchResume('https://docs.example.test/x', serve({ 'https://docs.example.test/x': resp(403) }), { lookup: pub })).signIn, true, 'a sign-in answer is reported as signIn');
  await assert.rejects(net.guardedFetch('https://other.test/x', {}, async () => ({}), { allowUrl: 'https://a.test/x' }), /not the one allowed/);
});

const LI = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'router', 'linkedin-profile.json'), 'utf8'));
const liRun = { ...LI.step2.envelope, result: JSON.stringify(LI.step2.envelope.result) };
test('with Tenjin a LinkedIn link is the linkedin_profile need and never goes to guardedFetch; the recorded response reads thin', async () => {
  const url = 'https://www.linkedin.com/in/person-l/';
  assert.deepEqual(li.mapper({ url }), { url: 'https://www.linkedin.com/in/person-l' });
  assert.throws(() => li.mapper({ url: 'https://www.linkedin.com/company/x' }), /not a linkedin\.com\/in/);
  assert.equal(li.RECORDED, true, 'recorded 2026-11-25');
  const a = li.adapter(LI.step2.envelope.result);
  assert.deepEqual(a.employers.map((e) => [e.name, e.start]), [['Example Software Co', '2014-02'], ['Example University', '2018']], 'a string and a number start date are both normalized');
  assert.deepEqual(a.schools.map((e) => e.name), ['Example School of Business'], 'only schools are education, not the board seats');
  assert.doesNotMatch(a.text, /Example Coffee Co|Example Business Council/);
  assert.match(a.text, /^Person L\n\nSeattle, Washington, United States\n\nLeads a software company[\s\S]*Employers:\n- Example Software Co \(2014-02 to now\)/);
  assert.equal(a.thin, true);
  assert.doesNotMatch(JSON.stringify(a), /headline|skills/i, 'no headline and no skills field is invented');
  assert.throws(() => li.adapter({ result: {} }), /no name and no about/);
  assert.equal(li.normDate(2018), '2018');
  assert.equal(li.normDate('2014-02'), '2014-02');
  assert.equal(li.normDate('soon'), null);
  reset({ tenjin: { status: 'ready' } });
  const spy = serve({});
  const f = fake({ answers: [{ ...LI.step1.json, __text: LI.step1.text }, liRun] });
  const r = await rs.setFromLink({ url, state: store.loadState(), client: client(f), fetchImpl: spy });
  assert.equal(r.read, true);
  assert.equal(r.thin, true);
  assert.match(r.resumeText, /Person L/);
  assert.equal(spy.calls.length, 0, 'linkedin.com is never fetched');
  assert.deepEqual(f.log().filter((l) => l.call).map((l) => Object.keys(l.call)[0]), ['query', 'id']);
  // a status other than fulfilled falls back to the export ask
  const g = fake({ answers: [{ ...LI.step1.json, __text: LI.step1.text }, { status: 'failed', reason: 'down' }] });
  const bad = await rs.setFromLink({ url, state: store.loadState(), client: client(g), fetchImpl: spy });
  assert.equal(bad.read, false);
  assert.match(bad.ask, /PDF export/);
});

test('a LinkedIn link gives a thin profile: the role is confirmed with the guess first, and a form that needs more holds only that job', () => {
  const p = qs.resumeChoiceQuestion({ header: 'Role', question: 'Which role should I look for?', guess: 'Engineering leader', next: 'Product manager', source: 'LinkedIn' });
  assert.equal(p.questions[0].options[0].label, 'Engineering leader (from your LinkedIn)');
  assert.deepEqual(qs.validateAsk(p), []);
  assert.match(qs.resumeChoiceQuestion({ header: 'Role', question: 'q', guess: 'g', next: 'n' }).questions[0].options[0].label, /\(from your resume\)$/);
  const upload = mkJob({ status: 'apply_ready', sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [{ label: 'Resume', value: '<resume>', tag: 'upload', required: true }] } });
  const history = mkJob({ status: 'apply_ready', sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [{ label: 'Email', value: 'a@b.test', tag: 'fact', required: true }], unanswered: [{ label: 'Work history with job titles', why: 'no fact' }] } });
  const plain = mkJob({ status: 'apply_ready', sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [{ label: 'Email', value: 'a@b.test', tag: 'fact', required: true }] } });
  const call = (job, profile) => ap.jobFailure({ job, state: { approvals: { [job.key]: { sheetHash: 'h' } }, applications: [], consent: {} }, profile: { eeo: 'decline_all', ...profile }, overlay: empty, mode: 'attended', now: Date.now() });
  const thin = { resumeSource: 'link', resumeThin: true };
  assert.equal(call(upload, thin), 'needs_resume_file');
  assert.equal(call(history, thin), 'needs_resume_file');
  assert.equal(call(plain, thin), null, 'a form the profile can fill is not held');
  assert.equal(call(history, { resumeSource: 'file', resumePath: __filename }), null, 'with a file the work-history rule does not apply');
  // the sheet check parks the same way
  const job = { ...history, sheet: { ...history.sheet, unanswered: [], forbidden: [], fields: [{ label: 'Previous employers and job titles', value: 'x', tag: 'fact', required: true }] } };
  const r = prep.checkJobSheet(job, null, thin);
  assert.equal(r.ok, false);
  assert.deepEqual(job.parked.reasons, ['needs_resume_file']);
});

test('without Tenjin a LinkedIn link asks first, then is a hint moment with an export ask; it is never fetched', async () => {
  reset({ tenjin: { status: 'missing' } });
  const spy = serve({});
  const first = await rs.setFromLink({ url: 'https://www.linkedin.com/in/pat', state: store.loadState(), fetchImpl: spy });
  assert.deepEqual([first.read, first.ask, first.moment], [false, 'tenjin', 'linkedin_resume'], 'the ask comes before the export-or-text fallback');
  J('tenjin', 'ask-done', 'no');
  const r = await rs.setFromLink({ url: 'https://www.linkedin.com/in/pat', state: store.loadState(), fetchImpl: spy });
  assert.equal(r.read, false);
  assert.match(r.hint.line, /LinkedIn profile link/);
  assert.match(r.ask, /PDF export/);
  assert.equal(spy.calls.length, 0);
});

const WS = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'router', 'web-search-api.json'), 'utf8'));
test('the web search: one small input mapper per supplier, one adapter that reads the result shape; the recorded API is a POST with an array of at most 5 domains', () => {
  const need = { role: 'software engineer', place: 'New York', remote: false, since: '2026-11-10' };
  const a = ws.agentsearch.mapper(need);
  assert.deepEqual(a, { query: 'software engineer New York', include_domains: ['jobs.ashbyhq.com', 'boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co'], max_results: 10, date_from: '2026-11-10' });
  assert.ok(a.include_domains.length <= 5 && a.max_results <= 10);
  assert.equal(ws.agentsearch.RECORDED, true);
  const b = ws.brave.mapper({ ...need, remote: true });
  assert.deepEqual(b, { q: 'software engineer New York remote', count: 20, includeDomains: 'jobs.ashbyhq.com,boards.greenhouse.io,job-boards.greenhouse.io,jobs.lever.co', startPublishedDate: '2026-11-10T00:00:00.000Z' });
  assert.equal(ws.brave.RECORDED, false, 'the other API stays unrecorded');
  assert.ok(ws.brave.mapper({ role: 'x'.repeat(900) }).q.length <= 400);
  const need2 = FXneed();
  assert.match(need2, /for the query site:jobs\.ashbyhq\.com software engineer New York, 10 results$/, 'the need keeps the site: form');
  // the recorded result: the adapter keeps the board links; published dates are read against the retrieval time or dropped
  const r = ws.adapter(WS.step2.envelope.result);
  assert.deepEqual(r.results.map((x) => x.url.split('/')[2]), ['job-boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.ashbyhq.com']);
  assert.equal(r.results[0].postedAt.slice(0, 10), '2026-11-13');
  assert.equal(r.results[2].postedAt.slice(0, 10), '2026-11-19', '"6 days ago" is read against retrieved_at');
  assert.equal(ws.readPublished('last Tuesday', '2026-11-25T00:00:00Z'), null, 'free text it cannot read is dropped');
  assert.equal(ws.readPublished('3 hours ago', 'not a date'), null);
  assert.equal(WS.step2.envelope.label, undefined, 'the recorded envelope has no label');
  const x = ws.adapter({ data: { results: [{ link: 'https://jobs.lever.co/acme/abc', description: 'd' }, { url: 'https://www.linkedin.com/jobs/view/1', title: 't' }] } });
  assert.equal(x.results.length, 1, 'another API\'s shape reads the same; only board job links are kept');
  assert.throws(() => ws.adapter({ nope: 1 }), /no results list/);
  assert.equal(sup.pickSupplier(WS.step1.text, 'web_search').host, 'api.agentsearchhq.com');
  assert.equal(sup.pickSupplier('GET https://agent-data-tools.revmesh2074.workers.dev/search/web', 'web_search').host, 'agent-data-tools.revmesh2074.workers.dev');
});
function FXneed() {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'graph.json'), 'utf8')).needTemplates.web_search.replace('{role}', 'software engineer').replace('{place}', 'New York');
}

test('the web search result is never saved: the recorded run keeps no results file, and the supplier must match the spec', async () => {
  reset();
  const run = { ...WS.step2.envelope, result: JSON.stringify(WS.step2.envelope.result) };
  const f = fake({ answers: [{ ...WS.step1.json, __text: WS.step1.text }, run] });
  const before = fs.existsSync(path.join(stateDir(), 'results')) ? fs.readdirSync(path.join(stateDir(), 'results')).length : 0;
  const [r] = await router.runRound([{ kind: 'web_search', text: 'web search API for a script', fields: { role: 'software engineer', place: 'New York', since: '2026-11-10' }, query: { role: 'software engineer', place: 'New York', remote: false, since: '2026-11-10' } }], { client: client(f) });
  assert.equal(r.ok, true);
  assert.equal(r.ingest.fullResultPath, null);
  assert.equal(r.ingest.results.length, 3);
  assert.deepEqual(Object.keys(f.log().find((l) => l.call && l.call.id).call.input).sort(), ['date_from', 'include_domains', 'max_results', 'query'], 'the recorded supplier\'s input names');
  assert.equal(fs.existsSync(path.join(stateDir(), 'results')) ? fs.readdirSync(path.join(stateDir(), 'results')).length : 0, before, 'nothing cached');
});

test('catch-up: the first period takes the catch-up, then the daily number; twice a day splits it; weekly is 7 days', () => {
  const rule = (v) => ({ rules: [{ id: 'r', effect: 'period_max', value: v, words: 'w', date: '2026-11-25' }], lessons: [] });
  const at = new Date(2026, 10, 25, 9, 0).toISOString();
  const lim = (v, profile, when) => ap.periodLimit(rule(v), { profile, now: when.getTime() });
  const v = { catchUp: 50, perDay: 10, at };
  assert.equal(lim(v, {}, new Date(2026, 10, 25, 14)), 50, 'the first period');
  assert.equal(lim(v, {}, new Date(2026, 10, 26, 9)), 10, 'then the daily number, the catch-up is not carried over');
  assert.equal(lim(v, { frequency: 'twice_daily' }, new Date(2026, 10, 25, 10)), 50, 'twice a day: the catch-up covers the period the rule was recorded in');
  assert.equal(lim(v, { frequency: 'twice_daily' }, new Date(2026, 10, 26, 8)), 5);
  assert.equal(lim(v, { frequency: 'twice_daily' }, new Date(2026, 10, 26, 13)), 5);
  assert.equal(lim({ ...v, perDay: 9 }, { frequency: 'twice_daily' }, new Date(2026, 10, 26, 8)), 5, 'the first round takes the odd one');
  assert.equal(lim({ ...v, perDay: 9 }, { frequency: 'twice_daily' }, new Date(2026, 10, 26, 13)), 4);
  assert.equal(lim(v, { frequency: 'weekly' }, new Date(2026, 11, 3)), 70);
  assert.equal(lim({ catchUp: 50, perDay: 'none', at }, {}, new Date(2026, 10, 26, 9)), null, 'no daily number means no limit after the catch-up');
  assert.equal(lim({ catchUp: null, perDay: 10, at }, {}, new Date(2026, 10, 25, 14)), 10, '"10 daily" has no catch-up');
  assert.equal(ap.periodLimit(empty), null, 'no answer is no limit');
  assert.equal(ap.periodLimit(rule(7), { profile: { frequency: 'twice_daily' } }), 7, 'the older numeric rule is a number per period');
});

test('start record keeps the catch-up and the daily number as one rule with the person\'s words', () => {
  reset();
  const r = J('start', 'record', '--mode', 'auto_no_new', '--frequency', 'daily', '--catch-up', '50', '--per-day', '10', '--words', '50 now, 10 daily');
  assert.equal(r.code, 0, r.stdout);
  const [rule] = J('rules').json;
  assert.deepEqual([rule.effect, rule.value.catchUp, rule.value.perDay, rule.words], ['period_max', 50, 10, '50 now, 10 daily']);
  assert.match(rule.value.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(J('rules', 'add', '--effect', 'period_max', '--value', 'many', '--words', 'x').code, 2);
});

test('attended with many sheets: the report lists them in rank order, one question approves them, and each yes is per job and sheet hash', () => {
  const sheet = (n, fit, writing) => mkJob({ key: `https://boards.greenhouse.io/acme/jobs/${n}`, status: 'apply_ready', company: `Co${n}`, title: `Eng ${n}`, fit, fitLine: `fits ${n}`, sheet: { hash: `h${n}`, passed: true, eeoMissing: false, fields: writing ? [{ label: 'Why us?', value: 'Because compilers.', tag: 'new_writing', required: true }] : [{ label: 'Email', value: 'a@b.test', tag: 'fact', required: true }] } });
  reset();
  store.updateState((s) => { for (const j of [sheet(1, 60, false), sheet(2, 90, true), sheet(3, 75, false)]) s.jobs[j.key] = j; });
  const text = report.renderReport(store.loadState(), empty, { now: Date.now() });
  const i = text.indexOf('## Ready for your yes (3)');
  assert.ok(i > 0);
  assert.match(text.slice(i), /90 \| Co2, Eng 2 \| fits 2\n {2}- new answer, "Why us\?": Because compilers\.\n- 75 \| Co3[\s\S]*- 60 \| Co1/);
  const ask = J('ask', 'approve').json;
  assert.deepEqual(ask.questions[0].options.map((o) => o.label), ['Approve all 3 listed (Recommended)', 'Pick in groups of 16', 'Only those with no new answers', 'Not now']);
  assert.deepEqual(qs.validateAsk(ask), []);
  const many = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, company: `C${i}`, title: 't', fitLine: '' }));
  const groups = qs.approvePickQuestions(many);
  assert.equal(groups.length, 3, '40 sheets in calls of up to 16');
  assert.ok(groups[0].questions.length === 4 && groups[0].questions.every((q) => q.multiSelect && q.options.length <= 4));
  assert.deepEqual(qs.validateAsk(groups[0]), []);
  assert.equal(J('approve', '--no-new').json.approved, 2, 'only the sheets with no new answer');
  const st = store.loadState();
  assert.deepEqual(Object.keys(st.approvals).sort(), ['https://boards.greenhouse.io/acme/jobs/1', 'https://boards.greenhouse.io/acme/jobs/3']);
  assert.equal(st.approvals['https://boards.greenhouse.io/acme/jobs/3'].sheetHash, 'h3');
  assert.equal(J('approve', '--all').json.approved, 1);
  assert.equal(J('approve', '--all').code, 2, 'nothing left to approve');
});

test('a form that needs a file holds the job when the resume is text only, and not when a file exists', () => {
  const j = mkJob({ status: 'apply_ready', sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [{ label: 'Resume', value: '<resume>', tag: 'upload', required: true }] } });
  const call = (profile) => ap.jobFailure({ job: j, state: { approvals: { [j.key]: { sheetHash: 'h' } }, applications: [], consent: {} }, profile: { eeo: 'decline_all', ...profile }, overlay: empty, mode: 'attended', now: Date.now() });
  assert.equal(call({ resumeSource: 'text' }), 'needs_resume_file');
  assert.equal(call({ resumeSource: 'link' }), 'needs_resume_file');
  const f = path.join(os.tmpdir(), `cv-${Date.now()}.pdf`);
  fs.writeFileSync(f, 'x');
  assert.equal(call({ resumeSource: 'file', resumePath: f }), null);
});

test('the middle mode still writes: a draft held for the yes shows in full in the report, and only the submit waits', () => {
  const j = mkJob({ status: 'apply_ready', company: 'Initech', title: 'Eng', parked: { key: 'k', reasons: ['writing_needs_yes'] }, sheet: { hash: 'h', passed: true, fields: [{ label: 'Why us?', value: 'Because we both like small tools.', tag: 'new_writing', required: true }] } });
  reset();
  store.updateState((s) => { s.jobs[j.key] = j; });
  assert.match(report.renderReport(store.loadState(), empty, { now: Date.now() }), /Initech, Eng: writing_needs_yes\n {2}- draft for "Why us\?": Because we both like small tools\./);
});

test('the host is resolved before every hop: a name that resolves inside is refused, and so is a failed lookup', async () => {
  const at = (...addrs) => async () => addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  const ok = resp(200, { body: 'Pat Example, engineer. '.repeat(10) });
  for (const [name, addr] of [['loopback', '127.0.0.1'], ['private 10.x', '10.1.2.3'], ['private 172.16', '172.20.0.1'], ['private 192.168', '192.168.0.9'], ['link-local', '169.254.169.254'], ['unspecified', '0.0.0.0'], ['IPv6 loopback', '::1'], ['IPv6 unique-local', 'fd12:3456::1'], ['IPv6 link-local', 'fe80::1'], ['IPv6 unspecified', '::'], ['mapped loopback', '::ffff:127.0.0.1'], ['mapped private (hex)', '::ffff:0a00:0001']]) {
    const f = serve({ 'https://public-looking.test/x': ok });
    const r = await rs.fetchResume('https://public-looking.test/x', f, { lookup: at(addr) });
    assert.equal(r.ask, true, name);
    assert.match(r.why, /resolves to a local or private address/, name);
    assert.equal(f.calls.length, 0, `${name}: nothing was fetched`);
  }
  // any one inside address is enough, even beside a public one
  assert.equal((await rs.fetchResume('https://mixed.test/x', serve({ 'https://mixed.test/x': ok }), { lookup: at('93.184.216.34', '10.0.0.1') })).ask, true);
  // a lookup failure refuses the hop
  const failing = serve({ 'https://gone.test/x': ok });
  const r = await rs.fetchResume('https://gone.test/x', failing, { lookup: async () => { throw new Error('ENOTFOUND'); } });
  assert.match(r.why, /did not resolve/);
  assert.equal(failing.calls.length, 0);
  // a redirect to a name that resolves inside is refused at that hop
  const lookup = async (h) => (h === 'inside.test' ? [{ address: '10.9.9.9', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
  const f = serve({ 'https://start.test/x': resp(302, { headers: { location: 'https://inside.test/y' } }), 'https://inside.test/y': ok });
  const red = await rs.fetchResume('https://start.test/x', f, { lookup });
  assert.match(red.why, /resolves to a local or private address/);
  assert.deepEqual(f.calls, ['https://start.test/x'], 'the inside hop is never fetched');
  // a public address passes, IPv4 and IPv6
  assert.equal((await rs.fetchResume('https://ok.test/x', serve({ 'https://ok.test/x': ok }), { lookup: at('93.184.216.34') })).source, 'link');
  assert.equal((await rs.fetchResume('https://ok6.test/x', serve({ 'https://ok6.test/x': ok }), { lookup: at('2606:2800:220:1:248:1893:25c8:1946') })).source, 'link');
  assert.equal(net.isPrivateAddress('::ffff:8.8.8.8'), false, 'a mapped public address is public');
});
