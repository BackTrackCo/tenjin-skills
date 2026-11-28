import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, ROOT, runJobs } from './helpers/env.mjs';
import { tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib';
const store = await import(`${S}/store.mjs`);
const net = await import(`${S}/net.mjs`);
const yc = await import(`${S}/yc.mjs`);
const plat = await import(`${S}/platforms.mjs`);
const report = await import(`${S}/report.mjs`);
const work = await import(`${S}/work.mjs`);
const { graph } = await import(`${S}/graph.mjs`);

const rd = (f) => fs.readFileSync(path.join(FIX, 'yc', f), 'utf8');
const ROLE = rd('role-software-engineer.html');
const COMPANY_FX = rd('company-placeholder.html');
// The recorded shape with a placeholder company, filled with the company the test asks about.
const companyPage = (name, site) => COMPANY_FX.replaceAll('Example Co', name).replaceAll('https://www.example-co.test', site);
const SITES = { '/companies/karat-financial': ['Karat Financial', 'https://www.karat-financial.test'], '/companies/medplum': ['Medplum', 'https://www.medplum.test'], '/companies/wasmer': ['Wasmer', 'https://www.wasmer.test'], '/companies/bountiful': ['Bountiful', 'https://www.bountiful.test'] };
const ROBOTS = rd('robots.txt');
const O = 'https://www.ycombinator.com';
const NOW = Date.parse('2026-11-25T12:00:00Z');
const profile = { search: { role: 'software engineer', place: 'San Francisco, CA' }, remote: true };
const reset = () => store.updateState((s) => { Object.assign(s, store.emptyState()); });
const page = (text, status = 200) => ({ ok: status < 400, status, text: async () => text, json: async () => ({}) });
const GHMED = { jobs: [{ id: 5, title: 'Software Engineer', company_name: 'Medplum', location: { name: 'San Francisco, California' }, first_published: '2026-11-20T00:00:00Z', content: '' }] };

// A fetch that answers the YC pages and the board APIs, and records every call with its options.
function ycFetch(over = {}) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.startsWith(O)) {
      const p = new URL(url).pathname;
      if (over[p] !== undefined) return typeof over[p] === 'number' ? page('', over[p]) : page(over[p]);
      if (p.startsWith('/jobs/role/')) return page(ROLE);
      if (SITES[p]) return page(companyPage(...SITES[p]));
      return page('', 404);
    }
    if (url.startsWith('https://boards-api.greenhouse.io/v1/boards/medplum/')) return { ok: true, status: 200, json: async () => GHMED, text: async () => '' };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  f.calls = calls;
  f.yc = () => calls.filter((c) => c.url.startsWith(O));
  return f;
}
const paced = () => { const s = []; const fn = async (ms) => { s.push(ms); }; fn.log = s; return fn; };

test('only the four public paths are fetched, logged out; every other YC path and host is refused', async () => {
  for (const ok of [`${O}/jobs/role/software-engineer`, `${O}/jobs/role/software-engineer/san-francisco`, `${O}/companies/medplum`, `${O}/companies/medplum/jobs/nAbajSt-software-engineer`]) assert.doesNotThrow(() => net.assertAllowed(ok, { yc: true }), ok);
  for (const bad of [`${O}/robots.txt`, `${O}/companies?batch=W20`, `${O}/jobs`, `${O}/library?x=1`, `${O}/verify/abc`, `${O}/companies/medplum/people`, `${O}/jobs/role/a/b/c`, `${O}/jobs/role/software-engineer?x=1`, 'https://www.workatastartup.com/jobs/1', 'https://account.ycombinator.com/authenticate', 'https://news.ycombinator.com/item?id=1', 'http://www.ycombinator.com/jobs/role/designer', 'https://ycombinator.com/jobs/role/designer']) assert.throws(() => net.assertAllowed(bad, { yc: true }), /not a readable Y Combinator page/, bad);
  // without the narrow option every YC host stays refused
  for (const u of [`${O}/jobs/role/software-engineer`, 'https://www.workatastartup.com/jobs/1', 'https://account.ycombinator.com/x']) await assert.rejects(net.guardedFetch(u, {}, async () => page('')), /never-automated host refused/);
  const f = ycFetch();
  await net.guardedFetch(`${O}/jobs/role/software-engineer`, { headers: { cookie: 'a=b' } }, f, { yc: true });
  const o = f.calls[0].opts;
  assert.equal(o.redirect, 'manual');
  assert.equal(o.credentials, 'omit');
  assert.equal(Object.keys(o.headers).some((k) => /cookie|authorization/i.test(k)), false, 'no cookies');
});

