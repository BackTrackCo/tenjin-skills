import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './helpers/env.mjs';

tmpHome();
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const em = await import('../../skills/gtm-loop/scripts/lib/email.mjs');
const d = await import('../../skills/gtm-loop/scripts/lib/dedupe.mjs');
const consent = await import('../../skills/gtm-loop/scripts/lib/consent.mjs');
const q = await import('../../skills/gtm-loop/scripts/lib/questions.mjs');

const NOW = Date.parse('2026-11-26T10:00:00Z');
const profile = { offer: { name: 'PayRouter', what: 'x', link: 'https://example.org/payrouter' }, sender: { name: 'Sam Rivera', company: 'PayCo', postal: '1 Main Street, Springfield, 00000, USA' } };
const overlay = { rules: [] };
const BODY = 'PayRouter lets an agent pay per call, no card sharing. Worth a look?';

// A picked email lead for a person, with a found address (or a published one).
function seed({ country = 'US', found = 'pat@acme.example', status = 'valid', published = null, kind = 'fit', domain = 'acme.example', connector = 'send' } = {}) {
  const s = store.emptyState();
  const p = d.resolvePerson(s, ['linkedin:pat-lee-123'], { name: 'Pat Lee' });
  p.country = country;
  p.domain = domain;
  if (found) d.addEmail(p, found, 'lookup', status);
  if (published) d.addEmail(p, published, 'post');
  const key = kind === 'fit' ? 'fit:acme.example:pat-lee-123' : 'https://x.com/i/status/1900000000000000001';
  s.leads[key] = { key, url: kind === 'fit' ? 'https://www.linkedin.com/in/pat-lee-123' : 'https://x.com/pat/status/1900000000000000001', source: kind === 'fit' ? 'people' : 'x', kind, author: 'Pat Lee', text: '', status: 'picked', v: 1, personKey: p.key, links: [], warnings: [], channelProposed: 'email', pick: { channel: 'email', at: new Date(NOW).toISOString() }, drafts: { email: { channel: 'email', subject: 'Paying for APIs', text: BODY } }, firstSeen: new Date(NOW).toISOString() };
  s.emails.connector = connector;
  return { s, key, p };
}
const approved = (o) => { const x = seed(o); const c = em.buildCandidate(x.s, x.s.leads[x.key], profile); em.approveEmail(x.s, x.s.leads[x.key], profile, { expectId: c.id, now: NOW }); return { ...x, c }; };

test('the footer is built by code, exact, with the sender, the postal address, the source and the stop line', () => {
  const { s, key } = seed({ country: 'US' });
  const c = em.buildCandidate(s, s.leads[key], profile);
  assert.equal(c.footer, [
    'Sam Rivera, PayCo',
    '1 Main Street, Springfield, 00000, USA',
    'I found you through a search for people in your role at your company. This is a one-time note about PayRouter.',
    'Reply stop and I will not write again.',
  ].join('\n'));
  assert.equal(c.text, `${BODY}\n\n--\n${c.footer}`);
  assert.equal(c.notice, false);
  const post = seed({ country: 'US', found: null, published: 'pat@gmail.com', kind: 'post' });
  assert.match(em.buildCandidate(post.s, post.s.leads[post.key], profile).footer, /I found you through your post on X: https:\/\/x\.com\/pat\/status\/1900000000000000001\. This is a one-time note about PayRouter\./);
});

test('no postal address, no sender name or no offer: no footer and no email', () => {
  const { s, key } = seed();
  assert.throws(() => em.buildCandidate(s, s.leads[key], { ...profile, sender: { name: 'Sam', company: 'PayCo' } }), /no postal address/);
  assert.throws(() => em.buildCandidate(s, s.leads[key], { ...profile, sender: { postal: 'x' } }), /no sender name/);
  assert.throws(() => em.buildCandidate(s, s.leads[key], { sender: profile.sender }), /no offer name/);
});

