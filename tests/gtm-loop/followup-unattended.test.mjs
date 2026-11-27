import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKILL, runGtm, tmpHome } from './helpers/env.mjs';
import { fakeBins } from './helpers/fakebin.mjs';

const home = tmpHome();
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const d = await import('../../skills/gtm-loop/scripts/lib/dedupe.mjs');
const fu = await import('../../skills/gtm-loop/scripts/lib/followup.mjs');
const w = await import('../../skills/gtm-loop/scripts/lib/writing.mjs');
const o = await import('../../skills/gtm-loop/scripts/lib/outreach.mjs');
const em = await import('../../skills/gtm-loop/scripts/lib/email.mjs');
const consent = await import('../../skills/gtm-loop/scripts/lib/consent.mjs');
const prep = await import('../../skills/gtm-loop/scripts/lib/email-prep.mjs');
const wk = await import('../../skills/gtm-loop/scripts/lib/work.mjs');
const watcher = await import('../../skills/gtm-loop/scripts/lib/watcher.mjs');
const rel = await import('../../skills/gtm-loop/scripts/lib/release.mjs');
await import('../../skills/gtm-loop/scripts/lib/steps.mjs');
const q = await import('../../skills/gtm-loop/scripts/lib/questions.mjs');

const DAY = 86400000;
const T0 = Date.parse('2026-11-20T10:00:00Z');
const profile = { offer: { name: 'PayRouter', what: 'x', link: 'https://example.org/payrouter' }, sender: { name: 'Sam Rivera', company: 'PayCo', postal: '1 Main Street, Springfield, 00000, USA' } };
const rule = (days = 4) => ({ rules: [{ id: 'r1', effect: 'follow_up', value: String(days), words: 'follow up once after 4 days' }] });
const none = { rules: [] };
const ov = async () => (await import('../../skills/gtm-loop/scripts/lib/overlay.mjs')).loadOverlay();

// A reply sent on X on T0.
function sentOnX() {
  const s = store.emptyState();
  const r = d.addPosts(s, [{ url: 'https://x.com/dev_one/status/1900000000000000001', author: 'dev_one', source: 'x', text: 'Anyone know how to let my agent pay for APIs?' }]);
  const key = r.added[0];
  const l = s.leads[key];
  Object.assign(l, { status: 'contacted', channelProposed: 'x_reply', pick: { channel: 'x_reply', at: new Date(T0).toISOString() }, drafts: { x_reply: { channel: 'x_reply', text: 'We built PayRouter for this.' } }, quote: 'let my agent pay for APIs', line: 'asks' });
  d.markContacted(s, l.personKey, { channel: 'x_reply', leadKey: key, now: T0 });
  return { s, key };
}

test('with no follow_up rule nothing is ever due and no follow-up can start', () => {
  const { s, key } = sentOnX();
  assert.deepEqual(fu.followUpCandidates(s, none, T0 + 30 * DAY), []);
  assert.throws(() => fu.startFollowUp(s, key, none, T0 + 30 * DAY), /no follow_up rule/);
});

test('a follow-up is due only after the rule\'s days, with no reply and no opt-out, and it waits for the person (attended only)', () => {
  const { s, key } = sentOnX();
  assert.deepEqual(fu.followUpCandidates(s, rule(4), T0 + 3 * DAY), []);
  assert.deepEqual(fu.followUpCandidates(s, rule(4), T0 + 4 * DAY).map((l) => l.key), [key]);
  const item = fu.followUpItems({ state: s, overlay: rule(4), now: T0 + 4 * DAY })[0];
  assert.equal(item.reason, 'follow_up_due');
  assert.equal(item.waitsForPerson, true, 'it never wakes the model');
  fu.recordSocialReply(s, key, { now: T0 + 2 * DAY });
  assert.deepEqual(fu.followUpCandidates(s, rule(4), T0 + 9 * DAY), [], 'any reply ends it');
  const b = sentOnX();
  d.suppressPerson(b.s, b.s.leads[b.key].personKey, 'opt_out');
  assert.deepEqual(fu.followUpCandidates(b.s, rule(4), T0 + 9 * DAY), []);
  const c = sentOnX();
  c.s.leads[c.key].followUpSkipped = true;
  assert.deepEqual(fu.followUpCandidates(c.s, rule(4), T0 + 9 * DAY), []);
});

