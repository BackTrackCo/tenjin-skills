import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tmpHome } from './helpers/env.mjs';
import { fake, runAnswer, seqClient, specAnswer } from './helpers/fake-router.mjs';

tmpHome();
const router = await import('../../skills/gtm-loop/scripts/lib/router.mjs');
const fit = await import('../../skills/gtm-loop/scripts/lib/fit.mjs');
const routed = await import('../../skills/gtm-loop/scripts/lib/routed.mjs');
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const ing = await import('../../skills/gtm-loop/scripts/lib/ingest.mjs');
const search = await import('../../skills/gtm-loop/scripts/lib/search.mjs');
const w = await import('../../skills/gtm-loop/scripts/lib/writing.mjs');

const NOW = Date.parse('2026-11-26T08:00:00Z');
const profile = { buyer: { roles: ['Head of platform', 'CTO'], industry: 'robotics', size: '11-50', place: 'Toronto' }, offer: { name: 'PayRouter', what: 'x' }, phrases: [], sources: ['x'] };
const overlay = { rules: [] };
const client = (f) => new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 500, collect: 40, poll: 10 } });
const FX = Object.fromEntries(['company-list', 'people-search', 'linkedin-author-posts', 'company-profile', 'x-timeline'].map((n) => [n, fixture(`router/${n}.json`)]));
const pair = (fx) => [specAnswer(fx.host), runAnswer(fx.host, fx.result)];

test('the adapters read their fixtures: companies by bare domain, people filtered to the company, author posts, a company profile', async () => {
  const need = (kind, fields) => routed.fillNeed(kind, fields);
  const run = async (fx, n) => (await router.runRound([n], { client: client(fake({ answers: pair(fx) })) }))[0];
  let r = await run(FX['company-list'], need('company_list', { industry: 'robotics', size: '11-50', place: 'Toronto' }));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.ingest.companies.map((c) => c.domain), ['acme-robotics.example', 'boltworks.example'], 'a company with no domain is dropped');
  r = await run(FX['people-search'], need('people_search', { role: 'Head of platform or CTO', domain: 'acme-robotics.example' }));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.ingest.people.map((p) => p.name), ['Pat Lee', 'Sam Ito'], 'a person from another company is dropped');
  r = await run(FX['linkedin-author-posts'], need('linkedin_author_posts', { url: 'https://www.linkedin.com/in/pat-lee-123' }));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.ingest.posts[1].links, ['https://example.org/robots']);
  r = await run(FX['company-profile'], need('company_profile', { domain: 'boltworks.example' }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.ingest.linkedinUrl, 'https://www.linkedin.com/company/boltworks');
  r = await run(FX['x-timeline'], need('x_timeline', { handle: 'dev_one' }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.ingest.posts[0].author, 'dev_one');
});

test('the mappers make the fixture inputs: roles split, a bare domain, "any" is not a filter', async () => {
  for (const [kind, fx, fields] of [['company_list', FX['company-list'], { industry: 'robotics', size: '11-50', place: 'Toronto' }], ['people_search', FX['people-search'], { role: 'Head of platform or CTO', domain: 'acme-robotics.example' }], ['linkedin_author_posts', FX['linkedin-author-posts'], { url: 'https://www.linkedin.com/in/pat-lee-123' }], ['company_profile', FX['company-profile'], { domain: 'https://www.boltworks.example/' }], ['x_timeline', FX['x-timeline'], { handle: '@dev_one' }]]) {
    const f = fake({ answers: pair(fx) });
    await router.runRound([routed.fillNeed(kind, fields)], { client: client(f) });
    assert.deepEqual(f.calls()[1].input, fx.input, kind);
  }
  const f = fake({ answers: [specAnswer('stableenrich.dev')] });
  const [r] = await router.runRound([routed.fillNeed('company_list', { industry: 'any', size: 'any', place: 'anywhere' })], { client: client(f) });
  assert.equal(r.status, 'no_input', 'a list with no industry and no place is never sent');
});