test('an EU, EEA, UK or unknown country adds where the data came from and how to object; other countries do not', () => {
  for (const [country, want] of [[null, true], ['FR', true], ['GB', true], ['NO', true], ['US', false], ['CA', false], ['AU', false], ['IN', false]]) {
    const { s, key } = seed({ country });
    const c = em.buildCandidate(s, s.leads[key], profile);
    assert.equal(c.notice, want, String(country));
    assert.equal(/To object, or to ask me to delete them, reply to this email\./.test(c.footer), want, String(country));
  }
  const post = seed({ country: null, found: null, published: 'pat@acme.example', kind: 'post' });
  assert.match(em.buildCandidate(post.s, post.s.leads[post.key], profile).footer, /Where I got your details: the address you published in your post\./);
  const found = seed({ country: null });
  assert.match(em.buildCandidate(found.s, found.s.leads[found.key], profile).footer, /Where I got your details: a work-email lookup and your public profile\./);
});

test('an address is used only when published, or found at the company domain and checked valid; a found free-mail address is dropped', () => {
  const run = (o) => { const x = seed(o); return em.addressFor(x.s, x.s.leads[x.key]); };
  assert.deepEqual(run({}), { addr: 'pat@acme.example', source: 'lookup', status: 'valid' });
  assert.equal(run({ found: 'pat@gmail.com' }).problem, 'free_mail_dropped');
  assert.equal(run({ status: 'accept_all' }).problem, 'not_valid:accept_all');
  assert.equal(run({ status: null }).problem, 'not_checked');
  assert.equal(run({ found: 'pat@other.example' }).problem, 'not_at_company_domain');
  assert.equal(run({ found: null }).problem, 'no_address');
  const pub = run({ found: null, published: 'pat@gmail.com', kind: 'post' });
  assert.deepEqual(pub, { addr: 'pat@gmail.com', source: 'post', status: null }, 'a published free-mail address is the lead\'s own');
});

test('the yes is for the exact email: a changed word is a different email, and a stale id is refused', () => {
  const { s, key } = seed();
  const c = em.buildCandidate(s, s.leads[key], profile);
  assert.equal(c.id, em.buildCandidate(s, s.leads[key], profile).id);
  assert.throws(() => em.approveEmail(s, s.leads[key], profile, { expectId: 'deadbeef0000' }), /has changed/);
  s.leads[key].drafts.email.text = `${BODY} Edited.`;
  assert.notEqual(em.buildCandidate(s, s.leads[key], profile).id, c.id);
  s.leads[key].drafts.email.text = BODY;
  const r = em.approveEmail(s, s.leads[key], profile, { expectId: c.id, now: NOW });
  assert.deepEqual(r, { id: c.id, to: 'pat@acme.example', via: 'send' });
  assert.equal(s.leads[key].status, 'approved');
  assert.throws(() => em.approveEmail(s, s.leads[key], profile, { expectId: c.id }), /pick Email/, 'an approved lead is not approved twice');
});

test('approval refuses a person who is suppressed or already contacted, and a lead whose pick is not email', () => {
  const a = seed();
  d.markContacted(a.s, a.p.key, { channel: 'x_reply', leadKey: 'other' });
  assert.throws(() => em.approveEmail(a.s, a.s.leads[a.key], profile), /refused: already_contacted/);
  const b = seed();
  d.suppressPerson(b.s, b.p.key, 'opt_out');
  b.s.leads[b.key].status = 'picked';
  assert.throws(() => em.approveEmail(b.s, b.s.leads[b.key], profile), /refused: suppressed:opt_out/);
  const c = seed();
  c.s.leads[c.key].pick.channel = 'x_reply';
  assert.throws(() => em.approveEmail(c.s, c.s.leads[c.key], profile), /not email/);
});

test('nothing is handed out without a recorded yes; a yes is handed out once, exactly as approved', () => {
  const { s, key, c } = approved({});
  const none = seed();
  assert.equal(em.nextEmail(none.s, { profile, overlay, now: NOW }).handout, null, 'a picked lead with no approval is not handed out');
  const r = em.nextEmail(s, { profile, overlay, now: NOW });
  assert.equal(r.handout.id, c.id);
  assert.equal(r.handout.to, 'pat@acme.example');
  assert.equal(r.handout.subject, 'Paying for APIs');
  assert.equal(r.handout.text, c.text);
  assert.equal(r.handout.via, 'send');
  assert.match(r.handout.instruction, /G email sent/);
  assert.ok(r.handout.mailto.startsWith('mailto:pat@acme.example?subject='));
  assert.equal(s.emails.drafts[c.id].status, 'handed_out');
  void key;
});

