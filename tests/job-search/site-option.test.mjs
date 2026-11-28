import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib';
const store = await import(`${S}/store.mjs`);
const work = await import(`${S}/work.mjs`);
const ap = await import(`${S}/apply.mjs`);
const qs = await import(`${S}/questions.mjs`);
const open = await import(`${S}/open.mjs`);
const plat = await import(`${S}/platforms.mjs`);

const reset = (jobs = []) => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; });
};
// The open command is a script that logs the URL it was given: no test opens a real browser.
const fakeOpen = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-open-'));
  const log = path.join(dir, 'log');
  const bin = path.join(dir, 'open');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$1" >> "${log}"\n`, { mode: 0o755 });
  return { bin, urls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
};
const IN = 'https://www.indeed.com/viewjob?jk=abc';
const LI = 'https://www.linkedin.com/jobs/view/12345';
const YC = 'https://www.ycombinator.com/companies/acme/jobs/xyz-engineer';
const siteJob = (i, over = {}) => mkJob({ key: `https://boards.greenhouse.io/acme/jobs/${i}`, status: 'apply_ready', fit: 88, company: `Co${i}`, siteLinks: [{ site: 'Indeed', url: IN }, { site: 'LinkedIn', url: LI }, { site: 'Y Combinator', url: YC }], verifiedAt: new Date().toISOString(), sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [{ label: 'Email', value: 'a@b.test', tag: 'fact', required: true }] }, ...over });
const site = () => runJobs(home, ['profile', 'set', JSON.stringify({ apply: { where: 'site', source: 'person' } })]);

