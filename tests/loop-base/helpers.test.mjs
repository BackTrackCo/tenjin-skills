import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_LIB } from './helpers/demo.mjs';

const L = (f) => import(path.join(BASE_LIB, f));
const hash = await L('hash.mjs');
const names = await L('names.mjs');
const prices = await L('prices.mjs');
const sched = await L('schedule.mjs');
const runlog = await L('runlog.mjs');

test('sha is sha-256 in hex, and canonical text does not depend on key order', () => {
  assert.equal(hash.sha('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hash.canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), hash.canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.equal(hash.canonical({ a: 1 }), '{"a":1}');
});

test('normalizeUrl drops tracking, fragments and trailing slashes, keeps the job id and a link with no scheme', () => {
  assert.equal(hash.normalizeUrl('https://Jobs.Example.test/a/b/?utm_source=x&gh_jid=7#top'), 'https://jobs.example.test/a/b/?gh_jid=7');
  assert.equal(hash.normalizeUrl('https://x.test/job/application/'), 'https://x.test/job/application');
  assert.equal(hash.normalizeUrl('not a url '), 'not a url');
});

test('names match only when their word lists are equal after legal suffixes are dropped', () => {
  assert.deepEqual(names.normName('Scope Labs, Inc.'), ['scope', 'labs']);
  assert.equal(names.nameMatches('Vercel Inc', 'vercel'), true);
  assert.equal(names.nameMatches('Meow', 'Meow Wolf'), false);
  assert.equal(names.nameMatches('', ''), false);
});

test('prices round to a tenth of a cent and are written with the cent sign', () => {
  assert.equal(prices.fmt(2), '2¢');
  assert.equal(prices.fmt(0.34), '0.3¢');
  assert.equal(prices.fmt(1.25), '1.3¢');
  assert.equal(prices.tenths(0.4), 4);
});

test('a search is due near the end of its interval, the period starts at the right moment, and a follow-up comes after its days', () => {
  const H = 3600000;
  assert.equal(sched.searchIsDue({ lastAt: null, now: 0 }), true);
  assert.equal(sched.searchIsDue({ lastAt: 0, now: 10 * H, frequency: 'weekly' }), false);
  assert.equal(sched.searchIsDue({ lastAt: 0, now: 170 * H, frequency: 'weekly' }), true);
  assert.equal(sched.frequencyOf({ frequency: 'bogus' }), 'daily');
  const t = new Date(2026, 10, 25, 15, 30).getTime();
  assert.equal(new Date(sched.periodStart(t, 'twice_daily')).getHours(), 12);
  assert.equal(new Date(sched.periodStart(t, 'weekly')).getDay(), 1);
  assert.equal(sched.afterDays(0, 7, 6 * 24 * H), false);
  assert.equal(sched.afterDays(0, 7, 7 * 24 * H), true);
  assert.equal(sched.afterDays(NaN, 7, 1e15), false);
});

test('the run log keeps the last 300 wakes and runs', () => {
  const s = {};
  for (let i = 0; i < 305; i++) { runlog.logRun(s, 'k', 1, i); runlog.logWake(s, { n: i }, i % 2, i); }
  assert.equal(s.runs.length, 300);
  assert.equal(s.wakes.length, 300);
  assert.equal(s.runs[0].at, new Date(5).toISOString());
  assert.equal(s.wakes[299].notify, false);
});