test('a handout with no recorded result is never handed out again: it becomes unknown and the person says whether it went', () => {
  const { s, key, c } = approved({});
  em.nextEmail(s, { profile, overlay, now: NOW });
  const again = em.nextEmail(s, { profile, overlay, now: NOW + 3600000 });
  assert.equal(again.handout, null);
  assert.deepEqual(again.queue, [{ id: c.id, reason: 'unknown' }]);
  assert.equal(s.emails.drafts[c.id].status, 'unknown');
  assert.throws(() => em.markSent(s, c.id, { messageId: 'm1' }), /not handed out: record what happened/);
  assert.equal(em.nextEmail(s, { profile, overlay, now: NOW + 7200000 }).handout, null, 'still never handed out again');
  assert.deepEqual(em.resolveUnknown(s, c.id, 'sent', NOW + 8000000), { id: c.id, status: 'sent' });
  assert.equal(s.leads[key].status, 'contacted');
  assert.ok(s.contacted['linkedin:pat-lee-123']);
  const t = approved({});
  em.nextEmail(t.s, { profile, overlay, now: NOW });
  em.nextEmail(t.s, { profile, overlay, now: NOW });
  assert.equal(em.resolveUnknown(t.s, t.c.id, 'not_sent').status, 'failed');
  assert.equal(t.s.leads[t.key].status, 'picked', 'it needs a new yes');
  assert.throws(() => em.resolveUnknown(t.s, t.c.id, 'maybe'), /not unknown/);
});

test('a recorded result contacts the person on every channel, whatever the mode', () => {
  for (const [connector, how] of [['send', 'sent'], ['drafts', 'drafted'], ['none', 'shown']]) {
    const { s, key, c } = approved({ connector });
    const r = em.nextEmail(s, { profile, overlay, now: NOW });
    assert.equal(r.handout.via, { send: 'send', drafts: 'drafts', none: 'none' }[connector]);
    assert.equal(em.markSent(s, c.id, { messageId: 'm1', threadId: 't1', how, now: NOW }).status, how);
    assert.equal(s.leads[key].status, 'contacted');
    assert.ok(s.emails.sent['pat@acme.example']);
    assert.equal(d.contactProblem(s, s.leads[key].personKey), 'already_contacted');
  }
  assert.throws(() => em.markSent(approved({}).s, 'nope'), /unknown email/);
});

test('a found address in Germany, Austria, Canada or Australia is only ever a draft, never a send; a published one may send', () => {
  for (const country of ['DE', 'AT', 'CA', 'AU']) {
    const { s, c } = approved({ country });
    assert.equal(c.mustDraft, true, country);
    assert.equal(em.nextEmail(s, { profile, overlay, now: NOW }).handout.via, 'drafts', country);
  }
  const pub = approved({ country: 'DE', found: null, published: 'pat@acme.example', kind: 'post' });
  assert.equal(pub.c.mustDraft, false);
  assert.equal(em.nextEmail(pub.s, { profile, overlay, now: NOW }).handout.via, 'send');
  const fr = approved({ country: 'FR' });
  assert.equal(em.nextEmail(fr.s, { profile, overlay, now: NOW }).handout.via, 'send', 'EU gets the notice, not a draft');
});

test('every check runs again at handout: suppression, another contact, the postal address, the person\'s emails-per-day rule', () => {
  let x = approved({});
  d.suppressPerson(x.s, x.p.key, 'opt_out');
  let r = em.nextEmail(x.s, { profile, overlay, now: NOW });
  assert.equal(r.handout, null);
  assert.match(r.queue[0].reason, /^suppressed:opt_out/);
  assert.equal(x.s.emails.drafts[x.c.id].status, 'skipped');
  x = approved({});
  d.markContacted(x.s, x.p.key, { channel: 'x_reply', leadKey: 'other' });
  assert.equal(em.nextEmail(x.s, { profile, overlay, now: NOW }).queue[0].reason, 'already_contacted');
  x = approved({});
  assert.equal(em.nextEmail(x.s, { profile: { ...profile, sender: { name: 'Sam' } }, overlay, now: NOW }).queue[0].reason, 'no_postal_address');
  x = approved({});
  x.s.suppress.ids['email:pat@acme.example'] = { reason: 'bounce', at: 'x' };
  assert.match(em.nextEmail(x.s, { profile, overlay, now: NOW }).queue[0].reason, /^suppressed:bounce/);
  x = approved({});
  x.s.emails.log = [{ id: 'a', at: new Date(NOW - 3600000).toISOString() }, { id: 'b', at: new Date(NOW - 7200000).toISOString() }];
  assert.equal(em.nextEmail(x.s, { profile, overlay: { rules: [{ effect: 'emails_per_day', value: 2 }] }, now: NOW }).queue[0].reason, 'emails_per_day');
  assert.ok(em.nextEmail(x.s, { profile, overlay, now: NOW }).handout, 'with no rule there is no cap');
  x = approved({});
  x.s.people[x.p.key].emails[0].status = 'risky';
  assert.match(em.nextEmail(x.s, { profile, overlay, now: NOW }).queue[0].reason, /^address:not_valid/);
});

