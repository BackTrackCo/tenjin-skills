import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fixture, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const router = await import('../../skills/job-search/scripts/lib/router.mjs');
const ing = await import('../../skills/job-search/scripts/lib/ingest.mjs');
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const sup = await import('../../skills/job-search/scripts/lib/suppliers/index.mjs');
const FAKE = path.join(import.meta.dirname, 'helpers', 'fake-tenjin.mjs');
const J = fixture('router/job-postings.json');
const need = { kind: 'job_postings', text: 'job postings for software engineer roles in Berlin, posted in the last 7 days', fields: { role: 'software engineer', place: 'Berlin', remote: false, since: null }, query: { role: 'software engineer', place: 'Berlin', remote: false, since: null, variant: null, round: 0 } };

// A `tenjin` on PATH that is the fake MCP server. Nothing here calls the real Tenjin.
function fake(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faketenjin-'));
  const sf = path.join(dir, 'script.json');
  const lf = path.join(dir, 'log.jsonl');
  fs.writeFileSync(sf, JSON.stringify(script));
  const bin = path.join(dir, 'tenjin');
  fs.writeFileSync(bin, `#!/bin/sh\nFAKE_SCRIPT="${sf}" FAKE_LOG="${lf}" exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const log = () => (fs.existsSync(lf) ? fs.readFileSync(lf, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { bin, log };
}
const client = (f, timeouts) => new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, ...timeouts } });

test('the need goes as {query} from text, then {id, input}; a fulfilled envelope becomes an ingest file with the result saved', async () => {
  const f = fake({ answers: [J.spec, J.fulfilled] });
  const [r] = await router.runRound([need], { client: client(f) });
  assert.equal(r.ok, true);
  assert.equal(r.cost, 'provider price 0.003 USD');
  const calls = f.log().filter((l) => l.call).map((l) => l.call);
  assert.deepEqual(Object.keys(calls[0]), ['query']);
  assert.match(calls[0].query, /^job postings for software engineer roles in Berlin/);
  assert.doesNotMatch(calls[0].query, /openwebninja|jsearch/i, 'the need names no seller');
  assert.deepEqual(Object.keys(calls[1]).sort(), ['id', 'input']);
  assert.equal(calls[1].id, J.spec.id, 'the offer id is read from the top level of the spec answer');
  assert.equal(calls[1].input.query, 'software engineer in Berlin');
  assert.equal(r.ingest.need, 'job_postings');
  assert.equal(r.ingest.status, 'fulfilled');
  assert.ok(fs.existsSync(r.ingest.fullResultPath), 'result saved to a file and passed as fullResultPath');
  assert.equal(JSON.parse(fs.readFileSync(r.ingest.fullResultPath, 'utf8')).data.jobs.length, 2);
  assert.equal(r.ingest.postings.length, 2);
  assert.deepEqual(r.ingest.postings[0].applyLinks.map((l) => l.publisher), ['LinkedIn', 'Acme careers']);
  assert.equal(r.ingest.postings[0].salary.min, 90000);
  assert.equal(r.ingest.postings[1].remote, true);
});

test('the adapter output passes the ingest schema and reaches the apply path', async () => {
  const f = fake({ answers: [J.spec, J.fulfilled] });
  const [r] = await router.runRound([need], { client: client(f) });
  store.updateState((s) => { Object.assign(s, store.emptyState()); });
  const fetch = async (url) => (url.includes('/boards/acme/jobs')
    ? { ok: true, status: 200, json: async () => ({ jobs: [{ id: 77, title: 'Software Engineer', company_name: 'Acme', location: { name: 'Berlin' }, first_published: '2026-11-20T00:00:00Z', content: '' }] }) }
    : { ok: false, status: 404, json: async () => ({}) });
  const out = await ing.ingest({ obj: r.ingest, state: store.loadState(), profile: { places: ['Berlin'], remote: true, includeOld: true }, overlay: { rules: [], lessons: [] }, fetch, now: Date.parse('2026-11-23T10:00:00Z') });
  assert.equal(out.held.length, 0);
  const jobs = Object.values(store.loadState().jobs);
  assert.ok(jobs.some((j) => j.employerPosting && j.employerPosting.url === 'https://boards.greenhouse.io/acme/jobs/77' && j.employerPosting.confidence === 'exact'));
});

test('only fulfilled delivers: every other status holds that search with its reason, and nothing is sent twice', async () => {
  for (const status of ['needs_approval', 'needs_input', 'unverified', 'failed', 'unpaid', 'blocked', 'running', 'native']) {
    const f = fake({ answers: [J.spec, { ...J.fulfilled, status, job: 'job-9' }] });
    const [r] = await router.runRound([need], { client: client(f) });
    assert.equal(r.ok, false, status);
    assert.equal(r.status, status);
    assert.match(r.reason, new RegExp(status));
    assert.equal(f.log().filter((l) => l.call).length, 2, `${status}: the run was sent once, never retried`);
  }
  const spec = fake({ answers: [{ status: 'needs_approval', nextStep: 'ask the person' }] });
  const [r] = await router.runRound([need], { client: client(spec) });
  assert.equal(r.status, 'needs_approval');
  assert.equal(spec.log().filter((l) => l.call).length, 1, 'a refusal at the first step sends nothing more');
});

test('an offer id only at the top level counts: a spec with offers[] or offer.id is not read, and a spec with no known supplier host, or an envelope from another supplier, holds only that search', async () => {
  const unknown = fake({ answers: [{ status: 'spec', id: 'o', nextStep: 'Request: GET https://someone-else.test/x' }] });
  const [a] = await router.runRound([need], { client: client(unknown) });
  assert.equal(a.status, 'no_adapter');
  assert.match(a.reason, /next attended turn runs this search as the Haiku step/);
  const mismatch = fake({ answers: [J.spec, { ...J.fulfilled, supplier: 'another.example.test' }] });
  const [b] = await router.runRound([need], { client: client(mismatch) });
  assert.equal(b.status, 'supplier_mismatch');
  const nested = fake({ answers: [{ status: 'spec', offers: [{ id: 'x' }], offer: { id: 'y' }, nextStep: J.spec.nextStep }] });
  assert.equal((await router.runRound([need], { client: client(nested) }))[0].status, 'no_adapter', 'offers[0].id and offer.id are not guessed');
  const bad = fake({ answers: [J.spec, { ...J.fulfilled, result: '{ not json' }] });
  assert.equal((await router.runRound([need], { client: client(bad) }))[0].status, 'parse_failure');
  const schema = fake({ answers: [J.spec, { ...J.fulfilled, result: JSON.stringify({ data: { nope: 1 } }) }] });
  const [c] = await router.runRound([need], { client: client(schema) });
  assert.equal(c.status, 'schema_failure');
  assert.match(c.reason, /no data\.jobs list/);
});

test('the supplier is picked by the host in the spec text, and nowhere else', () => {
  assert.equal(sup.pickSupplier('Request: GET https://x402.openwebninja.com/jsearch/search-v2', 'job_postings').host, 'x402.openwebninja.com');
  assert.equal(sup.pickSupplier('Supplier: other.test', 'job_postings'), null);
  assert.equal(sup.pickSupplier('Request: GET https://x402.openwebninja.com/jsearch/search-v2', 'x_hiring_posts'), null, 'no adapter for that need yet');
});

test('a timed-out run is not sent again; the process is stopped and no server stays running', async () => {
  const f = fake({ answers: [J.spec], hangOn: 1, ignoreClose: true });
  const t0 = Date.now();
  const [r] = await router.runRound([need, { ...need, kind: 'job_postings' }], { client: client(f, { run: 150, shutdown: 200 }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'timeout');
  const calls = f.log().filter((l) => l.call);
  assert.equal(calls.length, 3, 'the second need ran once, the timed-out run was not repeated');
  assert.ok(Date.now() - t0 < 5000);
  // the fake ignores a closed stdin, so it had to be killed
  const started = f.log().filter((l) => l.started);
  assert.equal(started.length, 1, 'one process per round');
  await new Promise((r2) => setTimeout(r2, 300));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const pid = started[0].pid;
  assert.equal(alive(pid), false, 'no fake server is left running');
});

test('one process per round; stdin closes at the end; with Tenjin missing or the wallet unavailable the searches hold', async () => {
  const f = fake({ answers: [J.spec, J.fulfilled, J.spec, J.fulfilled] });
  const out = await router.runRound([need, need], { client: client(f) });
  assert.deepEqual(out.map((o) => o.ok), [true, true]);
  assert.equal(f.log().filter((l) => l.started).length, 1);
  assert.equal(f.log().filter((l) => l.stdinClosed).length, 1);
  const gone = await router.runRound([need], { client: new router.RouterClient({ bin: null }) });
  assert.equal(gone[0].status, 'tenjin_missing');
  const dead = fake({ answers: [], exitOnInit: true });
  const [w] = await router.runRound([need], { client: client(dead) });
  assert.equal(w.status, 'wallet_unavailable');
});

test('router.mjs is the only file that spawns tenjin mcp', () => {
  const dir = path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'scripts');
  const files = [path.join(dir, 'jobs.mjs'), ...fs.readdirSync(path.join(dir, 'lib'), { recursive: true }).filter((f) => f.endsWith('.mjs')).map((f) => path.join(dir, 'lib', f))];
  const spawners = files.filter((f) => /\bmcp\b/.test(fs.readFileSync(f, 'utf8')) && /spawn/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(spawners.map((f) => path.basename(f)), ['router.mjs']);
  assert.equal(home.length > 0, true);
});