test('a follow-up is one lead of its own on the same channel, written with the first message as data, sent once, and never resets the first day', () => {
  const { s, key } = sentOnX();
  const NOW = T0 + 5 * DAY;
  const r = fu.startFollowUp(s, key, rule(4), NOW);
  assert.deepEqual(r, { key: `fu:${key}`, of: key, channel: 'x_reply' });
  const lead = s.leads[r.key];
  assert.equal(lead.status, 'reviewed');
  assert.deepEqual(w.offeredChannels(lead), ['x_reply'], 'only the channel of the first message');
  assert.throws(() => fu.startFollowUp(s, key, rule(4), NOW), /not due/, 'one follow-up per person');
  const { request } = w.buildRoundRequest({ state: s, profile, now: NOW });
  assert.match(request.prompt, /follow_up_of/);
  assert.match(request.prompt, /We built PayRouter for this\./);
  assert.match(request.prompt, /one short, polite follow-up/);
  const parsed = { leads: { [r.key]: { x_reply: { text: 'Quick nudge from PayRouter: still happy to help.' } } } };
  assert.deepEqual(w.applyWriteResult(s, parsed, { keys: [r.key], profile, now: NOW }).written, [r.key]);
  assert.deepEqual(o.pickLead(s, r.key, 'x_reply', NOW), { key: r.key, status: 'picked', channel: 'x_reply' });
  assert.ok(o.openPlan(s, r.key, NOW).url.includes('intent/post'));
  o.markSentSocial(s, r.key, NOW + 1000);
  const rec = d.contactedInfo(s, lead.personKey);
  assert.equal(rec.followUps, 1);
  assert.equal(rec.at, new Date(T0).toISOString(), 'the first contact\'s day stays');
  assert.equal(d.contactProblem(s, lead.personKey, { followUp: { days: 4 }, now: NOW + 9 * DAY }), 'already_contacted', 'never a second follow-up');
  assert.deepEqual(fu.followUpCandidates(s, rule(4), NOW + 20 * DAY), []);
});

test('a follow-up for a person who is not allowed to be contacted without the rule is refused for any other lead', () => {
  const { s, key } = sentOnX();
  const plain = { ...s.leads[key], key: 'plain', status: 'picked', followUp: undefined, pick: { channel: 'x_reply' } };
  s.leads.plain = plain;
  assert.throws(() => o.openPlan(s, 'plain', T0 + 20 * DAY), /refused: already_contacted/);
});

test('an email follow-up passes the same gates once, to the same address, with its own yes', () => {
  const s = store.emptyState();
  const p = d.resolvePerson(s, ['linkedin:pat-lee-123'], { name: 'Pat Lee' });
  p.country = 'US'; p.domain = 'acme.example';
  d.addEmail(p, 'pat@acme.example', 'lookup', 'valid');
  s.emails.connector = 'send';
  s.leads.L = { key: 'L', url: 'https://www.linkedin.com/in/pat-lee-123', source: 'people', kind: 'fit', author: 'Pat Lee', text: '', status: 'contacted', v: 1, personKey: p.key, links: [], warnings: [], channelProposed: 'email', pick: { channel: 'email', at: new Date(T0).toISOString() }, drafts: { email: { channel: 'email', subject: 'Paying for APIs', text: 'PayRouter lets an agent pay per call. Any ideas?' } }, firstSeen: 'x' };
  d.markContacted(s, p.key, { channel: 'email', leadKey: 'L', now: T0 });
  s.emails.sent['pat@acme.example'] = new Date(T0).toISOString();
  const NOW = T0 + 6 * DAY;
  const r = fu.startFollowUp(s, 'L', rule(4), NOW);
  const lead = s.leads[r.key];
  lead.drafts = { email: { channel: 'email', subject: 'Re: Paying for APIs', text: 'PayRouter again, one nudge.' } };
  lead.status = 'picked';
  lead.pick = { channel: 'email', at: new Date(NOW).toISOString() };
  const c = em.buildCandidate(s, lead, profile);
  em.approveEmail(s, lead, profile, { expectId: c.id, now: NOW });
  const next = em.nextEmail(s, { profile, overlay: none, now: NOW });
  assert.equal(next.handout.to, 'pat@acme.example');
  em.markSent(s, c.id, { messageId: 'm2', threadId: 't2', now: NOW });
  assert.equal(d.contactedInfo(s, p.key).followUps, 1);
  assert.equal(d.contactedInfo(s, p.key).at, new Date(T0).toISOString());
});