test('a domain suppression stops every person at that company at handout', () => {
  const x = approved({});
  d.suppressDomain(x.s, 'acme.example', 'company_opt_out');
  assert.match(em.nextEmail(x.s, { profile, overlay, now: NOW }).queue[0].reason, /^suppressed:company_opt_out/);
});

test('unattended: with no consent only drafts; with the consent and no dry run only a recorded dry run; with both, a send', () => {
  const x = approved({});
  const r1 = em.nextEmail(x.s, { profile, overlay, unattended: true, now: NOW });
  assert.equal(r1.handout.via, 'drafts', 'no consent: the model may only make a draft');
  const y = approved({});
  consent.recordEmailConsent(y.s, profile, overlay, NOW);
  const r2 = em.nextEmail(y.s, { profile, overlay, unattended: true, now: NOW });
  assert.equal(r2.handout, null);
  assert.deepEqual(r2.queue, [{ id: y.c.id, reason: 'dry_run_recorded' }]);
  assert.equal(y.s.consent.dryRun.records.length, 1);
  assert.equal(y.s.emails.drafts[y.c.id].status, 'approved', 'a dry run changes nothing');
  consent.confirmDryRun(y.s, profile, overlay, NOW);
  assert.equal(em.nextEmail(y.s, { profile, overlay, unattended: true, now: NOW }).handout.via, 'send');
});

test('the consent is bound to the sender and the rules: a change to either ends it, and so does the dry run', () => {
  const s = store.emptyState();
  consent.recordEmailConsent(s, profile, overlay, NOW);
  consent.recordDryRun(s, { id: 'x' });
  consent.confirmDryRun(s, profile, overlay, NOW);
  assert.equal(consent.emailConsentCurrent(s, profile, overlay), true);
  assert.equal(consent.dryRunDone(s, profile, overlay), true);
  const changed = { rules: [{ effect: 'exclude_domain', value: 'x.com' }] };
  assert.equal(consent.emailConsentCurrent(s, profile, changed), false);
  assert.equal(consent.dryRunDone(s, profile, changed), false);
  assert.equal(consent.emailConsentCurrent(s, { ...profile, sender: { ...profile.sender, postal: 'Elsewhere 2' } }, overlay), false);
  assert.equal(consent.emailConsentCurrent(s, profile, { rules: [{ effect: 'emails_per_day', value: 3 }] }), true, 'a cap only tightens');
  assert.throws(() => consent.recordEmailConsent(store.emptyState(), { offer: profile.offer, sender: { name: 'x' } }, overlay), /postal address/);
  assert.throws(() => consent.confirmDryRun(store.emptyState(), profile, overlay), /no dry run/);
  consent.revokeConsent(s);
  assert.equal(consent.emailConsentCurrent(s, profile, overlay), false);
});

test('the email question says the exact address, text, country and how it goes, and fits the question tool', () => {
  for (const [via, country, mustDraft] of [['send', 'US', false], ['drafts', 'DE', true], ['none', null, false]]) {
    const { s, key } = seed({ country });
    const cand = em.buildCandidate(s, s.leads[key], profile);
    const ask = q.emailQuestion({ cand: { ...cand, mustDraft }, via });
    assert.deepEqual(q.validateAsk(ask), [], via);
    const text = ask.questions[0].question;
    assert.ok(text.includes('pat@acme.example') && text.includes('Subject: Paying for APIs') && text.includes(cand.text));
    assert.match(text, country ? new RegExp(`in ${country}`) : /country is not known/);
    if (mustDraft) assert.match(text, /only ever a draft/);
  }
});

