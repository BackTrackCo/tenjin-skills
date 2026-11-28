import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, runGtm, tmpHome } from './helpers/env.mjs';
import { fake, runAnswer, specAnswer } from './helpers/fake-router.mjs';

// When the service behind a need changes its input or its answer, the loop holds that one need, writes ONE repair request, and the
// agent is told once. A mapping (data) is checked against the saved answer, stored, and the saved answer is re-read: no second payment.
const home = tmpHome();
const routed = await import('../../skills/gtm-loop/scripts/lib/routed.mjs');
const router = await import('../../skills/gtm-loop/scripts/lib/router.mjs');
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const rp = await import('../../skills/gtm-loop/scripts/lib/repairs.mjs');
const reader = await import('../../skills/gtm-loop/scripts/lib/reader.mjs');
const work = await import('../../skills/gtm-loop/scripts/lib/work.mjs');
const rep = await import('../../skills/gtm-loop/scripts/lib/report.mjs');
await import('../../skills/gtm-loop/scripts/lib/steps.mjs'); // registers the repair work item, as the command line does

const NOW = Date.parse('2026-11-27T08:00:00Z');
const profile = { offers: [{ id: 'gtm', name: 'LoopA', phrases: ['how did you get your first users'], subreddits: ['startups'] }], sources: ['x'] };
const client = (f) => new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300, collect: 40, poll: 10 } });
const fresh = () => { store.updateState((s) => Object.assign(s, store.emptyState())); fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'gtm-loop', 'mappings.json'), { force: true }); };
const round = (f) => routed.runPostRound({ profile, overlay: { rules: [] }, client: client(f), now: NOW });
const X = fixture('router/x-posts.json');
const NEW_HOST = 'newsearch.example.com';
// The spec answer as today's router sends it: JSON plus a text block with "Request:" and an "Inputs:" list.
const specFor = (host, properties, required) => ({ ...specAnswer(host), __text: `A service.\nPrice: $0.005 per call.\nRequest: POST https://${host}/search\nInputs:\n${Object.entries(properties).map(([n, p]) => `- ${n} (${p.type}${required.includes(n) ? ', required' : ''}); ${p.description || 'a field'}`).join('\n')}\nReturns: JSON.` });
const QUERY_SPEC = (host) => specFor(host, { q: { type: 'string' }, since: { type: 'string' } }, ['q']);
// A changed answer: a list under `data.hits`, each hit with `link`, `body`, `username` and `created`.
const SHAPE_A = { data: { hits: [{ link: 'https://x.com/ann/status/1900000000000000101', body: 'Anyone know how to get my first users without ads? I have none.', username: 'ann', created: '2026-11-26T09:00:00Z' }, { link: 'https://x.com/bo/status/1900000000000000102', body: 'How did you get your first users for a dev tool? Asking for real.', username: 'bo', created: '2026-11-26T10:00:00Z' }] } };
// An answer the generic reader cannot read: no link, no text under any usual name.
const SHAPE_B = { rows: [{ a1: 'https://x.com/cy/status/1900000000000000201', zz: 'How did you get your first users? I need ideas for a dev tool.', who: 'cy' }, { a1: 'https://x.com/di/status/1900000000000000202', zz: 'Any tips to get my first users for a small SaaS today?', who: 'di' }] };
const tmpFile = (obj) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-map-')), 'mapping.json'); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const requests = () => Object.values(store.loadState().repairs.requests);

test('a known seller reads with no repair request and no model step, by its shipped default mapping', async () => {
  fresh();
  const f = fake({ answers: [specAnswer(X.host), runAnswer(X.host, X.result)] });
  const out = await round(f);
  assert.equal(out.ok, 1);
  assert.equal(out.added, 2);
  assert.equal(requests().length, 0);
  assert.equal(work.itemsOf(store.loadState(), profile, { rules: [] }, NOW).some((i) => i.reason === 'repair_due'), false);
});

