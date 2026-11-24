import test from 'node:test';
import assert from 'node:assert/strict';
import { mkJob, tmpHome } from './helpers/env.mjs';

tmpHome();
const ov = await import('../../skills/job-search/scripts/lib/overlay.mjs');
const { runJobs } = await import('./helpers/env.mjs');
const DAY = 864e5;
const NOW = Date.parse('2026-11-23T12:00:00Z');

test('a rule keeps the words and the date', () => {
  const r = ov.addRule({ effect: 'exclude_company', value: 'Acme', words: 'never apply to Acme', date: '2026-11-23' });
  assert.equal(r.words, 'never apply to Acme');
  assert.equal(r.date, '2026-11-23');
  assert.throws(() => ov.addRule({ effect: 'exclude_company', value: 'x', words: ' ' }), /words/);
});

test('an effect outside the vocabulary is refused, including any that would grant consent', () => {
  for (const effect of ['unattended', 'unattended_consent', 'grant_consent', 'disable_guard', 'host_add']) assert.throws(() => ov.addRule({ effect, value: true, words: 'sure' }), /vocabulary/);
});

test('a loosening lesson is refused; tightening ones are written from a template with evidence ids', () => {
  for (const effect of ['add_host', 'unattended_on', 'relax_gate', 'raise_score_floor_down']) assert.throws(() => ov.addLesson({ effect, subject: 'x', evidence: ['e1'] }), /not tighten-only/);
  const l = ov.addLesson({ effect: 'host_attended', subject: 'greenhouse', evidence: ['k1', 'k2'], now: NOW });
  assert.match(l.text, /greenhouse/);
  assert.match(l.text, /k1, k2/);
});

test('lessons expire after 14 days and renew for 30, then 60', () => {
  const t0 = NOW;
  const a = ov.addLesson({ effect: 'drop_query', subject: 'q1', evidence: ['e'], now: t0 });
  assert.equal(a.days, 14);
  assert.equal(ov.addLesson({ effect: 'drop_query', subject: 'q1', evidence: ['e'], now: t0 + DAY }).id, a.id, 'a live lesson is not duplicated');
  const t1 = t0 + 15 * DAY;
  assert.equal(ov.activeLessons(ov.loadOverlay(), t1).some((l) => l.id === a.id), false);
  const b = ov.addLesson({ effect: 'drop_query', subject: 'q1', evidence: ['e'], now: t1 });
  assert.equal(b.days, 30);
  const c = ov.addLesson({ effect: 'drop_query', subject: 'q1', evidence: ['e'], now: t1 + 31 * DAY });
  assert.equal(c.days, 60);
  const d = ov.addLesson({ effect: 'drop_query', subject: 'q1', evidence: ['e'], now: t1 + 31 * DAY + 61 * DAY });
  assert.equal(d.days, 60, 'stays at the last step');
});

test('triggers: two captcha stops on a host in 7 days, a dry query, a broken form', () => {
  const state = { stops: [
    { key: 'a', kind: 'captcha', host: 'lever', at: new Date(NOW - DAY).toISOString() },
    { key: 'b', kind: 'captcha', host: 'lever', at: new Date(NOW - 2 * DAY).toISOString() },
    { key: 'c', kind: 'captcha', host: 'ashby', at: new Date(NOW - 20 * DAY).toISOString() },
    { key: 'd', kind: 'form_broke', host: 'greenhouse', company: 'Globex', at: new Date(NOW).toISOString() },
  ], queryYield: { 'staff go engineer': { dry: 5 }, other: { dry: 2 } } };
  const made = ov.deriveLessons(state, NOW).map((l) => `${l.effect}:${l.subject}`).sort();
  assert.deepEqual(made, ['company_attended:Globex', 'drop_query:staff go engineer', 'host_attended:lever', 'host_last:lever']);
});

test('rules take effect on jobs: exclusions, required terms, pay floor', () => {
  const overlay = { rules: [
    { id: '1', effect: 'exclude_company', value: 'Acme' }, { id: '2', effect: 'exclude_term', value: 'clearance' },
    { id: '3', effect: 'require_term', value: 'python' }, { id: '4', effect: 'min_pay', value: 150000 },
  ] };
  assert.ok(ov.applyRulesToJob(mkJob({ company: 'Acme Corp', desc: 'python' }), overlay).drops.some((d) => d.includes('exclude_company')));
  assert.ok(ov.applyRulesToJob(mkJob({ company: 'Globex', desc: 'needs clearance python' }), overlay).drops.some((d) => d.includes('exclude_term')));
  assert.ok(ov.applyRulesToJob(mkJob({ company: 'Globex', desc: 'java' }), overlay).drops.some((d) => d.includes('require_term')));
  assert.ok(ov.applyRulesToJob(mkJob({ company: 'Globex', desc: 'python', salary: '100000-120000 USD' }), overlay).drops.some((d) => d.includes('min_pay')));
  assert.deepEqual(ov.applyRulesToJob(mkJob({ company: 'Globex', desc: 'python', salary: null }), overlay).drops, [], 'no pay shown, no drop');
});

test('rules list and removal through the CLI; a bad effect exits 2', () => {
  const home = tmpHome();
  const add = runJobs(home, ['rules', 'add', '--effect', 'daily_max', '--value', '5', '--words', 'at most 5 a day']);
  assert.equal(add.json.value, 5);
  assert.equal(runJobs(home, ['rules']).json.length, 1);
  assert.equal(runJobs(home, ['rules', 'add', '--effect', 'unattended', '--value', 'true', '--words', 'go']).code, 2);
  assert.equal(runJobs(home, ['rules', 'remove', add.json.id]).json.removed, 1);
});