test('replies: only threads this skill sent are due, and only while young', () => {
  const { s, c } = approved({});
  em.nextEmail(s, { profile, overlay, now: NOW });
  em.markSent(s, c.id, { messageId: 'm1', threadId: 't1', how: 'sent', now: NOW });
  assert.deepEqual(em.repliesDue(s, NOW + 86400000).map((t) => t.threadId), ['t1']);
  assert.deepEqual(em.repliesDue(s, NOW + 31 * 86400000), []);
  const t = approved({ connector: 'drafts' });
  em.nextEmail(t.s, { profile, overlay, now: NOW });
  em.markSent(t.s, t.c.id, { how: 'drafted', now: NOW });
  assert.deepEqual(em.repliesDue(t.s, NOW + 1), [], 'a draft has no thread of ours');
});

test('any reply is replied and ends follow-ups; an opt-out word, a bounce or not interested suppresses the person for good', () => {
  const sent = () => { const x = approved({}); em.nextEmail(x.s, { profile, overlay, now: NOW }); em.markSent(x.s, x.c.id, { messageId: 'm', threadId: 't', now: NOW }); return x; };
  let x = sent();
  assert.deepEqual(em.recordReply(x.s, x.c.id, 'replied', { text: 'Sounds interesting, tell me more', now: NOW + 1000 }), { id: x.c.id, kind: 'replied' });
  assert.equal(x.s.leads[x.key].status, 'replied');
  assert.equal(x.s.contacted['linkedin:pat-lee-123'].replied, true);
  assert.equal(d.contactProblem(x.s, x.p.key, { followUp: { days: 1 }, now: NOW + 9 * 86400000 }), 'replied');
  assert.equal(em.repliesDue(x.s, NOW + 2000).length, 0);
  for (const text of ['Please STOP emailing me', 'unsubscribe', 'remove me from your list', 'not interested, thanks']) {
    x = sent();
    assert.equal(em.recordReply(x.s, x.c.id, 'replied', { text, now: NOW + 1000 }).kind, 'opt_out', text);
    assert.match(d.isSuppressed(x.s, x.p.key), /opt_out/);
  }
  x = sent();
  em.recordReply(x.s, x.c.id, 'bounce', { now: NOW + 1000 });
  assert.equal(x.s.suppress.ids['email:pat@acme.example'].reason, 'bounce');
  x = sent();
  em.recordReply(x.s, x.c.id, 'not_interested', { now: NOW + 1000 });
  assert.match(d.isSuppressed(x.s, x.p.key), /not_interested/);
  assert.throws(() => em.recordReply(x.s, x.c.id, 'angry'), /kind is/);
  assert.equal(em.hasOptOutWord('that is unstoppable'), false, 'a word is a word, not part of one');
  assert.equal(em.hasOptOutWord('I would stop by'), true, 'when in doubt, suppress');
});

test('a reply that asks to stop the company suppresses its domain, and suppression holds on every channel afterwards', () => {
  const x = (() => { const y = approved({}); em.nextEmail(y.s, { profile, overlay, now: NOW }); em.markSent(y.s, y.c.id, { messageId: 'm', threadId: 't', now: NOW }); return y; })();
  const r = em.recordReply(x.s, x.c.id, 'replied', { text: 'stop writing to anyone at our company', company: true, now: NOW + 1 });
  assert.equal(r.domain, 'acme.example');
  assert.equal(x.s.suppress.domains['acme.example'].reason, 'company_opt_out');
  const other = d.resolvePerson(x.s, ['x:colleague']);
  d.addEmail(other, 'colleague@acme.example', 'post');
  assert.match(d.isSuppressed(x.s, other.key), /company_opt_out/);
  const dropped = d.addPosts(x.s, [{ url: 'https://x.com/colleague/status/1900000000000000333', author: 'colleague', source: 'x', text: 'ask me at colleague@acme.example about agents paying Any ideas?' }]);
  assert.match(dropped.dropped[0].reason, /suppressed:company_opt_out/);
});
