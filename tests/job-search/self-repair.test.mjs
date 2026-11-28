import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fixture, runJobs, tmpHome } from './helpers/env.mjs';

// When the service behind a routed need changes its input or its answer, the loop holds that one need, writes ONE repair request and tells
// the agent once. The readers that know today's services stay as they are. A mapping (data) is checked against the saved answer and stored,
// and the saved answer is read the next time that need runs: no second payment.
const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const router = await import(`${S}router.mjs`);
const store = await import(`${S}store.mjs`);
const rp = await import(`${S}repairs.mjs`);
const reader = await import(`${S}reader.mjs`);
const work = await import(`${S}work.mjs`);
const FAKE = path.join(import.meta.dirname, 'helpers', 'fake-tenjin.mjs');
const FX = Object.fromEntries(['job-postings', 'x-posts', 'exa-search', 'careers-page', 'people-search', 'company-lookup', 'linkedin-profile'].map((n) => [n, fixture(`router/${n}.json`)]));
const NOW = Date.parse('2026-11-27T08:00:00Z');
function fake(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faketenjin-'));
  const sf = path.join(dir, 'script.json');
  const lf = path.join(dir, 'log.jsonl');
  fs.writeFileSync(sf, JSON.stringify(script));
  const bin = path.join(dir, 'tenjin');
  fs.writeFileSync(bin, `#!/bin/sh\nFAKE_SCRIPT="${sf}" FAKE_LOG="${lf}" exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const log = () => (fs.existsSync(lf) ? fs.readFileSync(lf, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { bin, log, calls: () => log().filter((l) => l.call).map((l) => l.call) };
}
const client = (f) => new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300, collect: 40, poll: 10 } });
const run = (needs, f) => router.runRound([].concat(needs), { client: client(f) });
const fresh = () => { store.updateState((s) => Object.assign(s, store.emptyState())); fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'mappings.json'), { force: true }); };
beforeEach(fresh);
const requests = () => Object.values(store.loadState().repairs.requests);

const NEW_HOST = 'newsearch.example.com';
// A spec answer as today's router sends it: JSON plus a text block with "Request:" and an "Inputs:" list.
const spec = (host, fields, base = FX['x-posts'].step1.json) => ({ ...base, __text: `A service.\nPrice: $0.005 per call.\nRequest: POST https://${host}/search\nInputs:\n${fields.map(([n, t, req]) => `- ${n} (${t}${req ? ', required' : ''}); a field`).join('\n')}\nReturns: JSON.` });
const answer = (host, result, extra = {}) => ({ status: 'fulfilled', supplier: host, cost: ['provider price 0.005 USD'], result: JSON.stringify(result), ...extra });
const xNeed = { kind: 'x_hiring_posts', text: 'hiring posts on X', fields: { role: 'software engineer', place: 'New York City', since: '2026-11-20' }, query: { role: 'software engineer', variant: null, round: 0 } };
const SHAPE_A = { hits: [{ link: 'https://x.com/ann/status/1900000000000000101', body: 'We are hiring a software engineer in New York, apply by email.', username: 'ann' }, { link: 'https://x.com/bo/status/1900000000000000102', body: 'Hiring: software engineer, hybrid in NYC. Details in the thread.', username: 'bo' }] };
const SHAPE_B = { rows: [{ a1: 'https://x.com/cy/status/1900000000000000201', zz: 'Hiring a software engineer in New York. Great team.', who: 'cy' }, { a1: 'https://x.com/di/status/1900000000000000202', zz: 'We are hiring software engineers in NYC, remote friendly.', who: 'di' }] };
const tmpFile = (obj) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'job-map-')), 'mapping.json'); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };

