import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, tmpHome } from './helpers/env.mjs';
import { fake, runAnswer, specAnswer } from './helpers/fake-router.mjs';

tmpHome();
const router = await import('../../skills/gtm-loop/scripts/lib/router.mjs');
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
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
    assert.equal(r.status, status === 'needs_input' ? 'input_break' : status, 'needs_input is an input break: held, with a repair request');
    assert.equal(f.calls().filter((c) => !c.job).length, 2, `${status}: the run was sent once, never retried`);
    if (status === 'running') assert.match(r.reason, /job-9/);
  }
});

test('a seller the table does not know is read by the generic reader; one whose input fields cannot be filled is held before payment', async () => {
  let f = fake({ answers: [specAnswer(X.host), runAnswer('other.example', X.result)] });
  let [r] = await router.runRound([need], { client: client(f) });
  assert.equal(r.ok, true, 'the envelope names another seller: the parsed result decides, not the name');
  f = fake({ answers: [specAnswer('unknown.example')] });
  [r] = await router.runRound([need], { client: client(f) });
  assert.equal(r.status, 'input_break', 'no mapping and no input fields in the spec: held before any payment');
  assert.equal(f.calls().length, 1, 'only the free spec call went out');
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

test('a result that fails the check on the parsed answer holds as output_break', async () => {
  const f = fake({ answers: [specAnswer(X.host), runAnswer(X.host, { tweets: [{ url: '', text: '' }] })] });
  const [r] = await router.runRound([need], { client: client(f) });
  assert.equal(r.status, 'output_break');
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

test('concurrent runRound calls serialize on router.lock and reclaim stale dead-PID locks', async () => {
  store.updateState((s) => { s.repairs = { seq: 0, requests: {} }; });
  const events = [];
  const f1 = fake({ answers: [specAnswer(X.host), runAnswer(X.host, X.result)] });
  const f2 = fake({ answers: [specAnswer(X.host), runAnswer(X.host, X.result)] });
  const c1 = client(f1);
  const c2 = client(f2);
  const origStart1 = c1.start.bind(c1);
  const origClose1 = c1.close.bind(c1);
  const origStart2 = c2.start.bind(c2);
  const origClose2 = c2.close.bind(c2);
  c1.start = async () => { events.push('start1'); await origStart1(); await new Promise((r) => setTimeout(r, 80)); };
  c1.close = async () => { await origClose1(); events.push('close1'); };
  c2.start = async () => { events.push('start2'); await origStart2(); };
  c2.close = async () => { await origClose2(); events.push('close2'); };
  const [a, b] = await Promise.all([
    router.runRound([need], { client: c1 }),
    (async () => { await new Promise((r) => setTimeout(r, 15)); return router.runRound([need], { client: c2 }); })(),
  ]);
  assert.equal(a[0].ok, true);
  assert.equal(b[0].ok, true);
  assert.deepEqual(events, ['start1', 'close1', 'start2', 'close2'], 'second round waits until first closes its tenjin mcp');

  // Stale dead-PID lock is reclaimed immediately
  const lockFile = `${process.env.TENJIN_SKILLS_DIR}/router.lock`;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999999, token: 'dead', at: Date.now() }));
  const f3 = fake({ answers: [specAnswer(X.host), runAnswer(X.host, X.result)] });
  const [r3] = await router.runRound([need], { client: client(f3) });
  assert.equal(r3.ok, true);
  assert.equal(fs.existsSync(lockFile), false);
});

test('step-1 unpaid routing contention retries cleanly; step-2 paid run never retries', async () => {
  store.updateState((s) => { s.repairs = { seq: 0, requests: {} }; });
  const busy = { status: 'native', reason: 'Tenjin could not pay the routing fee in time for this call (another routing payment was in progress); the next call usually routes. Nothing was routed and no provider was paid.' };
  const f = fake({ answers: [busy, specAnswer(X.host), runAnswer(X.host, X.result)] });
  const [r] = await router.runRound([need], { client: client(f, { contentionRetry: 5 }) });
  assert.equal(r.ok, true);
  assert.equal(f.calls().length, 3, 'retried step 1 once after unpaid contention, then ran step 2 once');
});
