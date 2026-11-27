import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_LIB, demoApp, tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const rules = await import(path.join(BASE_LIB, 'rules.mjs'));
const DAY = 86400000;
const vocab = {
  effects: () => ['exclude_company', 'daily_max', 'note'],
  check: (effect, value) => { if (effect === 'daily_max' && !(Number.isInteger(Number(value)) && Number(value) > 0)) throw new Error('daily_max is a whole number'); },
  lessonEffects: () => ['host_last'],
  lessonDays: () => [7, 14, 30],
  lessonTemplates: { host_last: (l) => `Things on ${l.subject} go last. Evidence: ${l.evidence.join(', ')}.` },
  exempt: ['daily_max', 'note'],
  hashParts: (profile) => ({ settings: profile.settings || null }),
};

test('an app that declared no rules vocabulary fails with a clear error', async () => {
  setApp(await demoApp('alpha'));
  assert.throws(() => rules.addRule({ effect: 'x', words: 'x' }), /has not declared its rules vocabulary/);
});

test('an effect outside the app\'s vocabulary is refused, the person\'s words are required, and the app checks the value', async () => {
  setApp(await demoApp('alpha', { rules: vocab }));
  assert.throws(() => rules.addRule({ effect: 'delete_all', words: 'x' }), /not in the vocabulary: delete_all/);
  assert.throws(() => rules.addRule({ effect: 'exclude_company', value: 'Acme Placeholder', words: '  ' }), /keeps the words the person said/);
  assert.throws(() => rules.addRule({ effect: 'daily_max', value: 'lots', words: 'lots a day' }), /whole number/);
  const r = rules.addRule({ effect: 'exclude_company', value: 'Acme Placeholder', words: 'never Acme Placeholder', date: '2026-11-26' });
  assert.deepEqual([r.effect, r.value, r.words, r.date], ['exclude_company', 'Acme Placeholder', 'never Acme Placeholder', '2026-11-26']);
  assert.equal(rules.loadOverlay().rules.length, 1);
  assert.equal(rules.ruleValue(rules.loadOverlay(), 'exclude_company'), 'Acme Placeholder');
  assert.equal(rules.ruleValue(rules.loadOverlay(), 'note'), undefined);
  assert.equal(rules.removeRule(r.id), 1);
  assert.equal(rules.loadOverlay().rules.length, 0);
});

test('each app keeps its own rules file', async () => {
  setApp(await demoApp('alpha', { rules: vocab }));
  rules.addRule({ effect: 'note', words: 'a note' });
  setApp(await demoApp('outreach', { rules: vocab }));
  assert.deepEqual(rules.loadOverlay(), { rules: [], lessons: [] });
  assert.ok(rules.rulesFile().includes(`${path.sep}outreach${path.sep}`));
});

test('the rules hash ignores the exempt effects, follows the others and the app\'s settings, and does not depend on order', async () => {
  setApp(await demoApp('alpha', { rules: vocab }));
  const o = (list) => ({ rules: list.map(([effect, value]) => ({ effect, value })) });
  const h = rules.rulesHash({ settings: { a: 1 } }, o([['exclude_company', 'A']]));
  assert.equal(rules.rulesHash({ settings: { a: 1 } }, o([['exclude_company', 'A'], ['daily_max', 3], ['note', 'x']])), h);
  assert.notEqual(rules.rulesHash({ settings: { a: 1 } }, o([['exclude_company', 'B']])), h);
  assert.notEqual(rules.rulesHash({ settings: { a: 2 } }, o([['exclude_company', 'A']])), h);
  assert.equal(rules.rulesHash({}, o([['exclude_company', 'A'], ['exclude_company', 'B']])), rules.rulesHash({}, o([['exclude_company', 'B'], ['exclude_company', 'A']])));
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('lessons only tighten, come from the app\'s template over evidence, escalate, and expire', async () => {
  setApp(await demoApp('alpha', { rules: vocab }));
  const t0 = Date.parse('2026-11-26T12:00:00Z');
  assert.throws(() => rules.addLesson({ effect: 'loosen_everything', subject: 's' }), /not tighten-only/);
  const a = rules.addLesson({ effect: 'host_last', subject: 'site.example.test', evidence: ['k1', 'k2'], now: t0 });
  assert.equal(a.text, 'Things on site.example.test go last. Evidence: k1, k2.');
  assert.equal(a.days, 7);
  assert.equal(rules.addLesson({ effect: 'host_last', subject: 'site.example.test', now: t0 + DAY }).id, a.id, 'a live lesson is not made twice');
  assert.equal(rules.activeLessons(rules.loadOverlay(), t0 + 6 * DAY).length, 1);
  assert.equal(rules.activeLessons(rules.loadOverlay(), t0 + 8 * DAY).length, 0, 'it expires');
  const b = rules.addLesson({ effect: 'host_last', subject: 'site.example.test', now: t0 + 8 * DAY });
  assert.equal(b.days, 14, 'the second time it lasts longer');
  const c = rules.addLesson({ effect: 'host_last', subject: 'site.example.test', now: t0 + 30 * DAY });
  assert.equal(c.days, 30);
  const d = rules.addLesson({ effect: 'host_last', subject: 'site.example.test', now: t0 + 80 * DAY });
  assert.equal(d.days, 30, 'the last length stays');
  const fileLessons = JSON.parse(fs.readFileSync(rules.rulesFile(), 'utf8')).lessons;
  assert.equal(fileLessons.length, 4);
  assert.equal(rules.removeRule(b.id), 0, 'removing a lesson id counts no rule');
  assert.equal(rules.loadOverlay().lessons.some((l) => l.id === b.id), false);
});
