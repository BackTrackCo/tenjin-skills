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
  assert.equal(company.domainMatchesCompany('https://www.acmerobotics.test', ['Acme Robotics']), true);
  assert.equal(company.domainMatchesCompany('https://acme-robotics.test', ['Acme Robotics, Inc.']), true);
  assert.equal(company.domainMatchesCompany('https://zetaholdings.test', ['Acme Robotics', 'Acme']), false);
  assert.equal(company.domainMatchesCompany('https://acme.test', ['Acme Robotics', 'acme']), true, 'the board\'s company name counts too');
});

test('with Tenjin: a free spec, the company lookup run, the domain checked and saved with its source, then the people search by domain', async () => {
  reset();
  add(job(11));
  const f = fake({ answers: [spec(FX.company), run(FX.company.step2.envelope), spec(FX.people), run(FX.people.step2.envelope)] });
  const log = await routed.routeContacts({ keys: null, profile: {}, fetch: fakeFetch({}), client: client(f), now: NOW });
  const j = store.loadState().jobs[job(11).key];
  assert.deepEqual([j.employerWebsite, j.employerWebsiteSource], ['https://www.acmerobotics.test', 'company_lookup']);
  const calls = f.log().filter((l) => l.call).map((l) => l.call);
  assert.deepEqual(calls[0], { tool: 'companyenrich-properties' }, 'the first call is the free spec, by catalog tool id');
  assert.equal(calls[1].id, FX.company.step1.json.id);
  assert.deepEqual(calls[1].input, { name: 'Acme Robotics' }, 'only the name: the board link and the city are code context');
  assert.deepEqual(calls[3].input.query.currentCompanyWebsite, { include: ['acmerobotics.test'] }, 'the people search then filters by the domain');
  assert.equal(log.find((l) => l.status === 'company_lookup').website, 'https://www.acmerobotics.test');
  assert.equal(log.at(-1).searchedBy, 'website');
});

test('a lookup domain that does not match the company is not saved; the people search runs by name and city and its results are weak or dropped', async () => {
  reset();
  add(job(12));
  const people2 = ppl([lead(1, 'Acme Robotics'), lead(2, 'Zeta Holdings'), lead(3, '')]);
  const f = fake({ answers: [spec(FX.company), run(FX.company.step2_mismatch.envelope), spec(FX.people), people2] });
  const log = await routed.routeContacts({ keys: null, profile: {}, fetch: fakeFetch({}), client: client(f), now: NOW });
  const st = store.loadState();
  assert.equal(st.jobs[job(12).key].employerWebsite, undefined, 'no domain that fails the name check is saved');
  const calls = f.log().filter((l) => l.call).map((l) => l.call);
  assert.deepEqual(calls[3].input.query.currentCompanyName, { include: ['Acme Robotics'] });
  assert.equal(calls[3].input.query.currentCompanyWebsite, undefined);
  assert.equal(log.at(-1).searchedBy, 'name and city');
  const got = st.contacts[job(12).key];
  assert.deepEqual(got.map((c) => c.name), ['P1 X', 'P3 X'], 'a person from another company is never recorded');
  assert.equal(got[0].weak, undefined, 'the company matches the board\'s company name: not weak');
  assert.equal(got[1].weak, true, 'no company on the lead: weak');
});

test('the adapter keeps a person only when no known company contradicts, and marks weak what it cannot confirm', () => {
  const res = { success: true, total: 2, leads: [lead(1, 'Acme Robotics'), lead(2, 'Other Co')] };
  const byName = people.adapter(res, { jobKey: 'k', names: ['Acme Robotics'] });
  assert.deepEqual(byName.contacts.map((c) => [c.name, c.weak]), [['P1 X', undefined]]);
  const withSite = people.adapter(res, { jobKey: 'k', names: [], website: 'acmerobotics.test' });
  assert.equal(withSite.contacts.length, 2, 'with a domain the search filter did the matching');
  assert.ok(withSite.contacts.every((c) => c.weak === undefined));
  const noInfo = people.adapter(res, { jobKey: 'k' });
  assert.ok(noInfo.contacts.every((c) => c.weak === true), 'nothing to confirm a company by: weak');
  assert.throws(() => people.mapper({ titles: ['EM'] }), /no employer website or company name/);
  assert.deepEqual(cl.adapter({ company: { name: 'Acme', domain: 'acme.test' } }, { jobKey: 'k' }), { jobKey: 'k', website: 'https://acme.test', name: 'Acme' });
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
  assert.match(desc, /company lookup \(about 1\.2 cents\) for a job whose website is not known/);
  assert.match(work.OFFER_LINES.contacts, /company looked up first/);
  assert.equal(work.OFFER_LINES[work.NEED_LINES.company_lookup], work.OFFER_LINES.contacts);
  const graph = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'graph.json'), 'utf8'));
  assert.equal(graph.needTemplates.company_lookup, undefined, 'called by tool id, no need text');
  for (const kind of [...Object.keys(graph.needTemplates), 'company_lookup']) assert.ok(work.OFFER_LINES[work.NEED_LINES[kind]], kind);
  assert.doesNotMatch(desc + work.tenjinOffer('contacts'), /orthogonal|icypeas|exa|agentsearch/i);
});

test('the company lookup request input has only keys from its spec', () => {
  const allowed = ['name', 'linkedinUrl', 'linkedinId', 'twitterUrl', 'facebookUrl', 'instagramUrl', 'youTubeUrl'];
  assert.deepEqual(cl.INPUTS, allowed);
  for (const fields of [{ company: 'Acme' }, { company: 'Acme', linkedinUrl: 'https://www.linkedin.com/company/acme' }, { company: 'Acme', url: 'https://boards.example/x', city: 'New York' }, { linkedinUrl: 'https://www.linkedin.com/company/acme' }]) {
    const input = cl.mapper(fields);
    assert.ok(Object.keys(input).every((k) => allowed.includes(k)), JSON.stringify(input));
    assert.ok(Object.values(input).every((v) => typeof v === 'string'));
  }
  assert.deepEqual(cl.mapper({ company: 'Acme', url: 'u', city: 'c' }), { name: 'Acme' }, 'no url, no location');
  assert.equal(cl.TOOL, 'companyenrich-properties');
  assert.equal(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'router', 'company-lookup.json'), 'utf8'))._note.startsWith('HAND-MADE'), true);
  assert.throws(() => cl.mapper({}), /no company name/);
});