test('the follow-up questions fit the question tool, four to a call, and the CLI starts and skips them', () => {
  const s = store.emptyState();
  for (let i = 0; i < 5; i++) {
    const r = d.addPosts(s, [{ url: `https://x.com/u${i}/status/190000000000000${i}00`, author: `u${i}`, source: 'x', text: `post ${i} about agents, any ideas?` }]);
    const l = s.leads[r.added[0]];
    Object.assign(l, { status: 'contacted', pick: { channel: 'x_reply' }, drafts: { x_reply: { text: 'We built PayRouter' } } });
    d.markContacted(s, l.personKey, { channel: 'x_reply', leadKey: l.key, now: T0 });
  }
  const groups = fu.followUpQuestions(s, rule(4), T0 + 6 * DAY);
  assert.deepEqual(groups.map((g) => g.questions.length), [4, 1]);
  for (const g of groups) assert.deepEqual(q.validateAsk(g), []);
});

test('the CLI: a follow-up needs the rule, is attended only, and G replied ends it', () => {
  const G = (...a) => runGtm(home, a);
  const { s, key } = sentOnX();
  s.contacted = Object.fromEntries(Object.keys(s.contacted).map((k) => [k, { ...s.contacted[k], at: new Date(Date.now() - 6 * DAY).toISOString() }]));
  store.updateState((st) => { Object.assign(st, s); });
  assert.match(G('follow-up', 'start', key).json.error, /no follow_up rule/);
  assert.equal(G('rules', 'add', '--effect', 'follow_up', '--value', '4', '--words', 'follow up once after 4 days').code, 0);
  assert.deepEqual(G('follow-up', 'list').json.due.map((x) => x.key), [key]);
  assert.equal(G('follow-up', 'ask').json.groups.length, 1);
  assert.ok(G('work').json.items.some((i) => i.reason === 'follow_up_due' && i.waitsForPerson));
  store.updateState((st) => { st.batch = { mode: 'unattended', openedAt: new Date().toISOString(), touchedAt: new Date().toISOString() }; });
  for (const a of [['follow-up', 'start', key], ['replied', key], ['follow-up', 'list']]) assert.match(G(...a).json.error, /a batch is open/, a.join(' '));
  store.updateState((st) => { st.batch = null; });
  assert.equal(G('follow-up', 'start', key).json.key, `fu:${key}`);
  assert.equal(G('replied', key).json.replied, true);
  assert.deepEqual(G('follow-up', 'list').json.due, []);
});

// ---- unattended email ---------------------------------------------------------------------------------------------------

function draftedEmailLead({ published = 'asker@forum.example.org' } = {}) {
  const s = store.emptyState();
  const r = d.addPosts(s, [{ url: 'https://forum.example.org/t/1', author: '', source: 'web', text: `Anyone found a way for an agent to pay for APIs? Mail ${published}` }]);
  const key = r.added[0];
  Object.assign(s.leads[key], { status: 'drafted', channelProposed: 'email', quote: 'x', line: 'asks', drafts: { email: { channel: 'email', subject: 'Paying for APIs', text: 'PayRouter lets an agent pay per call.' } } });
  s.emails.connector = 'send';
  return { s, key };
}