test('a fit round: one company list, people at each company, a lead per person with the profile identity, the company, the country, and the recent post as the signal', async () => {
  const c = seqClient(router.RouterClient, router.TIMEOUTS, [
    { answers: pair(FX['company-list']) },
    { answers: [...pair(FX['people-search']), specAnswer(FX['people-search'].host), { status: 'needs_approval', reason: 'over the daily budget' }] },
    { answers: [...pair(FX['linkedin-author-posts']), ...pair({ ...FX['linkedin-author-posts'], result: { output: { found: true, data: { items: [], nextCursor: null } } } })] },
  ]);
  const out = await fit.runFitRound({ profile, overlay, client: c, now: NOW });
  const f = { calls: () => c.fakes.flatMap((x) => x.calls()) };
  assert.equal(out.list.companies, 2);
  assert.equal(out.people.searched, 2);
  assert.equal(out.people.added, 2);
  const s = store.loadState();
  assert.equal(s.companies['acme-robotics.example'].peopleDoneAt !== null, true);
  assert.equal(s.companies['boltworks.example'].peopleDoneAt, null, 'a held search is tried again next round');
  assert.ok(s.held.some((h) => /people_search/.test(h.detail) && /daily budget/.test(h.detail)));
  const pat = s.leads['fit:acme-robotics.example:pat-lee-123'];
  assert.equal(pat.kind, 'fit');
  assert.equal(pat.source, 'people');
  assert.equal(pat.status, 'new');
  assert.match(pat.text, /robots pay for cloud APIs/);
  assert.equal(pat.signalUrl, 'https://www.linkedin.com/posts/pat-lee-123_new-activity-2-bb', 'the newest post, not the old one');
  assert.equal(s.people['linkedin:pat-lee-123'].company, 'Acme Robotics');
  assert.equal(s.people['linkedin:pat-lee-123'].domain, 'acme-robotics.example');
  assert.equal(s.people['linkedin:pat-lee-123'].country, 'CA');
  assert.equal(s.people['linkedin:sam-ito-9'].country, 'DE');
  assert.equal(s.leads['fit:acme-robotics.example:sam-ito-9'].text, '');
  assert.equal(s.leads['fit:acme-robotics.example:sam-ito-9'].postsRead, true);
  assert.deepEqual(f.calls().filter((x) => x.query).map((x) => x.query.split(' ').slice(0, 3).join(' ')), ['List companies in', 'Find people with', 'Find people with', 'Read the recent', 'Read the recent']);
  assert.ok(s.spend.some((x) => x.kind === 'company_list' && x.cents === 0.5));
});

test('a company list costs most, so it runs only when no company waits for its people search', async () => {
  const f = fake({ answers: [] });
  const r = await fit.runCompanyList({ profile, client: client(f), now: NOW });
  assert.equal(r.ran, false);
  assert.equal(f.calls().length, 0);
  assert.equal((await fit.runFitRound({ profile: { offer: {} }, overlay, client: client(f), now: NOW })).skipped, 'no buyer');
});

test('the person\'s own companies-per-search cap cuts the people searches; with none every waiting company is searched', async () => {
  store.updateState((st) => { st.companies = { 'a.example': { domain: 'a.example', name: 'A', peopleDoneAt: null }, 'b.example': { domain: 'b.example', name: 'B', peopleDoneAt: null }, 'c.example': { domain: 'c.example', name: 'C', peopleDoneAt: null } }; });
  const none = { success: true, total: 0, leads: [] };
  const f = fake({ answers: [...pair({ host: 'x402.orthogonal.com', result: none }), ...pair({ host: 'x402.orthogonal.com', result: none })] });
  const r = await fit.runPeopleSearch({ profile, overlay: { rules: [{ effect: 'companies_per_search', value: 2 }] }, client: client(f), now: NOW });
  assert.equal(r.searched, 2);
  assert.equal(fit.unprocessed(store.loadState()).length, 1);
  const g = fake({ answers: pair({ host: 'x402.orthogonal.com', result: none }) });
  assert.equal((await fit.runPeopleSearch({ profile, overlay, client: client(g), now: NOW })).searched, 1);
});