test('a service the loop has a reader for works as before, with no repair request', async () => {
  const J = FX['job-postings'];
  const f = fake({ answers: [{ ...J.step1.json, __text: J.step1.text }, { ...J.step2.envelope, result: JSON.stringify(J.step2.envelope.result) }] });
  const [r] = await run({ kind: 'job_postings', text: J.step1.query, fields: { role: 'software engineer', place: 'New York City', remote: false, since: null, days: 3 }, query: {} }, f);
  assert.equal(r.ok, true);
  assert.equal(r.via, 'reader');
  assert.equal(requests().length, 0);
});

test('the input fields of every recorded spec are read from its text, and the recorded input fits them', () => {
  let n = 0;
  for (const [name, fx] of Object.entries(FX)) {
    if (!fx.step1 || !fx.step1.text) continue;
    const specIn = reader.specInput({ status: 'spec', __text: fx.step1.text });
    assert.ok(specIn && specIn.fields.length, `${name}: the Inputs block is read`);
    const sent = fx.step2 && fx.step2.input;
    if (sent) { assert.deepEqual(reader.fitsSpec(sent, specIn).missing, [], `${name}: the input that worked fits`); n += 1; }
  }
  assert.ok(n >= 4);
});

test('an unknown service whose answer the generic reader passes needs no repair: its input is filled from its own field names', async () => {
  const f = fake({ answers: [spec(NEW_HOST, [['q', 'string', true], ['cursor', 'string']]), answer(NEW_HOST, SHAPE_A)] });
  const [r] = await run(xNeed, f);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.via, 'generic');
  assert.deepEqual(r.ingest.posts.map((p) => p.author), ['ann', 'bo']);
  assert.match(f.calls()[1].input.q, /hiring "software engineer"/);
  assert.equal(requests().length, 0);
});

test('an unknown service that fails the check holds that need, saves the paid answer and writes exactly one repair request; the next run neither pays nor writes again', async () => {
  const f = fake({ answers: [spec(NEW_HOST, [['q', 'string', true]]), answer(NEW_HOST, SHAPE_B)] });
  const [r] = await run(xNeed, f);
  assert.equal(r.status, 'output_break');
  assert.match(r.reason, /It is paid and saved\. Repair request r1/);
  const [req] = requests();
  assert.deepEqual([req.side, req.seller], ['output', NEW_HOST]);
  assert.deepEqual(JSON.parse(fs.readFileSync(req.rawPath, 'utf8')), SHAPE_B, 'the paid answer is kept');
  const g = fake({ answers: [spec(NEW_HOST, [['q', 'string', true]]), answer(NEW_HOST, SHAPE_B)] });
  const [second] = await run(xNeed, g);
  assert.equal(second.status, 'repair_pending');
  assert.equal(g.calls().length, 1, 'only the free spec call went out');
  assert.equal(requests().length, 1);
});

test('the agent is told once: show prints the fields, a small sample and what the loop needs, then the item is gone', async () => {
  const f = fake({ answers: [spec(NEW_HOST, [['q', 'string', true]]), answer(NEW_HOST, SHAPE_B)] });
  await run(xNeed, f);
  const due = () => work.buildWorkList(store.loadState(), { rules: [], lessons: [] }, NOW, { search: { role: 'software engineer' } }).items.filter((i) => i.reason === 'repair_due');
  assert.equal(due().length, 1);
  const shown = rp.showRepair('r1');
  assert.equal(shown.need, 'x_hiring_posts');
  assert.match(shown.loopNeeds, /link/);
  assert.deepEqual(shown.required, ['url', 'text']);
  assert.equal(shown.sample.rows.length, 2);
  assert.ok(JSON.stringify(shown).length < 3500, 'a few hundred tokens');
  assert.equal(due().length, 0, 'never handed out again');
  assert.equal(store.loadState().repairs.requests.r1.status, 'told');
});