test('the start question keeps three options; the job-site option names LinkedIn, Indeed and YC and says nothing is done there; no per-site question', () => {
  const where = qs.startQuestions({}).questions.find((x) => x.header === 'Where');
  assert.deepEqual(where.options.map((o) => o.label), ['Employer\'s site (Recommended)', 'A job site, I apply', 'Ask me each job']);
  const d = where.options[1].description;
  assert.match(d, /LinkedIn, Indeed, YC or another job site/);
  assert.match(d, /open the job's page there in your browser and give you the answers; you apply there\. I do nothing on that site\./);
  assert.doesNotMatch(JSON.stringify(where), /never open|I never open/i);
  assert.match(where.options[2].description, /on a job site and on an employer site/);
  assert.equal(qs.startQuestions({}).questions.length, 4, 'no extra question per site');
});

test('J site show opens the first site\'s page with J open, no question, prints the answers and lists the other links', () => {
  const f = fakeOpen();
  process.env.JOB_SEARCH_OPEN_BIN = f.bin;
  try {
    const j = siteJob(61);
    reset([j]);
    site();
    const item = work.workList({ now: Date.now() }).items.find((i) => i.key === j.key);
    assert.equal(item.reason, 'site_ready');
    const r = runJobs(home, ['site', 'show', j.key]);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(f.urls(), [IN], 'the page of the site the job was found on first, and only that one');
    assert.equal(r.json.opened, true);
    assert.equal(r.json.site, 'Indeed');
    assert.equal(r.json.link, IN, 'the link is in the reply');
    assert.deepEqual(r.json.otherLinks, [{ site: 'LinkedIn', url: LI }, { site: 'Y Combinator', url: YC }], 'at most one per site');
    assert.deepEqual(r.json.answers.map((a) => a.label), ['Email']);
    assert.equal(r.json.question, undefined, 'no question');
    assert.ok(store.loadState().jobs[j.key].openedAt);
    assert.equal(work.workList({ now: Date.now() }).items.find((i) => i.key === j.key).reason, 'site_applied', 'asked once after the page was opened');
    assert.equal(runJobs(home, ['linkedin', 'show', j.key]).code, 2, 'no alias for the old name');
  } finally { delete process.env.JOB_SEARCH_OPEN_BIN; }
});

test('a turn the watcher wakes opens nothing: the job holds as open_ready and the link is still in the reply', () => {
  const f = fakeOpen();
  process.env.JOB_SEARCH_OPEN_BIN = f.bin;
  try {
    const j = siteJob(62);
    reset([j]);
    site();
    runJobs(home, ['batch', 'open', '--unattended']);
    const r = runJobs(home, ['site', 'show', j.key]);
    runJobs(home, ['batch', 'close']);
    assert.equal(r.json.held, 'open_ready');
    assert.equal(r.json.opened, false);
    assert.equal(r.json.link, IN);
    assert.deepEqual(f.urls(), []);
    assert.equal(store.loadState().jobs[j.key].siteShownAt, undefined, 'not marked shown: the next attended turn opens it');
    assert.equal(work.workList({ now: Date.now() }).items.find((i) => i.key === j.key).waitsForPerson, true);
    // the next attended turn opens it
    assert.equal(runJobs(home, ['site', 'show', j.key]).json.opened, true);
    assert.deepEqual(f.urls(), [IN]);
  } finally { delete process.env.JOB_SEARCH_OPEN_BIN; }
});

test('nothing is read, fetched, filled or clicked on the opened page: the command only runs J open', () => {
  const src = fs.readFileSync(path.join(ROOT, 'skills', 'job-search', 'scripts', 'jobs.mjs'), 'utf8');
  const body = src.slice(src.indexOf('  async site(['), src.indexOf("  // The last check right before the submit click"));
  assert.match(body, /openPage\(first\.url\)/);
  assert.doesNotMatch(body, /fetch|navigate|click|read_page|mcp__|claude-in-chrome/i);
  assert.equal(ap.jobFailure({ job: siteJob(63), state: store.loadState(), profile: { apply: { where: 'site', source: 'person' } }, overlay: { rules: [] }, mode: 'attended', now: Date.now() }), 'site_path', 'apply next never hands the job out');
});

test('the approval variant and "Did you apply ...?" name the actual site; "Ask me each job" covers any job site', () => {
  const j = siteJob(64);
  const q = qs.approvalQuestions(j, 'ask').questions[0];
  assert.deepEqual(q.options.map((o) => o.label), ['Employer\'s site (I apply)', 'Fill it, I submit', 'Indeed (you apply)', 'Skip this job']);
  assert.match(q.options[2].description, /I open the job's page on Indeed in your browser and give you the answers; you apply there\. I do nothing on that site\./);
  const yc = siteJob(65, { siteLinks: [{ site: 'Y Combinator', url: YC }] });
  assert.equal(qs.approvalQuestions(yc, 'ask').questions[0].options[2].label, 'Y Combinator (you apply)');
  assert.match(qs.appliedQuestion(j).questions[0].question, /on Indeed\?$/);
  assert.match(qs.appliedQuestion(yc).questions[0].question, /on Y Combinator\?$/);
  assert.equal(ap.applyPathOf(siteJob(66), { apply: { where: 'ask', source: 'person' } }), 'ask');
  assert.equal(ap.applyPathOf(siteJob(67, { employerPosting: null }), { apply: { where: 'ask', source: 'person' } }), 'site');
  assert.equal(ap.applyPathOf(mkJob({ status: 'apply_ready' }), { apply: { where: 'site', source: 'person' } }), 'employer', 'no job-site link: the employer\'s site');
});

test('one link per job site, the first site leading; only pages a job can be applied to count', () => {
  assert.deepEqual(plat.siteLinksOf([IN, 'https://de.indeed.com/viewjob?jk=2', LI, YC, 'https://www.wellfound.com/jobs/1', 'https://acme.test/careers']).map((x) => x.site), ['Indeed', 'LinkedIn', 'Y Combinator', 'Wellfound']);
  assert.equal(plat.jobSiteOf('https://www.ycombinator.com/companies/acme'), null, 'a company page is not a job page');
  assert.equal(plat.jobSiteOf('https://news.ycombinator.com/item?id=1'), null);
  assert.equal(plat.jobSiteOf('http://www.linkedin.com/jobs/view/1'), null, 'https only');
});

test('every J open names Google Chrome as the app, never the extension; Chrome missing falls back to the default browser with one plain line', () => {
  const calls = [];
  const spawn = (fail) => (bin, args) => { calls.push([bin, ...args]); return { status: fail && calls.length === 1 ? 1 : 0 }; };
  assert.deepEqual(open.chromeCommand(IN, 'darwin'), { bin: 'open', args: ['-a', 'Google Chrome', IN] });
  assert.deepEqual(open.chromeCommand(IN, 'linux'), { bin: 'google-chrome', args: [IN] });
  const ok = open.openPage(IN, { spawn: spawn(false), platform: 'darwin', env: {} });
  assert.deepEqual(ok, { ok: true, browser: 'chrome' });
  assert.deepEqual(calls, [['open', '-a', 'Google Chrome', IN]]);
  calls.length = 0;
  const fb = open.openPage(IN, { spawn: spawn(true), platform: 'darwin', env: {} });
  assert.equal(fb.ok, true);
  assert.equal(fb.browser, 'default');
  assert.equal(fb.line, 'Google Chrome did not open it, so the page opened in your default browser.');
  assert.deepEqual(calls, [['open', '-a', 'Google Chrome', IN], ['open', IN]]);
  assert.equal(open.openPage(IN, { spawn: () => ({ status: 1 }), platform: 'linux', env: {} }).ok, false);
  assert.equal(open.openPage('http://acme.test/x', { spawn: spawn(false), platform: 'darwin', env: {} }).ok, false, 'https only still holds');
  assert.equal(open.openPage('https://127.0.0.1/x', { spawn: spawn(false), platform: 'darwin', env: {} }).ok, false, 'local addresses still refused');
  const src = fs.readFileSync(path.join(ROOT, 'skills', 'job-search', 'scripts', 'lib', 'open.mjs'), 'utf8');
  assert.doesNotMatch(src, /claude-in-chrome|mcp__/);
});

test('on Windows no shell is started: Chrome is spawned directly from its install paths, the link is one argument, and the fallback line shows when Chrome is not found', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LocalAppData: 'C:\\Users\\p\\AppData\\Local' };
  const tail = 'Google\\Chrome\\Application\\chrome.exe';
  const all = [`C:\\Program Files\\${tail}`, `C:\\Program Files (x86)\\${tail}`, `C:\\Users\\p\\AppData\\Local\\${tail}`];
  const risky = 'https://example.com/apply?a=1&b=2|c^d%20e';
  assert.equal(open.checkOpenUrl(risky), null);
  // the order: Program Files, then Program Files (x86), then LocalAppData; the first that exists
  for (const [have, want] of [[all, all[0]], [all.slice(1), all[1]], [all.slice(2), all[2]]]) assert.equal(open.chromeCommand(risky, 'win32', { env, exists: (p) => have.includes(p) }).bin, want);
  assert.equal(open.chromeCommand(risky, 'win32', { env, exists: () => false }), null);
  const calls = [];
  const spawn = (bin, args, o) => { calls.push({ bin, args, o }); return { status: 0 }; };
  assert.deepEqual(open.openPage(risky, { spawn, platform: 'win32', env, exists: (p) => p === all[1] }), { ok: true, browser: 'chrome' });
  assert.deepEqual(calls.map((c) => [c.bin, c.args]), [[all[1], [risky]]], 'the link reaches spawn as exactly one argument, unchanged');
  calls.length = 0;
  const fb = open.openPage(risky, { spawn, platform: 'win32', env, exists: () => false });
  assert.equal(fb.browser, 'default');
  assert.equal(fb.line, open.FALLBACK_LINE);
  assert.deepEqual(calls.map((c) => [c.bin, c.args]), [['rundll32.exe', ['url.dll,FileProtocolHandler', risky]]]);
  for (const c of calls) {
    assert.doesNotMatch(c.bin, /cmd|powershell|pwsh/i);
    assert.equal(c.args.some((a) => /^\/c$|^-command$/i.test(a)), false);
    assert.ok(!c.o.shell, 'no shell option');
  }
  // defense in depth: a quote or a control character is refused
  for (const bad of ['https://example.com/a"b', 'https://example.com/a\u0001b', 'https://example.com/a\nb']) assert.ok(open.checkOpenUrl(bad), JSON.stringify(bad));
  const src = fs.readFileSync(path.join(ROOT, 'skills', 'job-search', 'scripts', 'lib', 'open.mjs'), 'utf8');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /cmd|powershell|shell\s*:\s*true/i);
});

test('an old linkedin value is refused with an error naming the field; old job fields in state are refused too', () => {
  reset();
  fs.writeFileSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), JSON.stringify({ apply: { where: 'linkedin', source: 'person' } }));
  const r = runJobs(home, ['report']);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /apply\.where \(the "linkedin" value is now "site"/);
  assert.equal(runJobs(home, ['profile', 'set', JSON.stringify({ apply: { where: 'site', source: 'person' } })]).code, 0, 'J profile still runs, to fix it');
  assert.equal(runJobs(home, ['start', 'record', '--where', 'linkedin']).code, 2);
  const j = siteJob(68);
  reset([{ ...j, linkedinUrl: LI }]);
  const o = runJobs(home, ['report']);
  assert.equal(o.code, 2);
  assert.match(o.json.error, /jobs\.\*\.linkedinUrl \(now siteLinks/);
});
