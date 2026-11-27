import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_LIB, demoApp, tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const em = await import(path.join(BASE_LIB, 'email.mjs'));
const NOW = Date.parse('2026-11-26T12:00:00Z');
const DAY = 86400000;
const rulesDecl = { effects: () => ['exclude_company'], lessonEffects: () => [], lessonDays: () => [1], lessonTemplates: {}, exempt: [], hashParts: () => ({}) };
const list = [
  { ref: 'a', to: 'Pat@Example.test', subject: 'Hello', text: 'Hi Pat Placeholder', employer: 'Acme Placeholder', role: 'Engineer', job: 'k1' },
  { ref: 'b', to: 'sam@example.test', subject: 'Hello', text: 'Hi Sam Placeholder', employer: 'Beta Placeholder', role: '', job: null, ownYesOnly: true },
];
const app = (cands = list, checks) => demoApp('alpha', { rules: rulesDecl, email: { candidates: () => cands, ...(checks ? { recipientChecks: checks } : {}) } });
const fresh = () => ({ consent: { email: null } });
const ctx = { profile: {}, overlay: { rules: [] } };

test('an app that declared no email candidates fails with a clear error', async () => {
  setApp(await demoApp('alpha', { rules: rulesDecl }));
  assert.throws(() => em.candidates({}), /has not declared its email candidates/);
});

test('candidates come from the app, each with an id from its address, subject and text, equal for the same address in any case', async () => {
  setApp(await app());
  const c = em.candidates({});
  assert.equal(c.length, 2);
  assert.match(c[0].id, /^[0-9a-f]{12}$/);
  setApp(await app([{ ...list[0], to: 'pat@example.test' }]));
  assert.equal(em.candidates({})[0].id, c[0].id);
  assert.equal(em.mailto({ to: 'a@b.test', subject: 'Hi there', text: 'x y' }), 'mailto:a@b.test?subject=Hi%20there&body=x%20y');
});

test('one handout at a time, only for an approved draft; a draft never added to the batch is named; the 30-minute guard holds', async () => {
  setApp(await app());
  const s = fresh();
  em.emailState(s).connector = 'send';
  assert.deepEqual(em.nextEmail(s, { ...ctx, now: NOW }).queue.map((q) => q.reason), ['not_in_batch', 'not_in_batch']);
  em.addBatch(s, NOW);
  assert.deepEqual(em.nextEmail(s, { ...ctx, now: NOW }).queue.map((q) => q.reason), ['not_approved', 'not_approved']);
  const [a] = em.pending(s);
  em.approve(s, [a.id], { now: NOW });
  const r = em.nextEmail(s, { ...ctx, now: NOW });
  assert.equal(r.handout.id, a.id);
  assert.equal(r.handout.via, 'send');
  assert.deepEqual(r.handout.attachments, []);
  assert.equal(em.nextEmail(s, { ...ctx, now: NOW + 60000 }).queue.find((q) => q.id === a.id).reason, 'handed_out');
  assert.throws(() => em.approve(s, ['nope']), /no pending draft/);
});

test('one email per address in 90 days, any of sent, drafted or shown counts, and a repeat is not an item that comes back', async () => {
  setApp(await app());
  const s = fresh();
  em.addBatch(s, NOW);
  const [a] = em.pending(s);
  em.approve(s, [a.id], { now: NOW });
  assert.equal(em.markSent(s, a.id, { how: 'drafted', now: NOW }).status, 'drafted');
  assert.throws(() => em.markSent(s, a.id, { how: 'nope' }), /how is sent, drafted or shown/);
  assert.throws(() => em.markSent(s, 'unknown'), /unknown draft/);
  assert.equal(em.recipientProblem(s, { to: 'PAT@example.test' }, ctx.overlay, ctx.profile, { now: NOW + 89 * DAY }), 'repeat_within_90_days');
  assert.equal(em.recipientProblem(s, { to: 'pat@example.test' }, ctx.overlay, ctx.profile, { now: NOW + 91 * DAY }), null);
  assert.equal(em.due(s, NOW).some((c) => c.id === a.id), false, 'done');
  assert.equal(em.pending(s).some((c) => c.id === a.id), false);
});

test('the app\'s own recipient checks run after the repeat rule, with the unattended flag', async () => {
  const seen = [];
  setApp(await app(list, (state, c, overlay, profile, o) => { seen.push(o.unattended); return c.employer === 'Acme Placeholder' ? 'excluded_company' : null; }));
  const s = fresh();
  em.addBatch(s, NOW);
  em.approve(s, em.pending(s).map((c) => c.id), { now: NOW });
  const r = em.nextEmail(s, { ...ctx, now: NOW });
  assert.equal(r.queue[0].reason, 'excluded_company');
  assert.equal(r.handout.to, 'sam@example.test');
  assert.deepEqual(seen, [false, false]);
});

test('under the email consent an unattended turn sends the app\'s ordinary candidates but never one that needs its own yes; a changed hash stops it', async () => {
  setApp(await app());
  const s = fresh();
  const profile = {};
  const overlay = { rules: [] };
  em.emailState(s).connector = 'send';
  em.addBatch(s, NOW);
  assert.equal(em.nextEmail(s, { profile, overlay, unattended: true, now: NOW }).handout, null, 'no consent: nothing goes');
  em.recordEmailConsent(s, profile, overlay, NOW);
  assert.equal(em.emailConsentCurrent(s, profile, overlay), true);
  const r = em.nextEmail(s, { profile, overlay, unattended: true, now: NOW });
  assert.equal(r.handout.to, 'Pat@Example.test');
  em.markSent(s, r.handout.id, { now: NOW });
  const again = em.nextEmail(s, { profile, overlay, unattended: true, now: NOW });
  assert.equal(again.handout, null);
  assert.deepEqual(again.queue.map((q) => q.reason), ['no_email_consent'], 'the one that needs its own yes waits');
  const [b] = em.pending(s);
  em.approve(s, [b.id], { now: NOW });
  assert.equal(em.nextEmail(s, { profile, overlay, unattended: true, now: NOW + DAY }).handout.to, 'sam@example.test', 'its own yes lets it go');
  setApp(await demoApp('alpha', { rules: { ...rulesDecl, hashParts: () => ({ changed: true }) }, email: { candidates: () => list } }));
  assert.equal(em.emailConsentCurrent(s, profile, overlay), false, 'a changed rules hash makes the consent stale');
});

test('a draft-only connector lets an unattended turn make drafts with no consent, and the approvals of a batch can skip the rest', async () => {
  setApp(await app());
  const s = fresh();
  em.emailState(s).connector = 'drafts';
  em.addBatch(s, NOW);
  const r = em.nextEmail(s, { profile: {}, overlay: { rules: [] }, unattended: true, now: NOW });
  assert.equal(r.handout.via, 'drafts');
  const t = fresh();
  em.addBatch(t, NOW);
  const [a] = em.pending(t);
  em.approve(t, [a.id], { skipRest: true, now: NOW });
  assert.deepEqual(em.pending(t).map((c) => c.id), [a.id], 'the approved one is pending, the other was skipped');
  assert.equal(em.addBatchPeek(t).length, 1);
});
