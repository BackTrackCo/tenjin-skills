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
  assert.equal(r.next, 'ask for the resume as a plain question: a file, a link or the text');
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

test('with Tenjin a LinkedIn link is the linkedin_profile need and never goes to guardedFetch; the mapper needs no headline or skills', async () => {
  const url = 'https://www.linkedin.com/in/pat-example/';
  assert.deepEqual(li.mapper({ url }), { url: 'https://www.linkedin.com/in/pat-example' });
  assert.throws(() => li.mapper({ url: 'https://www.linkedin.com/company/x' }), /not a linkedin\.com\/in/);
  assert.equal(li.RECORDED, false, 'built from the spec, marked unrecorded');
  const profile = { result: { name: 'Pat Example', location: 'Berlin', followers: 10, about: 'I build compilers.', experience: [{ title: 'Engineer', company: 'Acme' }], education: [{ school: 'Uni' }], recentPosts: [] } };
  assert.match(li.adapter(profile).text, /Pat Example\n\nBerlin\n\nI build compilers\.\n\nExperience:\n- Engineer, Acme/);
  assert.throws(() => li.adapter({ result: {} }), /no name and no about/);
  const spec = { status: 'spec', id: '00000000-0000-4000-8000-000000000009', nextStep: 'LinkedIn profile reader, $0.02', __text: 'Request: GET https://x402.orthogonal.com/scrapecreators/v1/linkedin/profile\nInputs: url' };
  const run = { status: 'fulfilled', supplier: 'x402.orthogonal.com', cost: ['provider price 0.02 USD'], result: JSON.stringify(profile) };
  reset({ tenjin: { status: 'ready' } });
  const spy = serve({});
  const f = fake({ answers: [spec, run] });
  const r = await rs.setFromLink({ url, state: store.loadState(), client: client(f), fetchImpl: spy });
  assert.equal(r.read, true);
  assert.match(r.resumeText, /Pat Example/);
  assert.equal(spy.calls.length, 0, 'linkedin.com is never fetched');
  assert.deepEqual(f.log().filter((l) => l.call).map((l) => Object.keys(l.call)[0]), ['query', 'id']);
  // a status other than fulfilled falls back to the export ask
  const g = fake({ answers: [spec, { status: 'failed', reason: 'down' }] });
  const bad = await rs.setFromLink({ url, state: store.loadState(), client: client(g), fetchImpl: spy });
  assert.equal(bad.read, false);
  assert.match(bad.ask, /PDF export/);
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

test('the web search mapper: the board hosts as includeDomains, the role and place in a short query, the window as a start date; the adapter reads the shape', () => {
  const m = ws.mapper({ role: 'software engineer', place: 'Berlin', remote: true, since: '2026-11-10' });
  assert.deepEqual(m, { q: 'software engineer Berlin remote', count: 20, includeDomains: 'jobs.ashbyhq.com,boards.greenhouse.io,job-boards.greenhouse.io,jobs.lever.co', startPublishedDate: '2026-11-10T00:00:00.000Z' });
  assert.ok(ws.mapper({ role: 'x'.repeat(900), place: '' }).q.length <= 400);
  assert.equal(ws.RECORDED, false);
  const item = (o) => ({ title: 'Software Engineer', ...o });
  const a = ws.adapter({ results: [item({ url: 'https://job-boards.greenhouse.io/acme/jobs/1', snippet: 's', publishedDate: '2026-11-20' }), item({ url: 'https://www.linkedin.com/jobs/view/1' })] });
  assert.deepEqual(a.results.map((r) => r.url), ['https://job-boards.greenhouse.io/acme/jobs/1'], 'only a board job link is kept');
  const b = ws.adapter({ data: { results: [{ link: 'https://jobs.lever.co/acme/abc', description: 'd' }] } });
  assert.equal(b.results.length, 1, 'another API\'s shape reads the same');
  assert.throws(() => ws.adapter({ nope: 1 }), /no results list/);
  assert.equal(sup.pickSupplier('GET https://agent-data-tools.revmesh2074.workers.dev/search/web', 'web_search').noCache, true);
});

test('the web search result is never saved: the router run keeps no results file', async () => {
  reset();
  const spec = { status: 'spec', id: '00000000-0000-4000-8000-000000000010', nextStep: 'web search $0.01', __text: 'Request: GET https://agent-data-tools.revmesh2074.workers.dev/search/web' };
  const run = { status: 'fulfilled', supplier: 'agent-data-tools.revmesh2074.workers.dev', cost: ['provider price 0.01 USD'], result: JSON.stringify({ results: [{ url: 'https://job-boards.greenhouse.io/acme/jobs/1', title: 'SE', snippet: 's' }] }) };
  const f = fake({ answers: [spec, run] });
  const before = fs.existsSync(path.join(stateDir(), 'results')) ? fs.readdirSync(path.join(stateDir(), 'results')).length : 0;
  const [r] = await router.runRound([{ kind: 'web_search', text: 'web search API for a script', fields: { role: 'se', place: 'Berlin', since: '2026-11-10' }, query: { role: 'se', place: 'Berlin', remote: false, since: '2026-11-10' } }], { client: client(f) });
  assert.equal(r.ok, true);
  assert.equal(r.ingest.fullResultPath, null);
  assert.equal(r.ingest.results.length, 1);
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