test('the recorded role page parses from data-page; a page that changed shape does not', () => {
  const l = yc.parseListing(ROLE);
  assert.deepEqual(l.postings.map((p) => [p.company, p.companyUrl]), [['Karat Financial', '/companies/karat-financial'], ['Medplum', '/companies/medplum'], ['Wasmer', '/companies/wasmer'], ['Bountiful', '/companies/bountiful']]);
  assert.ok(l.places.some((p) => p.slug === 'san-francisco' && p.name === 'San Francisco'));
  assert.ok(l.places.some((p) => p.slug === 'remote'));
  assert.equal(yc.parseListing('<html>no data</html>'), null);
  assert.equal(yc.parseListing(ROLE.replace('WaasJobListingsPage&quot;, &quot;props', 'Other&quot;, &quot;props')), null);
  assert.equal(yc.parseListing(ROLE.replaceAll('&quot;jobPostings&quot;', '&quot;postings&quot;')), null);
  const med = companyPage('Medplum', 'https://www.medplum.com');
  assert.equal(yc.companyWebsite(med, 'Medplum'), 'https://www.medplum.com');
  assert.equal(yc.companyWebsite(med, 'Someone Else'), null, 'the page must be the company asked for');
  assert.equal(yc.companyWebsite('<div></div>', 'Medplum'), null);
  assert.equal(yc.companyWebsite(med.replace('&quot;website&quot;', '&quot;site&quot;'), 'Medplum'), null, 'no props.company.website: no website');
  assert.equal(yc.companyWebsite(med.replace('https://www.medplum.com', 'https://www.ycombinator.com/x'), 'Medplum'), null);
  // only props.company.website is read: another website key elsewhere and any founders are ignored
  const decoy = JSON.stringify({ component: 'ycdc_new/pages/Companies/ShowPage', props: { website: 'https://decoy.test', company: { name: 'Medplum', founders: [{ name: 'Pat Example', website: 'https://pat.test' }] } } });
  const withFounder = `<div data-page="${decoy.replaceAll('"', '&quot;')}"></div>`;
  assert.equal(yc.companyWebsite(withFounder, 'Medplum'), null);
  const src = fs.readFileSync(path.join(ROOT, 'skills', 'job-search', 'scripts', 'lib', 'yc.mjs'), 'utf8');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /founders|linkedin_url|twitter_url|github_url/, 'no person\'s data is read or stored');
  assert.doesNotMatch(ROLE, /hiringManager&quot;: &quot;/, 'no hiring manager name is recorded');
});

test('the role and the place map to YC slugs in code; no fit reads nothing', () => {
  assert.equal(yc.ycRoleSlug({ search: { role: 'Senior Software Engineer' } }), 'software-engineer');
  assert.equal(yc.ycRoleSlug({ search: { role: 'Product Designer' } }), 'designer');
  assert.equal(yc.ycRoleSlug({ search: { role: 'Account Executive' } }), 'sales-manager');
  assert.equal(yc.ycRoleSlug({ search: { role: 'Pastry chef' } }), null);
  const places = yc.parseListing(ROLE).places;
  assert.equal(yc.placeSlug(places, { search: { place: 'San Francisco, CA' } }), 'san-francisco');
  assert.equal(yc.placeSlug(places, { search: { place: 'Berlin' } }), null, 'no slug: the role page, filtered by the posting text');
  assert.equal(yc.keepPlace('Remote', { search: { place: 'Berlin' }, remote: true }), true);
  assert.equal(yc.keepPlace('New York City', { search: { place: 'Berlin' }, remote: true }), false);
  assert.equal(yc.keepPlace('Berlin, Germany', { search: { place: 'Berlin' }, remote: false }), true);
});

