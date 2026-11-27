import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_LIB, demoApp, tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const consent = await import(path.join(BASE_LIB, 'consent.mjs'));
const NOW = Date.parse('2026-11-26T12:00:00Z');
const rulesDecl = { effects: () => ['daily_max', 'exclude_company'], lessonEffects: () => [], lessonDays: () => [1], lessonTemplates: {}, exempt: ['daily_max'], hashParts: (p) => ({ unattended: p.unattended || null }) };
const consents = {
  kinds: ['unattended', 'writing', 'email'],
  writingScope: 'demo_scope',
  problems: (p) => (p.unattended ? [] : ['the demo rules are not set']),
  limitsOf: (o) => ({ daily: Number((o.rules.find((r) => r.effect === 'daily_max') || {}).value) || null }),
  loosened: (was, now) => was.daily !== null && (now.daily === null || now.daily > was.daily),
};
const fresh = () => ({ consent: { unattended: null, writing: null, email: null, dryRun: { records: [], confirmedAt: null, rulesHash: null } } });
const profile = { unattended: { roles: ['x'] } };
const ov = (rules = []) => ({ rules });

test('an app that declared no consents fails with a clear error', async () => {
  setApp(await demoApp('alpha', { rules: rulesDecl }));
  assert.throws(() => consent.writingHash(''), /has not declared its consents/);
});

test('the consent needs the app\'s rules to be complete and the person\'s choice for optional writing; there is no default', async () => {
  setApp(await demoApp('alpha', { rules: rulesDecl, consents }));
  const s = fresh();
  assert.throws(() => consent.recordConsent(s, {}, ov(), NOW, 'skip'), /cannot record consent: the demo rules are not set/);
  assert.throws(() => consent.recordConsent(s, profile, ov(), NOW), /skip or wait/);
  assert.throws(() => consent.recordConsent(s, profile, ov(), NOW, 'maybe'), /skip or wait/);
  const c = consent.recordConsent(s, profile, ov([{ effect: 'daily_max', value: 5 }]), NOW, 'wait');
  assert.deepEqual([c.optionalWriting, c.limits, c.at], ['wait', { daily: 5 }, new Date(NOW).toISOString()]);
  assert.equal(consent.consentStatus(s, profile, ov([{ effect: 'daily_max', value: 5 }])).ok, true);
});

test('a changed rules hash or a looser limit needs a new consent; a tighter limit does not', async () => {
  setApp(await demoApp('alpha', { rules: rulesDecl, consents }));
  const s = fresh();
  assert.deepEqual(consent.consentStatus(s, profile, ov()), { ok: false, reason: 'no_consent' });
  consent.recordConsent(s, profile, ov([{ effect: 'daily_max', value: 5 }]), NOW, 'skip');
  assert.deepEqual(consent.consentStatus(s, profile, ov([{ effect: 'daily_max', value: 3 }])), { ok: true }, 'tighter');
  assert.deepEqual(consent.consentStatus(s, profile, ov([{ effect: 'daily_max', value: 9 }])), { ok: false, reason: 'rules_changed' }, 'looser');
  assert.deepEqual(consent.consentStatus(s, profile, ov()), { ok: false, reason: 'rules_changed' }, 'the limit removed');
  assert.deepEqual(consent.consentStatus(s, profile, ov([{ effect: 'daily_max', value: 5 }, { effect: 'exclude_company', value: 'A' }])), { ok: false, reason: 'rules_changed' }, 'a new rule changes the hash');
  assert.deepEqual(consent.consentStatus(s, { unattended: { roles: ['y'] } }, ov([{ effect: 'daily_max', value: 5 }])), { ok: false, reason: 'rules_changed' }, 'the app\'s settings are in the hash');
});

test('the dry run must be confirmed after a current consent, has records to review, and goes stale with the rules', async () => {
  setApp(await demoApp('alpha', { rules: rulesDecl, consents }));
  const s = fresh();
  const o = ov([{ effect: 'daily_max', value: 5 }]);
  assert.throws(() => consent.confirmDryRun(s, profile, o, NOW), /record the unattended consent first/);
  consent.recordConsent(s, profile, o, NOW, 'skip');
  assert.throws(() => consent.confirmDryRun(s, profile, o, NOW), /no records to review/);
  consent.recordDryRun(s, { key: 'k1' });
  assert.equal(consent.dryRunDone(s, profile, o), false);
  consent.confirmDryRun(s, profile, o, NOW);
  assert.equal(consent.dryRunDone(s, profile, o), true);
  assert.equal(consent.dryRunDone(s, profile, ov([{ effect: 'exclude_company', value: 'A' }])), false);
  assert.equal(s.consent.dryRun.records[0].submitted, false);
  consent.recordConsent(s, profile, o, NOW + 1, 'skip');
  assert.deepEqual(s.consent.dryRun, { records: [], confirmedAt: null, rulesHash: null }, 'a new consent starts a new dry run');
});

test('writing consent is bound to the app\'s scope and the person\'s writing rules, and each declared kind can be revoked', async () => {
  setApp(await demoApp('alpha', { rules: rulesDecl, consents }));
  const s = fresh();
  assert.equal(consent.writingConsentCurrent(s, 'rule one'), false);
  consent.recordWritingConsent(s, ' rule one ', NOW);
  assert.equal(consent.writingConsentCurrent(s, 'rule one'), true, 'white space around the rules does not matter');
  assert.equal(consent.writingConsentCurrent(s, 'rule two'), false, 'a changed rule makes it stale');
  setApp(await demoApp('outreach', { rules: rulesDecl, consents: { ...consents, writingScope: 'other_scope' } }));
  assert.equal(consent.writingConsentCurrent(s, 'rule one'), false, 'another scope is another consent');
  for (const kind of ['unattended', 'writing', 'email']) { s.consent[kind] = { x: 1 }; consent.revokeConsent(s, kind); assert.equal(s.consent[kind], null, kind); }
  assert.throws(() => consent.revokeConsent(s, 'dryRun'), /^Error: revoke unattended, writing or email$/);
});
