import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeFetch, fixture, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const router = await import(`${S}router.mjs`);
const routed = await import(`${S}routed.mjs`);
const company = await import(`${S}company.mjs`);
const report = await import(`${S}report.mjs`);
const qs = await import(`${S}questions.mjs`);
const work = await import(`${S}work.mjs`);
const people = await import(`${S}suppliers/people.mjs`);
const cl = await import(`${S}suppliers/company.mjs`);

const FAKE = path.join(import.meta.dirname, 'helpers', 'fake-tenjin.mjs');
const FX = { company: fixture('router/company-lookup.json'), people: fixture('router/people-search.json') };
const empty = { rules: [], lessons: [] };
const NOW = Date.parse('2026-11-25T12:00:00Z');
function fake(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faketenjin-'));
  const sf = path.join(dir, 'script.json');
  const lf = path.join(dir, 'log.jsonl');
  fs.writeFileSync(sf, JSON.stringify(script));
  const bin = path.join(dir, 'tenjin');
  fs.writeFileSync(bin, `#!/bin/sh\nFAKE_SCRIPT="${sf}" FAKE_LOG="${lf}" exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  return { bin, log: () => (fs.existsSync(lf) ? fs.readFileSync(lf, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}
const client = (f) => new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300 } });
const spec = (x) => ({ ...x.step1.json, __text: x.step1.text });
const run = (env, result) => ({ ...env, result: JSON.stringify(result || env.result) });
const reset = () => store.updateState((s) => { Object.assign(s, store.emptyState()); });
const job = (n, over = {}) => ({ key: `https://job-boards.greenhouse.io/acme/jobs/${n}`, url: `https://job-boards.greenhouse.io/acme/jobs/${n}`, title: 'Engineer', company: 'Acme Robotics', city: 'New York', status: 'reviewed', hash: `h${n}`, warnings: [], v: 1, ...over });
const add = (...jobs) => store.updateState((s) => { for (const j of jobs) s.jobs[j.key] = j; s.contactsRequested = jobs.map((j) => j.key); });
const ppl = (extra) => ({ ...FX.people.step2.envelope, result: JSON.stringify({ success: true, total: 3, leads: extra }) });
const lead = (n, c, over = {}) => ({ firstname: `P${n}`, lastname: 'X', headline: 'Eng lead', profileUrl: `https://www.linkedin.com/in/p${n}`, lastJobTitle: 'Engineering Manager', lastCompanyName: c, address: 'New York, NY', ...over });

test('a job with no employer website is no longer skipped, and every job not searched is named with its reason', () => {
  reset();
  const a = job(1); const b = job(2, { employerWebsite: 'acme.test' }); const c = job(3, { contactsSearched: '2026-11-24' });
  add(a, b, c);
  store.updateState((s) => { s.contacts[b.key] = [{ name: 'x' }]; });
  const skips = [];
  const needs = routed.jobNeeds(store.loadState(), {}, empty, { kinds: ['people_search'], skips });
  assert.deepEqual(needs.map((n) => n.jobKey), [a.key], 'the job with no website is searched');
  assert.equal(needs[0].fields.website, null);
  assert.deepEqual(skips.map((x) => [x.key, x.reason]), [[b.key, 'a contact is already recorded'], [c.key, 'already searched']]);
});

test('the website comes from what code has, with its source: record, posting, board_page', () => {
  assert.deepEqual(company.websiteOf({ companyUrl: 'https://acme.test' }), { url: 'https://acme.test', source: 'record' });
  assert.deepEqual(company.websiteOf({ employerWebsite: 'https://acme.test' }), { url: 'https://acme.test', source: 'posting' });
  assert.deepEqual(company.websiteOf({ employerWebsite: 'x.test', employerWebsiteSource: 'company_lookup' }), { url: 'x.test', source: 'company_lookup' });
  assert.deepEqual(company.websiteOf({ boardHomepage: 'https://acme.test' }), { url: 'https://acme.test', source: 'board_page' });
  assert.equal(company.websiteOf({}), null);
});

const BYNAME = fixture('router/people-search-by-name.json');
const lookup = (over = {}) => ({ ...FX.company.step2.envelope, result: JSON.stringify({ ...FX.company.step2.envelope.result, ...over }) });

test('with Tenjin: a free spec, the company lookup run, the domain trusted on a name match and saved with its source, then the people search by domain', async () => {
  reset();
  add(job(11, { company: 'Vercel' }));
  const f = fake({ answers: [spec(FX.company), run(FX.company.step2.envelope), spec(FX.people), run(FX.people.step2.envelope)] });
  const log = await routed.routeContacts({ keys: null, profile: {}, fetch: fakeFetch({}), client: client(f), now: NOW });
  const j = store.loadState().jobs[job(11).key];
  assert.deepEqual([j.employerWebsite, j.employerWebsiteSource], ['vercel.com', 'company_lookup'], 'the bare domain, not the full URL');
  assert.equal(j.companyLinkedinUrl, 'https://www.linkedin.com/company/vercel', 'the company page is kept for a later match');
  assert.equal(j.city, 'New York', 'the registered address is never read as the job\'s city');
  const calls = f.log().filter((l) => l.call).map((l) => l.call);
  assert.deepEqual(calls[0], { tool: 'companyenrich-properties' }, 'the first call is the free spec, by catalog tool id');
  assert.equal(calls[1].id, FX.company.step1.json.id);
  assert.deepEqual(calls[1].input, { name: 'Vercel' }, 'only the name: the board link and the city are code context');
  assert.deepEqual(calls[3].input.query.currentCompanyWebsite, { include: ['vercel.com'] }, 'the people search then filters by the domain');
  assert.equal(log.find((l) => l.status === 'company_lookup').website, 'vercel.com');
  assert.equal(log.at(-1).searchedBy, 'website');
});

test('the lookup answer is one company object: the domain is trusted only when its name or legal name matches the job\'s company', async () => {
  const ing = await import(`${S}ingest.mjs`);
  const run1 = async (jobOver, answer) => {
    reset();
    const j = job(40, jobOver);
    add(j);
    const obj = { need: 'company_lookup', status: 'fulfilled', ...cl.adapter(answer, { jobKey: j.key }) };
    await ing.ingest({ obj, state: store.loadState(), profile: {}, overlay: empty, fetch: fakeFetch({}), now: NOW });
    return store.loadState().jobs[j.key];
  };
  const real = FX.company.step2.envelope.result;
  assert.deepEqual(cl.adapter(real, { jobKey: 'k' }), { jobKey: 'k', name: 'Vercel', legalName: 'Vercel Inc', domain: 'vercel.com', linkedinUrl: 'https://www.linkedin.com/company/vercel' });
  assert.equal((await run1({ company: 'Vercel' }, real)).employerWebsite, 'vercel.com');
  assert.equal((await run1({ company: 'Vercel, Inc.' }, real)).employerWebsite, 'vercel.com', 'the legal name counts');
  assert.equal((await run1({ company: 'Acme Robotics' }, real)).employerWebsite, undefined, 'a different company: the domain is not trusted');
  assert.equal((await run1({ company: 'Acme Robotics', boardCompany: 'Vercel' }, real)).employerWebsite, 'vercel.com', 'the board\'s company name counts');
  assert.equal((await run1({ company: 'Vercel' }, { ...real, name: 'Zeta Labs', legalName: null })).employerWebsite, undefined);
  assert.equal(cl.adapter({ ...real, domain: 'https://www.Vercel.com/x' }, { jobKey: 'k' }).domain, 'vercel.com');
  assert.throws(() => cl.adapter([real], { jobKey: 'k' }), /one company object/);
});

test('a lookup that does not match the company is not saved; the people search runs by name and city and says how many it found and how many were outside the city', async () => {
  reset();
  add(job(12, { company: 'Vercel' }));
  const f = fake({ answers: [spec(FX.company), lookup({ name: 'Zeta Labs', legalName: 'Zeta Labs LLC' }), spec(FX.people), { ...BYNAME.step2.envelope, result: JSON.stringify(BYNAME.step2.envelope.result) }] });
  const log = await routed.routeContacts({ keys: null, profile: {}, fetch: fakeFetch({}), client: client(f), now: NOW });
  const st = store.loadState();
  assert.equal(st.jobs[job(12).key].employerWebsite, undefined, 'no domain that fails the name check is saved');
  const calls = f.log().filter((l) => l.call).map((l) => l.call);
  assert.deepEqual(calls[3].input.query.currentCompanyName, { include: ['Vercel'] });
  assert.equal(calls[3].input.query.currentCompanyWebsite, undefined);
  assert.equal(log.at(-1).searchedBy, 'name and city');
  const got = st.contacts[job(12).key];
  assert.equal(got.length, 1, 'the Fort Lee lead is dropped for its place');
  assert.deepEqual(st.jobs[job(12).key].contactsStatus, { state: 'searched', found: 2, kept: 1, outside: 1, city: 'New York', at: st.jobs[job(12).key].contactsStatus.at });
  assert.match(report.renderReport(st, empty, { now: NOW, profile: {} }), /Engineer, Vercel: 2 found, 1 outside New York/);
});

test('the adapter reads the host of the company website, matches by name or the company\'s LinkedIn page, and marks weak leads', () => {
  const res = BYNAME.step2.envelope.result;
  const [a, b] = res.leads;
  // no city: both leads stay; A is a sales engineering title, B's headline names another company
  const byName = people.adapter(res, { jobKey: 'k', names: ['Vercel'] });
  assert.deepEqual(byName.contacts.map((c) => [c.name, c.weak]), [['Person A', true], ['Person B', true]]);
  assert.deepEqual([byName.found, byName.outside], [2, 0]);
  // title and headline checks one at a time
  const only = (lead) => people.adapter({ success: true, total: 1, leads: [lead] }, { jobKey: 'k', names: ['Vercel'] }).contacts[0];
  assert.equal(only({ ...b, headline: 'Director of Engineering at Vercel' }).weak, undefined, 'a clean lead is not weak');
  for (const t of ['Field CTO', 'Solutions Architect', 'Head of Sales', 'Account Executive']) assert.equal(only({ ...b, headline: 'x at Vercel', lastJobTitle: t }).weak, true, t);
  assert.equal(only({ ...b, headline: 'Director of Engineering at Netlify' }).weak, true, 'the headline names a different company than lastCompanyName');
  assert.equal(only({ ...b, headline: 'Engineering leader' }).weak, undefined, 'a headline with no company says nothing');
  // the company website is a full URL with a path: only its host is compared
  const withSite = people.adapter(res, { jobKey: 'k', website: 'vercel.com' });
  assert.equal(withSite.contacts.length, 2);
  assert.ok(withSite.contacts.every((c) => c.weak === true) === true, 'A (title) and B (headline) are weak for their own reasons');
  assert.equal(people.adapter({ success: true, total: 1, leads: [{ ...b, lastCompanyWebsite: 'https://other.example/contact/sales' }] }, { jobKey: 'k', website: 'vercel.com' }).contacts.length, 0, 'another host: another company, never recorded');
  // a lead is matched through the company's LinkedIn page when a lookup gave it, whatever the name says
  const li = people.adapter({ success: true, total: 1, leads: [{ ...b, lastCompanyName: 'Vercel Inc.', lastCompanyUrl: 'https://www.linkedin.com/company/vercel/' }] }, { jobKey: 'k', names: ['Somebody Else'], linkedinUrl: 'https://www.linkedin.com/company/vercel' });
  assert.equal(li.contacts.length, 1);
  assert.equal(li.contacts[0].weak, true, 'still weak for the headline');
  // the place filter keeps its drop and counts it
  const inNy = people.adapter(res, { jobKey: 'k', names: ['Vercel'], city: 'New York' });
  assert.deepEqual([inNy.contacts.map((c) => c.name), inNy.found, inNy.outside, inNy.city], [['Person B'], 2, 1, 'New York']);
});

test('a person from another company is never recorded when nothing confirms the company', () => {
  const res = { success: true, total: 2, leads: [lead(1, 'Acme Robotics'), lead(2, 'Other Co')] };
  assert.deepEqual(people.adapter(res, { jobKey: 'k', names: ['Acme Robotics'] }).contacts.map((c) => c.name), ['P1 X']);
  assert.ok(people.adapter(res, { jobKey: 'k' }).contacts.every((c) => c.weak === true), 'nothing to confirm a company by: weak');
  assert.throws(() => people.mapper({ titles: ['EM'] }), /no employer website or company name/);
});

test('J contacts route reports every job it did not search; the report says not searched: <reason>, and returned nothing only after a search ran', async () => {
  reset();
  const a = job(21); const b = job(22, { contactsSearched: '2026-11-24' });
  add(a, b);
  store.updateState((s) => { s.contacts[b.key] = [{ name: 'p', title: '', sourceUrl: 'u', how: 'h', cares: 'c' }]; });
  const f = fake({ answers: [spec(FX.company), run(FX.company.step2.envelope), spec(FX.people), run(FX.people.step2.envelope)] });
  const log = await routed.routeContacts({ keys: [a.key, b.key, 'nope'], profile: {}, fetch: fakeFetch({}), client: client(f), now: NOW });
  assert.deepEqual(log.filter((l) => l.status === 'not_searched').map((l) => [l.job, l.reason]), [[b.key, 'a contact is already recorded'], ['nope', 'unknown job']]);
  const text = report.renderReport(store.loadState(), empty, { now: NOW, profile: {} });
  assert.match(text, /Engineer, Acme Robotics: searched, returned nothing/);
  const st = store.loadState();
  assert.equal(st.jobs[b.key].contactsStatus.state, 'not_searched');
  assert.doesNotMatch(report.renderReport({ ...st, contacts: {} }, empty, { now: NOW, profile: {} }).split('## Contacts search')[1] || '', /Engineer, Acme Robotics: searched, returned nothing[\s\S]*Engineer, Acme Robotics: searched, returned nothing/);
  store.updateState((s) => { s.contactsRequested = [b.key]; s.contacts = {}; });
  assert.match(report.renderReport(store.loadState(), empty, { now: NOW, profile: {} }), /not searched: a contact is already recorded/);
});

test('J contacts route prints the reasons through the CLI', () => {
  reset();
  const b = job(31, { contactsSearched: '2026-11-24' });
  add(b);
  const r = runJobs(home, ['contacts', 'route']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.notSearched, [{ job: b.key, reason: 'already searched' }]);
  assert.notDeepEqual(r.json.routed, [], 'never the silent {"routed": []}');
});

test('the contacts question and the Tenjin ask cover the company lookup; no seller name appears', () => {
  const desc = JSON.stringify(qs.contactsCountQuestion());
  assert.match(desc, /company lookup \(about 1\.3¢\) for a job whose website is not known/);
  assert.match(work.tenjinOffer('contacts', { tenjin: { status: 'missing' } }), /about 2\.5¢ when the company's website must be looked up first/);
  const graph = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'graph.json'), 'utf8'));
  assert.equal(graph.needTemplates.company_lookup, undefined, 'called by tool id, no need text');
  assert.ok(graph.prices.needs.company_lookup && graph.prices.needs.people_search, 'both are priced');
  assert.doesNotMatch(desc + work.tenjinOffer('contacts'), /orthogonal|icypeas|agentsearch|companyenrich/i);
});