test('unattended prep approves only under a current consent; the first unattended round is a dry run that sends nothing', async () => {
  const NOW = Date.now();
  const { s, key } = draftedEmailLead();
  store.updateState((st) => { Object.assign(st, s); st.tenjin.status = 'missing'; });
  const G = (...a) => runGtm(home, a);
  assert.equal(G('profile', 'set', '--json', JSON.stringify(profile)).code, 0);
  assert.deepEqual((await prep.prepUnattended({ profile, overlay: await ov(), now: NOW })), { skipped: 'no email consent' });
  assert.equal(G('consent', 'record', 'email').code, 0);
  const r = await prep.prepUnattended({ profile, overlay: await ov(), now: NOW });
  assert.deepEqual(r.approved, [key]);
  const st = store.loadState();
  assert.equal(st.leads[key].status, 'approved');
  assert.equal(Object.values(st.emails.drafts)[0].approvedBy, 'consent');
  // a woken turn: unattended, so a consent cannot be recorded and no person's yes is taken
  const w1 = G('work', '--commit', '--unattended');
  assert.ok(w1.json.items.some((i) => i.reason === 'email_due'));
  assert.match(G('consent', 'record', 'email').json.error, /a batch is open/);
  assert.match(G('ask', 'pick').json.error, /a batch is open/);
  const dry = G('email', 'next', '--unattended');
  assert.equal(dry.json.handout, null);
  assert.equal(dry.json.queue[0].reason, 'dry_run_recorded');
  G('email', 'next', '--unattended');
  assert.equal(store.loadState().consent.dryRun.records.length, 1, 'no duplicate record for the same email');
  assert.equal(store.loadState().leads[key].status, 'approved', 'nothing was sent');
  store.updateState((s2) => { s2.batch = null; });
  assert.equal(G('dryrun', 'confirm').code, 0);
  const real = G('email', 'next', '--unattended');
  assert.equal(real.json.handout.via, 'send');
  assert.match(real.json.handout.text, /Reply stop and I will not write again\./);
});

test('a change to the rules ends the consent, so a prepared email is not handed out as a send', async () => {
  const G = (...a) => runGtm(home, a);
  assert.equal(G('consent', 'status').json.dryRun, true);
  G('rules', 'add', '--effect', 'exclude_term', '--value', 'crypto', '--words', 'no crypto');
  assert.deepEqual([G('consent', 'status').json.email, G('consent', 'status').json.dryRun], [false, false]);
  assert.deepEqual(await prep.prepUnattended({ profile, overlay: await ov(), now: Date.now() }), { skipped: 'no email consent' });
});

test('a lead whose address is not published is not approved without a lookup; a suppressed one never is', async () => {
  const NOW = Date.now();
  const { s, key } = draftedEmailLead();
  const p = s.people[s.leads[key].personKey];
  p.emails = [];
  store.updateState((st) => { Object.assign(st, s); st.tenjin.status = 'missing'; st.consent.email = null; });
  const G = (...a) => runGtm(home, a);
  assert.equal(G('consent', 'record', 'email').code, 0);
  const r = await prep.prepUnattended({ profile, overlay: await ov(), now: NOW });
  assert.deepEqual(r.approved, []);
  assert.match(r.skipped[0].why, /no address to send to/);
});

// ---- the watcher and the notify line ------------------------------------------------------------------------------------