// robots.txt is never fetched at run time. The curated paths were checked against the recorded copy, and this test keeps it so:
// a path added to the list must be allowed by YC's recorded rules (the longest matching rule wins, Allow on a tie).
const parseRobots = (text) => {
  const rules = [];
  let star = false;
  let inGroup = false;
  for (const raw of text.split('\n')) {
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(raw.replace(/#.*/, '').trim());
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (k === 'user-agent') { if (!inGroup) star = false; if (m[2].trim() === '*') star = true; inGroup = true; } else {
      inGroup = false;
      if (star && (k === 'allow' || k === 'disallow') && m[2].trim()) rules.push({ allow: k === 'allow', pattern: m[2].trim() });
    }
  }
  return rules;
};
const robotsAllows = (rules, p) => {
  let best = null;
  for (const r of rules) {
    const re = new RegExp(`^${r.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);
    if (re.test(p) && (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow))) best = r;
  }
  return !best || best.allow;
};
test('every curated path pattern, with sample values, is allowed by the recorded robots.txt; the skill never fetches robots.txt', async () => {
  const rules = parseRobots(ROBOTS);
  assert.ok(rules.length >= 5, 'the recorded rules parse');
  const samples = ['/jobs/role/software-engineer', '/jobs/role/software-engineer/san-francisco', '/jobs/role/recruiting-hr/new-york', '/companies/medplum', '/companies/karat-financial', '/companies/medplum/jobs/nAbajSt-software-engineer'];
  assert.equal(net.YC_PATHS.length, 3, 'the curated list is three patterns: role, company, job');
  for (const re of net.YC_PATHS) assert.ok(samples.some((p) => re.test(p)), `a sample for ${re}`);
  for (const p of samples) { assert.ok(net.YC_PATHS.some((re) => re.test(p)), `${p} is curated`); assert.equal(robotsAllows(rules, p), true, `${p} is allowed by robots.txt`); }
  // the recorded rules do disallow other paths, so the check can fail
  for (const p of ['/verify/x', '/companies?batch=W20', '/library?x=1']) assert.equal(robotsAllows(rules, p), false, p);
  const f = ycFetch();
  reset();
  await yc.runYc({ fetch: f, profile, sleep: paced(), now: NOW });
  assert.equal(f.calls.some((c) => c.url.includes('robots')), false, 'no robots.txt request at run time');
  const src = fs.readFileSync(path.join(ROOT, 'skills', 'job-search', 'scripts', 'lib', 'yc.mjs'), 'utf8');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /robots/i);
});

test('one request at a time at the fixed pace; jobs go through the employer-posting steps', async () => {
  reset();
  const f = ycFetch();
  const sleep = paced();
  let inFlight = 0;
  let maxFlight = 0;
  const wrapped = async (u, o) => { if (u.startsWith(O)) { inFlight++; maxFlight = Math.max(maxFlight, inFlight); } try { return await f(u, o); } finally { if (u.startsWith(O)) inFlight--; } };
  const r = await yc.runYc({ fetch: wrapped, profile, sleep, now: NOW });
  const paths = f.yc().map((c) => new URL(c.url).pathname);
  assert.deepEqual(paths, ['/jobs/role/software-engineer', '/jobs/role/software-engineer/san-francisco', '/companies/karat-financial', '/companies/medplum', '/companies/wasmer', '/companies/bountiful']);
  assert.equal(maxFlight, 1, 'one at a time');
  assert.equal(yc.ycPaceMs(), 5000);
  assert.equal(graph().ycRead.paceMs, 5000);
  assert.deepEqual(sleep.log, Array(paths.length - 1).fill(5000), 'the pace sits between every two YC requests');
  assert.equal(r.fetched, 4);
  const jobs = Object.values(store.loadState().jobs);
  assert.equal(jobs.length >= 3, true);
  const med = jobs.find((j) => j.company === 'Medplum');
  assert.ok(med.employerPosting && ['exact', 'confirmed'].includes(med.employerPosting.confidence), 'the employer board is found from the company name and website');
  const kar = jobs.find((j) => j.company === 'Karat Financial');
  assert.equal(kar.unresolved, 'yc_platform_only');
  assert.match(kar.workAtStartupUrl, /^https:\/\/www\.ycombinator\.com\/companies\/karat-financial\/jobs\//);
  assert.match(report.renderReport(store.loadState(), { rules: [], lessons: [] }, { now: NOW }), /Karat Financial: a Y Combinator job with no employer posting found; apply at its Y Combinator link\. https:\/\/www\.ycombinator\.com\/companies\/karat-financial\/jobs\//);
  assert.equal(store.loadState().routed.lastSearchAt, null, 'a YC read is not a routed search round');
  // the same page again: nothing is fetched twice
  const again = await yc.runYc({ fetch: ycFetch(), profile, sleep: paced(), now: NOW });
  assert.equal(again.fetched, 0);
});

test('a page that fails or changed shape is skipped with one line and not retried', async () => {
  reset();
  const f = ycFetch({ '/jobs/role/software-engineer': '<html>changed</html>' });
  const r = await yc.runYc({ fetch: f, profile, sleep: paced(), now: NOW });
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /^yc: \/jobs\/role\/software-engineer skipped \(the page changed shape\)/);
  assert.equal(f.yc().filter((c) => c.url.endsWith('/jobs/role/software-engineer')).length, 1, 'not retried');
  assert.ok(store.loadState().held.some((h) => h.detail === r.lines[0]));
  // a failing company page: its jobs are still read, without the website, and the page is not asked again
  reset();
  const g = ycFetch({ '/companies/wasmer': 500 });
  const r2 = await yc.runYc({ fetch: g, profile, sleep: paced(), now: NOW });
  assert.ok(r2.lines.some((l) => /^yc: \/companies\/wasmer skipped \(http 500\)/.test(l)));
  assert.equal(g.yc().filter((c) => c.url.endsWith('/companies/wasmer')).length, 1);
  assert.equal(Object.values(store.loadState().jobs).some((j) => j.company === 'Wasmer'), true);
});

test('the time budget leaves the rest for the next run', async () => {
  reset();
  let t = 0;
  const clock = () => t;
  const sleep = async (ms) => { t += ms; };
  const r = await yc.runYc({ fetch: ycFetch(), profile, sleep, clock, budgetMs: 12_000, now: NOW });
  assert.ok(r.remaining > 0 && r.fetched > 0);
  assert.ok(store.loadState().yc.remaining > 0);
  assert.equal(yc.ycDue(store.loadState(), profile, NOW + 1000), true, 'still due while reading');
});

test('no relative date is used: postings carry no date and the code never reads the page dates', () => {
  const l = yc.parseListing(ROLE);
  for (const j of l.postings) assert.equal(yc.toPosting(j, null).postedAt, null);
  const src = fs.readFileSync(path.join(ROOT, 'skills', 'job-search', 'scripts', 'lib', 'yc.mjs'), 'utf8');
  assert.doesNotMatch(src, /createdAt|lastActive/);
});

test('the browser never opens a YC host: the deny list keeps them, and no fill or open goes there', () => {
  for (const u of [`${O}/companies/medplum/jobs/x`, `${O}/jobs/role/software-engineer`, 'https://www.workatastartup.com/jobs/1', 'https://account.ycombinator.com/authenticate']) assert.equal(plat.isNeverAutomated(u), true, u);
  assert.ok(graph().neverHosts.includes('ycombinator.com') && graph().neverHosts.includes('workatastartup.com'));
  const src = fs.readFileSync(path.join(ROOT, 'skills', 'job-search', 'scripts', 'lib', 'net.mjs'), 'utf8');
  assert.doesNotMatch(src, /workatastartup|account\.ycombinator/);
});

test('J yc runs through the CLI with no network in a test home: no role page fits means nothing is read', () => {
  runJobs(home, ['profile', 'set', JSON.stringify({ search: { role: 'pastry chef', place: 'Berlin' } })]);
  const r = runJobs(home, ['yc']);
  assert.equal(r.code, 0);
  assert.equal(r.json.requests, 0);
});