test('an unknown seller whose answer the generic reader passes needs no repair: its input is filled from its own field names', async () => {
  fresh();
  const f = fake({ answers: [QUERY_SPEC(NEW_HOST), runAnswer(NEW_HOST, SHAPE_A)] });
  const out = await round(f);
  assert.equal(out.ok, 1, JSON.stringify(out.held));
  assert.equal(out.added, 2);
  const sent = f.calls()[1].input;
  assert.deepEqual(Object.keys(sent), ['q', 'since'].filter((k) => k in sent));
  assert.match(sent.q, /first users/);
  assert.equal(requests().length, 0);
  const posts = Object.values(store.loadState().leads);
  assert.deepEqual(posts.map((l) => l.author).sort(), ['ann', 'bo']);
});

test('an unknown seller that fails the check holds that need, saves the paid answer and writes exactly one repair request; a second round neither pays nor writes again', async () => {
  fresh();
  const f = fake({ answers: [QUERY_SPEC(NEW_HOST), runAnswer(NEW_HOST, SHAPE_B)] });
  const out = await round(f);
  assert.equal(out.ok, 0);
  assert.equal(out.held[0].status, 'output_break');
  assert.match(out.held[0].reason, /It is paid and saved\. Repair request r1/);
  const [r] = requests();
  assert.equal(r.side, 'output');
  assert.equal(r.seller, NEW_HOST);
  assert.ok(fs.existsSync(r.rawPath), 'the paid answer is kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(r.rawPath, 'utf8')), SHAPE_B);
  const items = work.itemsOf(store.loadState(), profile, { rules: [] }, NOW).filter((i) => i.reason === 'repair_due');
  assert.equal(items.length, 1);
  // The next round: the same seller answers the need again. Nothing is paid and no second request is written.
  const g = fake({ answers: [QUERY_SPEC(NEW_HOST), runAnswer(NEW_HOST, SHAPE_B)] });
  const second = await round(g);
  assert.equal(second.held[0].status, 'repair_pending');
  assert.equal(g.calls().length, 1, 'only the free spec call went out');
  assert.equal(requests().length, 1);
  assert.match(rep.report(store.loadState(), profile, NOW).text, /Held: .*repair r1/);
});

test('the agent is told once: show prints the fields, a small sample and what the loop needs, then the item is gone', async () => {
  fresh();
  const f = fake({ answers: [QUERY_SPEC(NEW_HOST), runAnswer(NEW_HOST, SHAPE_B)] });
  await round(f);
  const first = rp.showRepair('r1');
  assert.equal(first.need, 'x_posts');
  assert.match(first.loopNeeds, /link/);
  assert.deepEqual(first.required, ['url', 'text']);
  assert.equal(first.sample.rows.length, 2);
  assert.equal(first.sample.rows[0].a1, 'https://x.com/cy/status/1900000000000000201');
  assert.equal(first.answerShape, undefined, 'the sample already shows the shape');
  assert.ok(JSON.stringify(first).length < 3500, 'a few hundred tokens');
  assert.equal(work.itemsOf(store.loadState(), profile, { rules: [] }, NOW).some((i) => i.reason === 'repair_due'), false, 'never handed out again');
  assert.equal(store.loadState().repairs.requests.r1.status, 'told');
});

test('a valid mapping is stored, the saved answer is re-read with no new call, and the next round reads with no model step', async () => {
  fresh();
  const f = fake({ answers: [QUERY_SPEC(NEW_HOST), runAnswer(NEW_HOST, SHAPE_B, { cost: ['provider price 0.005 USD'] })] });
  await round(f);
  rp.showRepair('r1');
  const callsBefore = f.calls().length;
  const res = rp.applyRepair('r1', tmpFile({ output: { list: ['rows'], fields: { url: 'a1', text: 'zz', author: 'who' } } }));
  assert.equal(res.paidAgain, false);
  assert.match(res.reread, /re-read the saved answer: 2 posts, 2 new leads/);
  assert.equal(f.calls().length, callsBefore, 'no new call');
  const s = store.loadState();
  assert.equal(Object.keys(s.leads).length, 2);
  assert.equal(s.repairs.requests.r1.status, 'done');
  assert.equal(s.held.some((h) => /x_posts/.test(h.detail || '')), false, 'the held line is gone');
  assert.equal(s.spend.filter((x) => x.search).length, 1, 'the paid call counts once');
  assert.equal(rp.storedMapping('x_posts', NEW_HOST).output.list[0], 'rows');
  // The next round reads the same seller's new answers with the mapping, in code.
  const g = fake({ answers: [QUERY_SPEC(NEW_HOST), runAnswer(NEW_HOST, { rows: [{ a1: 'https://x.com/ed/status/1900000000000000301', zz: 'How did you get your first users? Day three and still none.', who: 'ed' }] })] });
  const out = await round(g);
  assert.equal(out.ok, 1);
  assert.equal(out.added, 1);
  assert.equal(requests().length, 1, 'no new request');
});

test('an invalid mapping is refused with a clear message, and the request stays open', async () => {
  fresh();
  const f = fake({ answers: [QUERY_SPEC(NEW_HOST), runAnswer(NEW_HOST, SHAPE_B)] });
  await round(f);
  const bad = (m, re) => assert.throws(() => rp.applyRepair('r1', tmpFile(m)), re);
  bad('not json', /not JSON/);
  bad({ output: { list: ['rows'], fields: { url: 'nope', text: 'zz' } } }, /does not read the saved answer: only 0 of 2 items have url and text/);
  bad({ output: { list: ['missing'], fields: { url: 'a1', text: 'zz' } } }, /no list of items at the mapped place/);
  bad({ output: { list: ['rows'], fields: { url: 'a1', text: 'zz', phone: 'who' } } }, /phone is not a field of x_posts/);
  bad({ output: { list: ['rows'], fields: { url: '__proto__.x', text: 'zz' } } }, /output\.fields\.url/);
  bad({ output: { list: ['rows'], fields: { url: 'a1', text: 'zz' } }, script: 'rm -rf x' }, /keys the loop does not read: script/);
  bad({ input: { q: '{query}' } }, /is an output break: the mapping needs "output"/);
  assert.equal(store.loadState().repairs.requests.r1.status, 'open');
  assert.equal(rp.storedMapping('x_posts', NEW_HOST), null);
  assert.equal(Object.keys(store.loadState().leads).length, 0);
});

test('an input break is held before payment with the service\'s new fields, the rest of the round still runs, and a mapped input fixes it', async () => {
  fresh();
  const spec = specFor(NEW_HOST, { searchPhrase: { type: 'string', description: 'what to look for' }, limit: { type: 'integer' } }, ['searchPhrase']);
  const two = { offers: [{ id: 'gtm', name: 'LoopA', phrases: ['how did you get your first users'], subreddits: ['startups'] }], sources: ['x', 'linkedin'] };
  const lk = fixture('router/linkedin-posts.json');
  // The first need (X) meets a changed service; the second (LinkedIn) is known and runs.
  const f = fake({ answers: [spec, specAnswer(lk.host), runAnswer(lk.host, lk.result)] });
  const out = await routed.runPostRound({ profile: two, overlay: { rules: [] }, client: client(f), now: NOW });
  assert.equal(out.ok, 1, 'the other need ran');
  assert.deepEqual(out.held.map((h) => h.status), ['input_break']);
  assert.match(out.held[0].reason, /Nothing was paid/);
  assert.equal(f.calls().filter((c) => c.id).length, 1, 'only the LinkedIn run was paid');
  const r = requests()[0];
  assert.equal(r.side, 'input');
  assert.deepEqual(r.specFields.map((x) => [x.name, x.type, x.required]), [['searchPhrase', 'string', true], ['limit', 'integer', false]]);
  const shown = rp.showRepair(r.id);
  assert.equal(shown.serviceInputFields[0].name, 'searchPhrase');
  assert.match(JSON.stringify(shown.loopInputs), /query/);
  assert.throws(() => rp.applyRepair(r.id, tmpFile({ input: { searchPhrase: '{nope}' } })), /\{nope\} is not an input of x_posts/);
  assert.throws(() => rp.applyRepair(r.id, tmpFile({ input: { wrongName: '{query}' } })), /missing searchPhrase/);
  const res = rp.applyRepair(r.id, tmpFile({ input: { searchPhrase: '{query}[ since:{since}]', limit: 20 } }));
  assert.match(res.reread, /next round/);
  const g = fake({ answers: [spec, runAnswer(NEW_HOST, X.result)] });
  const next = await round(g);
  assert.equal(next.ok, 1);
  assert.equal(g.calls()[1].input.limit, 20);
  assert.match(g.calls()[1].input.searchPhrase, /first users/);
  assert.equal(requests().length, 1);
});

test('the service refusing the input after the spec (needs_input) is an input break with nothing paid, and a second round does not write another request', async () => {
  fresh();
  const f = fake({ answers: [specAnswer(X.host), { status: 'needs_input', reason: 'the input has no field foo' }] });
  const out = await round(f);
  assert.equal(out.held[0].status, 'input_break');
  assert.equal(requests().length, 1);
  assert.equal(requests()[0].side, 'input');
  const g = fake({ answers: [specAnswer(X.host), { status: 'needs_input', reason: 'the input has no field foo' }] });
  await round(g);
  assert.equal(requests().length, 1, 'the same break is never reported twice');
});

test('a seller whose terms allow immediate use only is never saved: the request holds the key names and types only', async () => {
  fresh();
  const webProfile = { offers: [{ id: 'gtm', name: 'LoopA', phrases: ['how did you get your first users'], subreddits: ['startups'] }], sources: ['web'] };
  const web = fixture('router/web-research.json');
  const spec = specFor(web.host, { query: { type: 'string' }, type: { type: 'string' }, numResults: { type: 'integer' }, includeDomains: { type: 'array' } }, ['query']);
  const f = fake({ answers: [spec, runAnswer(web.host, { pages: [{ href: 'https://forum.example.org/t/9', blurb: 'PRIVATE SELLER TEXT' }] })] });
  const out = await routed.runPostRound({ profile: webProfile, overlay: { rules: [] }, client: client(f), now: NOW });
  assert.equal(out.held[0].status, 'output_break');
  assert.match(out.held[0].reason, /terms do not allow saving it/);
  const [r] = requests();
  assert.equal(r.rawPath, null);
  assert.equal(r.noSave, true);
  assert.equal(JSON.stringify(r).includes('PRIVATE SELLER TEXT'), false, 'no content of the answer is kept');
  assert.deepEqual(JSON.parse(r.shape), { pages: [{ href: 'string', blurb: 'string' }] });
  assert.equal(fs.existsSync(path.join(process.env.TENJIN_SKILLS_DIR, 'gtm-loop', 'results')) && fs.readdirSync(path.join(process.env.TENJIN_SKILLS_DIR, 'gtm-loop', 'results')).some((n) => /web_research/.test(n)), false);
  const res = rp.applyRepair(r.id, tmpFile({ output: { list: ['pages'], fields: { url: 'href', text: 'blurb' } } }));
  assert.match(res.checked, /not checked against an answer/);
  const shown = rp.storedMapping('web_research', web.host);
  assert.ok(shown.output);
});

test('the profile reads and fit reads re-read their saved answer the same way', async () => {
  fresh();
  const li = fixture('router/linkedin-profile.json');
  store.updateState((s) => {
    s.people.P = { key: 'P', ids: ['linkedin:pat-lee-123'], name: null, company: null, country: null };
    s.leads.L = { key: 'L', personKey: 'P', status: 'reviewed', kind: 'post', source: 'linkedin', url: 'https://www.linkedin.com/posts/x' };
  });
  const changed = { person: { who: 'Pat Lee', basedIn: 'Toronto, Canada', employer: 'Acme Robotics', blurb: 'Builds robots' } };
  const spec = specFor(li.first.host, { url: { type: 'string' } }, ['url']);
  const f = fake({ answers: [spec, runAnswer(li.first.host, changed)] });
  await routed.runIdentityReads({ client: client(f), now: NOW });
  const [r] = requests();
  assert.equal(r.need.kind, 'linkedin_profile');
  const res = rp.applyRepair(r.id, tmpFile({ output: { root: ['person'], fields: { name: 'who', location: 'basedIn', company: 'employer', about: 'blurb' } } }));
  assert.match(res.reread, /filled the lead/);
  const s = store.loadState();
  assert.equal(s.people.P.company, 'Acme Robotics');
  assert.equal(s.people.P.country, 'CA');
  assert.equal(s.leads.L.identityRead, true);
  assert.equal(f.calls().length, 2, 'no new call');
});

test('G repair list, show and apply run through the command line, and work lists the request once', () => {
  fresh();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-cli-'));
  const env = { TENJIN_SKILLS_DIR: path.join(d, '.tenjin-skills') };
  const empty = runGtm(d, ['repair', 'list'], { env });
  assert.deepEqual(empty.json, { repairs: [] });
  const bad = runGtm(d, ['repair', 'show', 'r9'], { env });
  assert.match(bad.json.error, /no repair request r9/);
  const noFile = runGtm(d, ['repair', 'apply', 'r9'], { env });
  assert.match(noFile.json.error, /repair apply <id> --file/);
});

test('the reader: paths, the generic reader and the template builder', () => {
  assert.equal(reader.getPath({ a: { b: [{ c: 1 }, { c: 2 }] } }, 'a.b[].c').join(), '1,2');
  assert.equal(reader.getPath({ a: [{ c: 1 }, { c: 2 }] }, 'a[1].c'), 2);
  assert.equal(reader.getPath({}, '__proto__.x'), undefined);
  const g = reader.genericRead('x_posts', SHAPE_A);
  assert.deepEqual(g.output.list, ['data.hits']);
  assert.equal(reader.genericRead('x_posts', SHAPE_B), null);
  assert.equal(reader.genericRead('x_posts', { found: false }).rows.length, 0, 'a seller that says it found nothing is an empty answer, not a break');
  const vars = reader.loopInputs('x_posts', { query: 'a b', since: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10) });
  assert.deepEqual(reader.buildInput({ q: '{query}[ since:{since}]', age: { byAge: ['d', 'w', 'm', 'y'] }, skip: '{missing}', kept: { if: { query: 'a b' }, then: 1, else: 2 } }, vars), { q: `a b since:${vars.since}`, age: 'w', kept: 1 });
  assert.deepEqual(reader.buildInput({ q: '{query}[ since:{since}]' }, { query: 'a b' }), { q: 'a b' });
});

test('the input fields are read from the "Inputs:" text of today\'s spec answer, and a field the text does not list is never a break', () => {
  const text = 'Orthogonal (a lead database): Find people.\nPrice: $0.01 per call.\nRequest: POST https://svc.example.com/find\nInputs:\n- query (object {currentJobTitle, currentCompanyWebsite, locatio...}, required); One or more filters, each {"include": [...]}.\n- pagination (object {size, token})\n- note (string, required); free text\nExample input: {}\nReturns: JSON.';
  const spec = reader.specInput({ status: 'spec', __text: text });
  assert.deepEqual(spec.fields.map((f) => [f.name, f.type, f.required]), [['query', 'object', true], ['pagination', 'object', false], ['note', 'string', true]]);
  assert.equal(reader.specInput({ status: 'spec', __text: 'Supplier x. Inputs: query.' }), null);
  assert.deepEqual(reader.fitsSpec({ query: {}, note: 'a', sort: 'latest' }, spec), { ok: true, missing: [], unknown: [] });
  assert.deepEqual(reader.fitsSpec({ query: {} }, spec).missing, ['note']);
});