test('the person\'s excluded domain and a suppressed or contacted person never become a fit lead', async () => {
  store.updateState((st) => { Object.assign(st, store.emptyState()); st.companies['acme-robotics.example'] = { domain: 'acme-robotics.example', name: 'Acme Robotics', peopleDoneAt: null }; });
  const dd = await import('../../skills/gtm-loop/scripts/lib/dedupe.mjs');
  store.updateState((st) => { const p = dd.resolvePerson(st, ['linkedin:pat-lee-123']); dd.suppressPerson(st, p.key, 'opt_out'); });
  const f = fake({ answers: pair(FX['people-search']) });
  const r = await fit.runPeopleSearch({ profile, overlay: { rules: [{ id: 'r9', effect: 'exclude_person', value: 'Sam Ito' }] }, client: client(f), now: NOW });
  assert.equal(r.added, 0);
  assert.deepEqual(Object.keys(store.loadState().leads), []);
});

test('a company named by its domain is profiled once; a held profile is not asked again', async () => {
  store.updateState((st) => { Object.assign(st, store.emptyState()); fit.addCompanies(st, ['https://www.boltworks.example/', 'boltworks.example']); });
  assert.deepEqual(Object.keys(store.loadState().companies), ['boltworks.example']);
  assert.throws(() => fit.addCompanies(store.emptyState(), ['nope']), /not a company domain/);
  const f = fake({ answers: pair(FX['company-profile']) });
  assert.equal((await fit.runCompanyProfiles({ client: client(f), now: NOW })).reads, 1);
  assert.equal(store.loadState().companies['boltworks.example'].name, 'Bolt Works');
  assert.equal((await fit.runCompanyProfiles({ client: client(fake({ answers: [] })), now: NOW })).reads, 0);
});

test('a fit lead is reviewed with "no signal", written without saying they asked, and offered the email and the LinkedIn note', async () => {
  const s = store.emptyState();
  const dd = await import('../../skills/gtm-loop/scripts/lib/dedupe.mjs');
  const person = dd.resolvePerson(s, ['linkedin:sam-ito-9'], { name: 'Sam Ito' });
  person.company = 'Acme Robotics';
  dd.addFitLead(s, { key: 'fit:acme-robotics.example:sam-ito-9', person: { ...person, profileUrl: 'https://www.linkedin.com/in/sam-ito-9' }, source: 'people', text: '' });
  const hand = ing.reviewHandout(s);
  assert.deepEqual(hand[0].channels, ['linkedin_note', 'email', 'x_dm']);
  const rev = { reviews: [{ key: 'fit:acme-robotics.example:sam-ito-9', fit: 80, intent: 10, timing: 10, quote: null, line: 'no signal', channel: 'linkedin_note', keep: true }] };
  assert.deepEqual(ing.checkReview(rev, s), []);
  ing.applyReview(s, rev, { overlay });
  const lead = s.leads['fit:acme-robotics.example:sam-ito-9'];
  assert.equal(lead.status, 'reviewed');
  assert.deepEqual(w.offeredChannels(lead), ['linkedin_note', 'email']);
  assert.ok(w.checkDraft(lead, 'linkedin_note', { text: 'PayRouter here. You asked about agent payments.' }, { offer: { name: 'PayRouter' } }).some((b) => /never asked/.test(b)));
});

test('the search step runs the fit round after the post round when the person described a buyer', async () => {
  store.updateState((st) => { Object.assign(st, store.emptyState()); st.tenjin.status = 'ready'; });
  const f = fake({ answers: [...pair({ host: 'x402.orthogonal.com', result: { success: true, total: 0, leads: [] } })] });
  store.updateState((st) => { st.companies['acme-robotics.example'] = { domain: 'acme-robotics.example', name: 'Acme', peopleDoneAt: null }; });
  const out = await search.searchStep({ profile: { ...profile, phrases: ['agent pay'], sources: ['x'] }, overlay, fetchImpl: undefined, now: NOW, routerClient: client(f) });
  assert.equal(out.fit.people.searched, 1);
  assert.equal(out.fit.list.ran, false);
});