test('a valid mapping is stored, the saved answer is read the next time the need runs with no new call, and later runs read with the mapping', async () => {
  const f = fake({ answers: [spec(NEW_HOST, [['q', 'string', true]]), answer(NEW_HOST, SHAPE_B)] });
  await run(xNeed, f);
  rp.showRepair('r1');
  const res = rp.applyRepair('r1', tmpFile({ output: { list: ['rows'], fields: { url: 'a1', text: 'zz', 'author.username': 'who' } } }));
  assert.equal(res.paidAgain, false);
  assert.match(res.checked, /read 2 items from the saved answer/);
  assert.equal(store.loadState().repairs.requests.r1.status, 'done');
  const g = fake({ answers: [] });
  const [again] = await run(xNeed, g);
  assert.equal(again.ok, true, again.reason);
  assert.equal(again.via, 'repaired');
  assert.deepEqual(again.ingest.posts.map((p) => p.author), ['cy', 'di']);
  assert.equal(g.calls().length, 0, 'the saved answer was read: no call at all');
  assert.equal(again.cost, 'provider price 0.005 USD');
  // the next day's search: a new answer in the same shape, read by the mapping in code
  const h = fake({ answers: [spec(NEW_HOST, [['q', 'string', true]]), answer(NEW_HOST, { rows: [{ a1: 'https://x.com/ed/status/1900000000000000301', zz: 'Hiring a software engineer in New York, day three.', who: 'ed' }] })] });
  const [next] = await run(xNeed, h);
  assert.equal(next.via, 'repaired');
  assert.equal(next.ingest.posts.length, 1);
  assert.equal(requests().length, 1);
});

test('an invalid mapping is refused with a clear message, and the request stays open', async () => {
  const f = fake({ answers: [spec(NEW_HOST, [['q', 'string', true]]), answer(NEW_HOST, SHAPE_B)] });
  await run(xNeed, f);
  const bad = (m, re) => assert.throws(() => rp.applyRepair('r1', tmpFile(m)), re);
  bad('not json', /not JSON/);
  bad({ output: { list: ['rows'], fields: { url: 'nope', text: 'zz' } } }, /does not read the saved answer: only 0 of 2 items have url and text/);
  bad({ output: { list: ['missing'], fields: { url: 'a1', text: 'zz' } } }, /no list of items at the mapped place/);
  bad({ output: { list: ['rows'], fields: { url: 'a1', text: 'zz', phone: 'who' } } }, /phone is not a key of x_hiring_posts/);
  bad({ output: { list: ['rows'], fields: { url: '__proto__.x', text: 'zz' } } }, /output\.fields\.url/);
  bad({ output: { list: ['rows'], fields: { url: 'a1', text: 'zz' } }, script: 'rm -rf x' }, /keys the loop does not read: script/);
  bad({ input: { q: '{query}' } }, /is an output break: the mapping needs "output"/);
  assert.equal(store.loadState().repairs.requests.r1.status, 'open');
  assert.equal(rp.storedMapping('x_hiring_posts', NEW_HOST), null);
});

test('an input break is held before payment with the service\'s fields, the rest of the round still runs, and a mapped input fixes it', async () => {
  const J = FX['job-postings'];
  const jneed = { kind: 'job_postings', text: J.step1.query, fields: { role: 'software engineer', place: 'New York City', remote: false, since: null, days: 3 }, query: {} };
  const changed = spec(NEW_HOST, [['searchPhrase', 'string', true], ['limit', 'integer']]);
  const f = fake({ answers: [changed, { ...J.step1.json, __text: J.step1.text }, { ...J.step2.envelope, result: JSON.stringify(J.step2.envelope.result) }] });
  const out = await run([xNeed, jneed], f);
  assert.deepEqual(out.map((r) => r.status), ['input_break', 'fulfilled'], 'the other need ran');
  assert.match(out[0].reason, /Nothing was paid/);
  assert.equal(f.calls().filter((c) => c.id).length, 1, 'only the known need was paid');
  const [req] = requests();
  assert.deepEqual(req.specFields.map((x) => [x.name, x.required]), [['searchPhrase', true], ['limit', false]]);
  assert.throws(() => rp.applyRepair(req.id, tmpFile({ input: { searchPhrase: '{nope}' } })), /\{nope\} is not an input of x_hiring_posts/);
  assert.throws(() => rp.applyRepair(req.id, tmpFile({ input: { limit: 20 } })), /missing searchPhrase/);
  assert.match(rp.applyRepair(req.id, tmpFile({ input: { searchPhrase: '{query}', limit: 20 } })).reread, /next run/);
  const g = fake({ answers: [changed, answer(NEW_HOST, SHAPE_A)] });
  const [next] = await run(xNeed, g);
  assert.equal(next.ok, true, next.reason);
  assert.equal(g.calls()[1].input.limit, 20);
  assert.match(g.calls()[1].input.searchPhrase, /hiring "software engineer"/);
  assert.equal(requests().length, 1);
});

