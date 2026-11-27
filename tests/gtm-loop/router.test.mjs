import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, tmpHome } from './helpers/env.mjs';
import { fake, runAnswer, specAnswer } from './helpers/fake-router.mjs';

tmpHome();
const router = await import('../../skills/gtm-loop/scripts/lib/router.mjs');
const X = fixture('router/x-posts.json');
const need = { kind: 'x_posts', text: 'Search recent public X posts for: agent pay for APIs.', fields: { query: 'agent pay for APIs', since: '2026-11-20' }, query: 'agent pay for APIs' };
const client = (f, timeouts) => new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 500, ...timeouts } });

test('the need goes as {query} text, then {id, input}; a fulfilled envelope becomes posts with the result saved', async () => {
  const f = fake({ answers: [specAnswer(X.host), runAnswer(X.host, X.result)] });
  const [r] = await router.runRound([need], { client: client(f) });
  assert.equal(r.ok, true);
  assert.equal(r.cost, 'provider price 0.005 USD');
  const calls = f.calls();
  assert.deepEqual(Object.keys(calls[0]), ['query']);
  assert.equal(calls[0].query, need.text);
  assert.doesNotMatch(calls[0].query, /glim|anyapi|exa/i, 'the need names no seller');
  assert.deepEqual(Object.keys(calls[1]).sort(), ['id', 'input']);
  assert.deepEqual(calls[1].input, X.input);
  assert.equal(r.ingest.posts.length, 2);
  assert.equal(r.ingest.posts[0].author, 'dev_one');
  assert.deepEqual(r.ingest.posts[1].links, ['https://example.org/notes']);
  assert.ok(fs.existsSync(r.ingest.fullResultPath));
});

test('only fulfilled delivers: every other status holds that need with its reason, and nothing is sent twice', async () => {
  for (const status of ['needs_approval', 'needs_input', 'unverified', 'failed', 'unpaid', 'blocked', 'running', 'native']) {
    const f = fake({ answers: [specAnswer(X.host), { ...runAnswer(X.host, X.result), status, job: 'job-9' }] });
    const [r] = await router.runRound([need], { client: client(f, { collect: 40, poll: 10 }) });
    assert.equal(r.ok, false, status);
    assert.equal(r.status, status);
    assert.equal(f.calls().filter((c) => !c.job).length, 2, `${status}: the run was sent once, never retried`);
    if (status === 'running') assert.match(r.reason, /job-9/);
  }
});

test('a supplier that differs from the spec holds; a spec with no known supplier holds as no_adapter', async () => {
  let f = fake({ answers: [specAnswer(X.host), runAnswer('other.example', X.result)] });
  let [r] = await router.runRound([need], { client: client(f) });
  assert.equal(r.status, 'supplier_mismatch');
  f = fake({ answers: [specAnswer('unknown.example')] });
  [r] = await router.runRound([need], { client: client(f) });
  assert.equal(r.status, 'no_adapter');
});

test('a timed-out run is never sent again, and a result that does not parse holds', async () => {
  const f = fake({ answers: [specAnswer(X.host), runAnswer(X.host, X.result)], hangOn: 1 });
  const [r] = await router.runRound([need], { client: client(f, { run: 80 }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'timeout');
  assert.equal(f.calls().length, 2);
  const g = fake({ answers: [specAnswer(X.host), { ...runAnswer(X.host, X.result), result: '{not json' }] });
  const [r2] = await router.runRound([need], { client: client(g) });
  assert.equal(r2.status, 'parse_failure');
});

test('a result that breaks the adapter shape holds as schema_failure', async () => {
  const f = fake({ answers: [specAnswer(X.host), runAnswer(X.host, { tweets: [{ url: '', text: '' }] })] });
  const [r] = await router.runRound([need], { client: client(f) });
  assert.equal(r.status, 'schema_failure');
});

test('the process is closed at the end: stdin closes and a stubborn process is killed after the shutdown time', async () => {
  const f = fake({ answers: [specAnswer(X.host), runAnswer(X.host, X.result)] });
  await router.runRound([need], { client: client(f) });
  assert.ok(f.log().some((l) => l.stdinClosed));
  const g = fake({ answers: [specAnswer(X.host), runAnswer(X.host, X.result)], ignoreClose: true });
  const t = Date.now();
  await router.runRound([need], { client: client(g) });
  assert.ok(Date.now() - t < 5000);
});

test('with no tenjin binary every need holds as tenjin_missing', async () => {
  const [r] = await router.runRound([need], { client: new router.RouterClient({ bin: null }) });
  assert.equal(r.status, 'tenjin_missing');
});