test('what waits for the person never wakes the model: one notify wake for a new waiting set, none after a push that was not sent', async () => {
  store.updateState((st) => { Object.assign(st, store.emptyState()); st.watcher = { sent: [], fingerprint: null, notify: null }; });
  const lines = [];
  const items = [];
  wk.registerCollector(({ state }) => (state.signals.counts.waiting ? [{ key: 'waiting-demo', reason: 'approve_due', v: state.signals.counts.waiting, count: state.signals.counts.waiting, waitsForPerson: true }] : []));
  store.applyOps([{ op: 'signal', kind: 'waiting' }]);
  const r = await watcher.runWatcher({ write: (l) => lines.push(l), maxTicks: 3, tickMs: 1, sleep: async () => {}, ctx: {} });
  assert.equal(r.reason, 'due');
  assert.match(lines.at(-1), /notify: 1 drafts waiting for your pick/);
  const G = (...a) => runGtm(home, a);
  assert.equal(G('notify', 'result', 'not_sent', '--reason', 'off').json.recorded, 'not_sent');
  store.applyOps([{ op: 'signal', kind: 'waiting' }]);
  const r2 = await watcher.runWatcher({ write: (l) => lines.push(l), maxTicks: 3, tickMs: 1, sleep: async () => {}, ctx: {} });
  assert.equal(r2.reason, 'max_ticks', 'a push that was not sent stops notify-only wakes');
  assert.match(G('notify', 'result', 'not_sent', '--reason', 'off').json.say || '', /open \/config/);
  assert.equal(G('notify', 'result', 'sent').json.recorded, 'sent');
  assert.equal(store.loadState().pushSent, true);
  assert.match(G('notify', 'result', 'maybe').json.error, /notify result/);
  void items;
});

// ---- the release check ------------------------------------------------------------------------------------------------

test('a failed install rolls back to the previous tag, and files that do not match the manifest hash roll back too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcopy-'));
  fs.cpSync(SKILL, dir, { recursive: true });
  const ran = [];
  const failing = async (cmd, args) => { ran.push(args.join(' ')); return { code: ran.length === 1 ? 1 : 0 }; };
  const r = await rel.applyUpdate({ tag: 'gtm-loop-v0.2.0', writingTag: 'writing-v0.1.0', change: 'x', runner: failing, skillDir: dir, previousTag: 'gtm-loop-v0.1.0', previousWriting: 'writing-v0.1.0', version: '0.2.0' });
  assert.equal(r.status, 'update_failed');
  assert.ok(ran[0].includes('BackTrackCo/tenjin-skills#gtm-loop-v0.2.0'));
  assert.ok(ran.some((a) => a.includes('#gtm-loop-v0.1.0')), 'the previous version is installed again');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...m, version: '0.2.0', gatesHash: 'stale' }));
  const bad = await rel.applyUpdate({ tag: 'gtm-loop-v0.2.0', writingTag: null, change: 'x', runner: async () => ({ code: 0 }), skillDir: dir, previousTag: 'gtm-loop-v0.1.0', version: '0.2.0' });
  assert.equal(bad.status, 'update_failed');
  assert.match(bad.line, /do not match the manifest hash/);
  rel.recordRelease(bad);
  assert.ok(store.loadState().held.some((h) => h.reason === 'update_failed'));
  const waiting = { status: 'update_waiting', tag: 'gtm-loop-v1.0.0', writingTag: 'writing-v0.1.0', change: 'big', line: 'x' };
  rel.recordRelease(waiting);
  assert.equal(store.loadState().update.waiting.tag, 'gtm-loop-v1.0.0');
  assert.ok(wk.itemsOf(store.loadState(), {}, { rules: [] }, Date.now()).some((i) => i.reason === 'update_waiting' && i.waitsForPerson));
  assert.match(runGtm(home, ['release', 'apply']).json.error || 'applied', /./);
  store.updateState((st) => { st.batch = { mode: 'attended', openedAt: new Date().toISOString(), touchedAt: new Date().toISOString() }; });
  assert.match(runGtm(home, ['release', 'apply']).json.error, /a batch is open/);
  store.updateState((st) => { st.batch = null; st.update.waiting = null; });
  assert.match(runGtm(home, ['release', 'apply']).json.error, /no update is waiting/);
});
void fakeBins;
