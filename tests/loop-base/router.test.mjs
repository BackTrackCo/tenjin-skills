import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE_LIB, demoApp, tmpRoot } from './helpers/demo.mjs';

const root = tmpRoot();
const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const router = await import(path.join(BASE_LIB, 'router.mjs'));
const reg = await import(path.join(BASE_LIB, 'suppliers', 'registry.mjs'));
const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname), 'helpers', 'fake-tenjin.mjs');

// Two demo suppliers: one picked by the host its spec text names, one by catalog tool id.
const greet = { HOST: 'seller.example.test', KIND: 'greet', mapper: ({ who }) => { if (!who) throw new Error('no one to greet'); return { who }; }, adapter: (res) => ({ greetings: res.greetings }) };
const lookup = { HOST: null, TOOL: 'demo-lookup', KIND: 'lookup', ANY_HOST: true, NO_CACHE: true, mapper: ({ name }) => ({ name }), adapter: (res) => ({ found: res.found }) };
const table = reg.supplierTable([greet, lookup]);
const app = (extra = {}) => demoApp('alpha', { suppliers: table, ...extra });

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
const client = (f, timeouts) => new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 500, ...timeouts } });
const SPEC = { status: 'spec', id: 'offer-1', __text: 'POST https://seller.example.test/greet inputs: who' };
const OK = { status: 'fulfilled', supplier: 'seller.example.test', result: JSON.stringify({ greetings: ['hi'] }), cost: ['provider price 0.001 USD'] };
const need = { kind: 'greet', text: 'greet someone', fields: { who: 'Pat Placeholder' }, query: { who: 'Pat Placeholder' } };

test('a base module used with an app that declared no suppliers fails with a clear error', async () => {
  setApp(await demoApp('alpha'));
  assert.throws(() => reg.pickSupplier('x', 'greet'), /has not declared its suppliers/);
});

test('the app\'s own table picks the supplier: by the host the spec names, by catalog tool id, or by "any host"; nothing else', async () => {
  setApp(await app());
  assert.equal(reg.pickSupplier('POST https://SELLER.example.test/x', 'greet').kind, 'greet');
  assert.equal(reg.pickSupplier('POST https://other.test/x', 'greet'), null);
  assert.equal(reg.pickSupplier('POST https://seller.example.test/x', 'lookup').tool, 'demo-lookup', 'an any-host kind takes any spec');
  assert.equal(reg.pickTool('demo-lookup', 'lookup').noCache, true);
  assert.equal(reg.pickTool('demo-lookup', 'greet'), null);
  assert.equal(reg.pickTool('other', 'lookup'), null);
});

test('the need goes as {query} from text, then {id, input}; a fulfilled envelope becomes an ingest object with the result saved under the app\'s folder', async () => {
  setApp(await app());
  const f = fake({ answers: [SPEC, OK] });
  const [r] = await router.runRound([need], { client: client(f) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.cost, 'provider price 0.001 USD');
  const calls = f.log().filter((l) => l.call).map((l) => l.call);
  assert.deepEqual(Object.keys(calls[0]), ['query']);
  assert.deepEqual(Object.keys(calls[1]).sort(), ['id', 'input']);
  assert.deepEqual(calls[1], { id: 'offer-1', input: { who: 'Pat Placeholder' } });
  assert.deepEqual(r.ingest.greetings, ['hi']);
  assert.ok(r.ingest.fullResultPath.startsWith(path.join(root, 'alpha', 'results')));
  assert.equal(JSON.parse(fs.readFileSync(r.ingest.fullResultPath, 'utf8')).greetings[0], 'hi');
  assert.equal(f.log().find((l) => l.init).init.name, 'alpha', 'the client names the app');
});

test('a need that names a catalog tool asks {tool}, and a supplier that must not be kept is never saved', async () => {
  setApp(await app());
  const f = fake({ answers: [{ status: 'spec', id: 'offer-2', __text: 'any' }, { status: 'fulfilled', supplier: 'whoever.test', result: { found: true } }] });
  const [r] = await router.runRound([{ kind: 'lookup', tool: 'demo-lookup', text: null, fields: { name: 'Acme Placeholder' }, query: null }], { client: client(f) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(f.log().filter((l) => l.call).map((l) => l.call)[0], { tool: 'demo-lookup' });
  assert.equal(r.ingest.fullResultPath, null);
  assert.deepEqual(r.ingest.found, true);
});

test('only fulfilled delivers: every other status holds with its reason, and the run is sent once', async () => {
  setApp(await app());
  for (const status of ['needs_approval', 'needs_input', 'unverified', 'failed', 'unpaid', 'blocked', 'running', 'native']) {
    const f = fake({ answers: [SPEC, { status, job: 'job-9' }] });
    const [r] = await router.runRound([need], { client: client(f, { collect: 40, poll: 10 }) });
    assert.equal(r.ok, false, status);
    assert.equal(r.status, status);
    assert.equal(f.log().filter((l) => l.call && !l.call.job).length, 2, `${status}: never retried`);
  }
});

test('an answer from a supplier host the spec did not name is refused, an unknown host holds as no_adapter, and a mapper that throws holds as no_input', async () => {
  setApp(await app());
  const [a] = await router.runRound([need], { client: client(fake({ answers: [SPEC, { ...OK, supplier: 'other.example.test' }] })) });
  assert.equal(a.status, 'supplier_mismatch');
  const [b] = await router.runRound([need], { client: client(fake({ answers: [{ status: 'spec', id: 'o', __text: 'POST https://nobody.test/x' }] })) });
  assert.equal(b.status, 'no_adapter');
  const [c] = await router.runRound([{ ...need, fields: {} }], { client: client(fake({ answers: [SPEC] })) });
  assert.equal(c.status, 'no_input');
  const [d] = await router.runRound([need], { client: client(fake({ answers: [SPEC, { ...OK, result: 'not json' }] })) });
  assert.equal(d.status, 'parse_failure');
  const [e] = await router.runRound([need], { client: client(fake({ answers: [SPEC, { ...OK, result: JSON.stringify({}) }] })) });
  assert.equal(e.status, 'fulfilled', 'this demo adapter accepts an empty list');
});

test('a dead wallet reports wallet_unavailable, a missing Tenjin reports tenjin_missing, and a timed-out run is not sent again', async () => {
  setApp(await app());
  const [w] = await router.runRound([need], { client: client(fake({ answers: [], exitOnInit: true })) });
  assert.equal(w.status, 'wallet_unavailable');
  const [m] = await router.runRound([need], { client: new router.RouterClient({ bin: null, timeouts: router.TIMEOUTS }) });
  assert.equal(m.status, 'tenjin_missing');
  const f = fake({ answers: [SPEC, OK], hangOn: 1 });
  const [t] = await router.runRound([need], { client: client(f, { run: 150 }) });
  assert.equal(t.status, 'timeout');
  assert.equal(f.log().filter((l) => l.call && l.call.id).length, 1, 'the paid run was sent once');
});

test('one process per round, and stdin closes at the end', async () => {
  setApp(await app());
  const f = fake({ answers: [SPEC, OK, SPEC, OK] });
  await router.runRound([need, need], { client: client(f) });
  assert.equal(f.log().filter((l) => l.started).length, 1);
  assert.ok(f.log().some((l) => l.stdinClosed));
});