test('the service refusing the input after the spec (needs_input) is an input break with nothing paid, and a second run does not write another request', async () => {
  const J = FX['job-postings'];
  const jneed = { kind: 'job_postings', text: J.step1.query, fields: { role: 'software engineer', place: 'New York City', remote: false, since: null, days: 3 }, query: {} };
  for (let i = 0; i < 2; i++) {
    const f = fake({ answers: [{ ...J.step1.json, __text: J.step1.text }, { status: 'needs_input', reason: 'the input has no field foo' }] });
    const [r] = await run(jneed, f);
    assert.equal(r.status, i === 0 ? 'input_break' : 'repair_pending', 'the second time it waits for the first request');
  }
  assert.equal(requests().length, 1, 'the same break is never reported twice');
  assert.equal(requests()[0].side, 'input');
});

test('a service whose terms allow immediate use only is never saved: the request holds the key names and types only', async () => {
  const E = FX['exa-search'];
  const need = { kind: 'web_search', tool: 'exa-search', text: null, fields: { role: 'software engineer', place: 'New York' }, query: {} };
  const f = fake({ answers: [{ ...E.step1.json, __text: E.step1.text }, answer('api.exa.ai', { pages: [{ href: 'https://jobs.lever.co/acme/1', blurb: 'PRIVATE SELLER TEXT' }] })] });
  const [r] = await run(need, f);
  assert.equal(r.status, 'output_break');
  assert.match(r.reason, /terms do not allow saving it/);
  const [req] = requests();
  assert.equal(req.rawPath, null);
  assert.equal(JSON.stringify(req).includes('PRIVATE SELLER TEXT'), false);
  assert.deepEqual(JSON.parse(req.shape), { pages: [{ href: 'string', blurb: 'string' }] });
  const res = rp.applyRepair(req.id, tmpFile({ output: { list: ['pages'], fields: { url: 'href', title: 'blurb' } } }));
  assert.match(res.checked, /not checked against an answer/);
});

test('J repair list, show and apply run through the command line', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'job-cli-'));
  assert.deepEqual(runJobs(d, ['repair', 'list']).json, { repairs: [] });
  assert.match(runJobs(d, ['repair', 'show', 'r9']).json.error, /no repair request r9/);
  assert.match(runJobs(d, ['repair', 'apply', 'r9']).json.error, /repair apply <id> --file/);
});

test('the reader: paths, the generic reader and the template builder', () => {
  assert.equal(reader.getPath({ a: { b: [{ c: 1 }, { c: 2 }] } }, 'a.b[].c').join(), '1,2');
  assert.equal(reader.getPath({}, '__proto__.x'), undefined);
  assert.deepEqual(reader.genericCanon('x_hiring_posts', SHAPE_A).output.list, ['hits']);
  assert.equal(reader.genericCanon('x_hiring_posts', SHAPE_B), null);
  const vars = reader.loopVars({ since: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10), role: 'a b' });
  assert.deepEqual(reader.buildInput({ q: '{role}[ since:{since}]', age: { byAge: ['d', 'w', 'm', 'y'] }, skip: '{missing}', kept: { if: { role: 'a b' }, then: 1, else: 2 } }, vars), { q: `a b since:${vars.since}`, age: 'w', kept: 1 });
});
