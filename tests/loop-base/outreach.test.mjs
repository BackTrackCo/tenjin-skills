import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_LIB, FIXTURES, tmpRoot } from './helpers/demo.mjs';

// The GTM-shaped demo app runs the whole frame: a signal comes in on a step, becomes an outreach draft, the approval question passes the
// validator, the send waits for its yes under the default "ask first", a follow-up comes due after the set days, and the wake line and the
// report say so.
const root = tmpRoot();
const { buildOutreach } = await import(path.join(FIXTURES, 'outreach', 'app.mjs'));
const incoming = [{ id: 's1', company: 'Acme Placeholder', person: 'Pat Placeholder', address: 'pat@example.test', text: 'Pat Placeholder says they are hiring a first sales hire' }];
const { appStore: store, email, q } = await buildOutreach({ skillDir: path.join(FIXTURES, 'outreach'), incoming });
const L = (f) => import(path.join(BASE_LIB, f));
const watcher = await L('watcher.mjs');
const lease = await L('lease.mjs');
const work = await L('work.mjs');
const report = await L('report.mjs');
const qs = await L('questions.mjs');
const rules = await L('rules.mjs');
const consent = await L('consent.mjs');
const T0 = Date.parse('2026-11-26T09:00:00Z');
const DAY = 86400000;
const ctx = (now) => ({ holder: 'h', now });

test('a signal comes in on a step and wakes the model once with the app\'s wake line; the draft that follows waits for the person, not the model', async () => {
  lease.claimLease({ holder: 'h', pid: process.pid, now: T0 });
  const first = await watcher.tick(ctx(T0));
  assert.deepEqual(first.lines, ['Outreach round: handle each item, then start O watch last. Due: 1 review_signal.']);
  assert.deepEqual((await watcher.tick(ctx(T0 + 1000))).lines, [], 'the same signal does not wake again');
  assert.equal(store.loadState().signals.s1.status, 'new');
  // the model's round: hand the item out, then turn the signal into a draft with ops
  store.updateState((s) => work.claimItems(s, [{ key: 's1', reason: 'review_signal', waitsForPerson: false }], T0));
  store.applyOps([{ op: 'draft', id: 's1', subject: 'A note about your first sales hire', text: 'Hi Pat Placeholder, I saw you are hiring your first sales hire. Could we talk?', at: new Date(T0).toISOString() }]);
  assert.equal(store.loadState().signals.s1.status, 'drafted');
  assert.equal(store.loadState().outreach.s1.status, 'drafted');
  assert.throws(() => store.applyOps([{ op: 'draft', id: 's1', subject: 'x', text: 'y' }]), /illegal transition drafted -> drafted \(signal\)/, 'two kinds in one app: the refusal names its kind');
});

test('the approval question passes the validator, and the send waits for its yes under the default: sends ask first', async () => {
  const ask = { questions: [q('Outreach', 'Send this note to Pat Placeholder at Acme Placeholder?', [{ label: 'Yes, send it (Recommended)', description: 'It goes from your own email, once.' }, { label: 'Not this one', description: 'Drop the draft.' }])] };
  assert.deepEqual(qs.validateAsk(ask), []);
  assert.match(qs.validateAsk({ questions: [q('Outreach', 'Send it?', [{ label: 'Yes', description: 'a' }, { label: 'No', description: 'b' }])] })[0], /carries its marker/);
  const s = store.loadState();
  email.emailState(s).connector = 'send';
  store.updateState((st) => { st.emails = s.emails; });
  store.updateState((st) => email.addBatch(st, T0));
  let r = email.nextEmail(store.loadState(), { profile: {}, overlay: rules.loadOverlay(), now: T0 });
  assert.equal(r.handout, null);
  assert.deepEqual(r.queue.map((x) => x.reason), ['not_approved'], 'nothing goes without the person\'s yes');
  r = email.nextEmail(store.loadState(), { profile: {}, overlay: rules.loadOverlay(), unattended: true, now: T0 });
  assert.deepEqual(r.queue.map((x) => x.reason), ['no_email_consent'], 'an unattended turn sends nothing either');
  // the item that waits for the person never wakes the model, and its one push says so
  const tick = await watcher.tick(ctx(T0 + 2000));
  assert.deepEqual(tick.lines.length, 1, 'one wake carries the push');
  assert.match(tick.lines[0], /notify: 1 outreach draft waits for your yes/);
  assert.deepEqual((await watcher.tick(ctx(T0 + 3000))).lines, [], 'told once');
});

test('after the person\'s yes the send goes out once; a follow-up comes due after the set days and wakes the model', async () => {
  const id = Object.keys(store.loadState().emails.drafts)[0];
  store.updateState((st) => email.approve(st, [id], { now: T0 }));
  const h = email.nextEmail(store.loadState(), { profile: {}, overlay: rules.loadOverlay(), now: T0 + 5000 });
  assert.equal(h.handout.to, 'pat@example.test');
  assert.equal(h.handout.via, 'send');
  store.updateState((st) => { email.markSent(st, id, { now: T0 + 6000 }); });
  store.applyOps([{ op: 'sent', id: 's1', at: new Date(T0 + 6000).toISOString() }]);
  assert.equal(store.loadState().outreach.s1.status, 'sent');
  assert.throws(() => store.applyOps([{ op: 'sent', id: 's1', at: 'x' }]), /illegal transition sent -> sent \(outreach\)/);
  assert.equal(email.recipientProblem(store.loadState(), { to: 'pat@example.test' }, rules.loadOverlay(), {}, { now: T0 + 2 * DAY }), 'repeat_within_90_days', 'one email per address');
  // two days later: nothing; after the three set days: the follow-up is due
  store.updateState((st) => { st.claims = {}; });
  assert.deepEqual((await watcher.tick(ctx(T0 + 2 * DAY))).lines, []);
  const late = await watcher.tick(ctx(T0 + 3 * DAY + 7000));
  assert.deepEqual(late.lines, ['Outreach round: handle each item, then start O watch last. Due: 1 follow_up_due.']);
  assert.equal(store.loadState().wakes.length, 3, 'the signal, the push and the follow-up each woke once, and each wake is logged');
});

test('the report says so, with the shared sections: the person\'s rules and the consent changes', async () => {
  rules.addRule({ effect: 'daily_send_max', value: 5, words: 'at most five a day', date: '2026-11-26' });
  store.updateState((st) => { st.consentLog.push({ at: new Date(T0).toISOString(), what: 'email consent recorded' }); });
  const text = report.renderReport(store.loadState(), rules.loadOverlay(), { now: T0 + 3 * DAY });
  assert.match(text, /^# Outreach report, 2026-11-29/);
  assert.match(text, /0 new signals; 0 drafts waiting; 1 sent/);
  assert.match(text, /## Rules \(your words\)\n- 2026-11-26: "at most five a day" \(daily_send_max 5\) id /);
  assert.match(text, /## Consent changes \(check that each one was yours\)/);
  // the consent is off by default: sends ask first, and a looser limit later would need a new consent
  const s = store.loadState();
  assert.equal(s.consent.email, null);
  assert.deepEqual(consent.consentStatus(s, {}, rules.loadOverlay()), { ok: false, reason: 'no_consent' });
  assert.ok(root.length > 0);
});