test('the company lookup request input has only keys from its spec', () => {
  const allowed = ['name', 'linkedinUrl', 'linkedinId', 'twitterUrl', 'facebookUrl', 'instagramUrl', 'youTubeUrl'];
  for (const fields of [{ company: 'Acme' }, { company: 'Acme', linkedinUrl: 'https://www.linkedin.com/company/acme' }, { company: 'Acme', url: 'https://boards.example/x', city: 'New York' }, { linkedinUrl: 'https://www.linkedin.com/company/acme' }]) {
    const input = cl.mapper(fields);
    assert.ok(Object.keys(input).every((k) => allowed.includes(k)), JSON.stringify(input));
    assert.ok(Object.values(input).every((v) => typeof v === 'string'));
  }
  assert.deepEqual(cl.mapper({ company: 'Acme', url: 'u', city: 'c' }), { name: 'Acme' }, 'no url, no location');
  assert.equal(cl.TOOL, 'companyenrich-properties');
  assert.equal(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'router', 'company-lookup.json'), 'utf8'))._note.startsWith('Recorded'), true);
  assert.equal(cl.RECORDED, true);
  assert.throws(() => cl.mapper({}), /no company name/);
});

test('names match only when their normalized word lists are equal: no containment anywhere', async () => {
  assert.equal(company.nameMatches('Vercel Inc', 'Vercel'), true);
  assert.equal(company.nameMatches('Scope Labs', 'Scope Labs, Inc.'), true);
  assert.equal(company.nameMatches('ACME  Robotics LLC', 'acme robotics'), true);
  assert.equal(company.nameMatches('Meow', 'Meow Wolf'), false);
  assert.equal(company.nameMatches('Scope', 'Scope Labs'), false);
  assert.equal(company.nameMatches('Scope Labs', 'Scope'), false);
  assert.equal(company.nameMatches('', ''), false);
  assert.equal(company.nameMatches('Inc', 'Co'), false, 'nothing is left after the suffix words');
  assert.deepEqual(company.normName('The Meow-Wolf Company, Inc.'), ['the', 'meow', 'wolf']);
  // "Meow" against a lookup that answers "Meow Wolf": the domain is not saved
  const ing = await import(`${S}ingest.mjs`);
  reset();
  const j = job(60, { company: 'Meow' });
  add(j);
  const obj = { need: 'company_lookup', status: 'fulfilled', ...cl.adapter({ ...FX.company.step2.envelope.result, name: 'Meow Wolf', legalName: 'Meow Wolf Inc', domain: 'meowwolf.com' }, { jobKey: j.key }) };
  await ing.ingest({ obj, state: store.loadState(), profile: {}, overlay: empty, fetch: fakeFetch({}), now: NOW });
  assert.equal(store.loadState().jobs[j.key].employerWebsite, undefined, 'meowwolf.com is not saved for Meow');
  assert.equal(store.loadState().jobs[j.key].companyLinkedinUrl, undefined);
  // "Vercel Inc" answered for "Vercel": saved
  reset();
  const v = job(61, { company: 'Vercel' });
  add(v);
  await ing.ingest({ obj: { need: 'company_lookup', status: 'fulfilled', ...cl.adapter({ ...FX.company.step2.envelope.result, name: 'Vercel Inc', legalName: null }, { jobKey: v.key }) }, state: store.loadState(), profile: {}, overlay: empty, fetch: fakeFetch({}), now: NOW });
  assert.equal(store.loadState().jobs[v.key].employerWebsite, 'vercel.com');
  // the people search: a lead whose company name only contains the job's company is dropped; an equal name is kept
  const res = { success: true, total: 3, leads: [lead(1, 'Meow Wolf'), lead(2, 'Meow'), lead(3, 'Meow Inc.')] };
  assert.deepEqual(people.adapter(res, { jobKey: 'k', names: ['Meow'] }).contacts.map((c) => c.name), ['P2 X', 'P3 X']);
  assert.deepEqual(people.adapter(res, { jobKey: 'k', names: ['Meow Wolf'] }).contacts.map((c) => c.name), ['P1 X']);
});
