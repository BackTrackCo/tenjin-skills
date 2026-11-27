import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGtm, tmpHome } from './helpers/env.mjs';
import { fake, runAnswer, seqClient, specAnswer } from './helpers/fake-router.mjs';

const home = tmpHome();
const router = await import('../../skills/gtm-loop/scripts/lib/router.mjs');
const lookup = await import('../../skills/gtm-loop/scripts/lib/lookup.mjs');
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const d = await import('../../skills/gtm-loop/scripts/lib/dedupe.mjs');
const em = await import('../../skills/gtm-loop/scripts/lib/email.mjs');

const NOW = Date.parse('2026-11-26T10:00:00Z');
const profile = { offer: { name: 'PayRouter', what: 'lets an agent pay per call', link: 'https://example.org/payrouter' }, sender: { name: 'Sam Rivera', company: 'PayCo', postal: '1 Main Street, Springfield, 00000, USA' } };
const ENRICH = (r) => ({ host: 'api.apollo.example', result: r });
const pair = (fx) => [specAnswer(fx.host), runAnswer(fx.host, fx.result)];

function fitLead({ country = 'US' } = {}) {
  store.updateState((s) => {
    Object.assign(s, store.emptyState());
    const p = d.resolvePerson(s, ['linkedin:pat-lee-123'], { name: 'Pat Lee' });
    p.country = country; p.domain = 'acme.example';
    s.leads.L = { key: 'L', url: 'https://www.linkedin.com/in/pat-lee-123', source: 'people', kind: 'fit', author: 'Pat Lee', text: '', status: 'picked', v: 1, personKey: p.key, links: [], warnings: [], channelProposed: 'email', pick: { channel: 'email', at: 'x' }, drafts: { email: { channel: 'email', subject: 'Paying for APIs', text: 'PayRouter lets an agent pay per call. Worth a look? Any ideas?' } }, firstSeen: 'x' };
    s.tenjin.status = 'ready';
  });
}
const seq = (...answers) => seqClient(router.RouterClient, router.TIMEOUTS, answers.map((a) => ({ answers: a })));

test('the enrichment and check adapters read their answers and refuse nonsense', async () => {
  const c = seq(pair(ENRICH({ person: { email: 'Pat@Acme.Example', email_status: 'verified' } })), pair(ENRICH({ data: { status: 'valid' } })));
  fitLead();
  const r = await lookup.resolveAddress({ leadKey: 'L', client: c, now: NOW });
  assert.equal(r.address, 'pat@acme.example');
  assert.equal(r.source, 'lookup');
  assert.equal(r.lookups, 2);
  const calls = c.fakes.flatMap((f) => f.calls().filter((x) => x.input).map((x) => x.input));
  assert.deepEqual(calls[0], { first_name: 'Pat', last_name: 'Lee', name: 'Pat Lee', domain: 'acme.example' });
  assert.deepEqual(calls[1], { email: 'pat@acme.example' });
  assert.equal(store.loadState().spend.length, 2);
  const bad = seq(pair(ENRICH({ email: 'not an address' })));
  fitLead();
  const held = await lookup.resolveAddress({ leadKey: 'L', client: bad, now: NOW });
  assert.equal(held.held.status, 'schema_failure');
});

test('a post lead with a published address needs no lookup, and a lookup that finds nothing is not paid for twice', async () => {
  store.updateState((s) => { Object.assign(s, store.emptyState()); const p = d.resolvePerson(s, ['x:a']); d.addEmail(p, 'a@acme.example', 'post'); s.leads.P = { key: 'P', personKey: p.key, kind: 'post', source: 'x', url: 'https://x.com/a/status/1', status: 'picked' }; });
  const none = fake({ answers: [] });
  const c = new router.RouterClient({ bin: none.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300 } });
  const r = await lookup.resolveAddress({ leadKey: 'P', client: c, now: NOW });
  assert.equal(r.source, 'post');
  assert.equal(r.lookups, 0);
  assert.equal(none.calls().length, 0);
  fitLead();
  const miss = seq(pair(ENRICH({ person: {} })));
  const r1 = await lookup.resolveAddress({ leadKey: 'L', client: miss, now: NOW });
  assert.equal(r1.problem, 'no_address');
  const none2 = fake({ answers: [] });
  const r2 = await lookup.resolveAddress({ leadKey: 'L', client: new router.RouterClient({ bin: none2.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300 } }), now: NOW });
  assert.equal(r2.lookups, 0, 'a miss is not looked up again');
  assert.equal(none2.calls().length, 0);
});

test('a found free-mail address is dropped; an address that is not valid never gets as far as a handout', async () => {
  fitLead();
  const free = seq(pair(ENRICH({ email: 'pat@gmail.com' })));
  const r = await lookup.resolveAddress({ leadKey: 'L', client: free, now: NOW });
  assert.equal(r.problem, 'free_mail_dropped');
  assert.equal(r.lookups, 1, 'no check is paid for a dropped address');
  assert.equal(store.loadState().people['linkedin:pat-lee-123'].emails.length, 0);
  fitLead();
  const risky = seq(pair(ENRICH({ email: 'pat@acme.example' })), pair(ENRICH({ status: 'accept_all' })));
  const r2 = await lookup.resolveAddress({ leadKey: 'L', client: risky, now: NOW });
  assert.equal(r2.problem, 'not_valid:accept_all');
  assert.throws(() => em.buildCandidate(store.loadState(), store.loadState().leads.L, profile), /no address to send to/);
});

test('a lead with no company domain or no name is not looked up and says why', async () => {
  fitLead();
  store.updateState((s) => { s.people['linkedin:pat-lee-123'].domain = null; });
  const r = await lookup.resolveAddress({ leadKey: 'L', client: new router.RouterClient({ bin: null }), now: NOW });
  assert.equal(r.problem, 'no_company_domain');
});

test('a held lookup is named and the lead is left alone', async () => {
  fitLead();
  const c = seq([specAnswer('api.apollo.example'), { status: 'needs_approval', reason: 'over the per-call limit' }]);
  const r = await lookup.resolveAddress({ leadKey: 'L', client: c, now: NOW });
  assert.equal(r.held.status, 'needs_approval');
  assert.ok(store.loadState().held.some((h) => /person_enrichment/.test(h.detail)));
});

test('the whole email path by the CLI: connector, resolve, the question, the yes, the handout, the result, the reply', async () => {
  fitLead({ country: 'US' });
  store.updateState((s) => { const p = s.people['linkedin:pat-lee-123']; d.addEmail(p, 'pat@acme.example', 'lookup', 'valid'); p.lookupDone = 'found'; });
  const G = (...a) => runGtm(home, a);
  assert.equal(G('profile', 'set', '--json', JSON.stringify(profile)).code, 0);
  assert.match(G('email', 'connector', 'smtp').json.error, /connector is one of/);
  assert.equal(G('email', 'connector', 'send').json.connector, 'send');
  store.updateState((st) => { st.leads.L.status = 'drafted'; });
  assert.match(G('email', 'resolve', 'L').json.error, /pick Email for this lead first/, 'the lookup runs only after the person picks Email');
  store.updateState((st) => { st.leads.L.status = 'picked'; });
  const res = G('email', 'resolve', 'L');
  assert.equal(res.json.ready, true);
  assert.equal(res.json.via, 'send');
  assert.match(res.json.text, /Reply stop and I will not write again\./);
  const ask = G('ask', 'email', 'L');
  assert.equal(ask.code, 0);
  assert.equal(ask.json.id, res.json.id);
  assert.ok(ask.json.questions[0].question.includes(res.json.text));
  assert.match(G('email', 'approve', 'L').json.error, /needs|--id/);
  assert.match(G('email', 'approve', 'L', '--id', 'badbadbadbad').json.error, /has changed/);
  assert.equal(G('email', 'approve', 'L', '--id', res.json.id).json.via, 'send');
  const w = G('work').json.items.map((i) => i.reason);
  assert.ok(w.includes('email_due'));
  const next = G('email', 'next').json;
  assert.equal(next.handout.to, 'pat@acme.example');
  assert.equal(G('email', 'next').json.handout, null, 'not handed out again');
  assert.deepEqual(G('work').json.items.filter((i) => i.reason === 'unknown_due').map((i) => i.count), [1]);
  assert.match(G('email', 'sent', next.handout.id, 'msg-1', '--thread', 'th-1').json.error, /unknown/);
  assert.equal(G('email', 'unknown', next.handout.id, 'sent').json.status, 'sent');
  assert.equal(G('state').json.counts.contacted, 1);
});

test('replies and suppression by the CLI: the thread list, an opt-out, and nothing more is written to that person', () => {
  const G = (...a) => runGtm(home, a);
  store.updateState((s) => { const x = Object.values(s.emails.drafts)[0]; x.threadId = 'th-1'; x.messageId = 'm1'; });
  const due = G('replies', 'due').json;
  assert.equal(due.threads.length, 1);
  assert.ok(G('work').json.items.some((i) => i.reason === 'replies_due'));
  const id = due.threads[0].id;
  assert.match(G('reply', id, 'angry').json.error, /kind is/);
  const r = G('reply', id, 'replied', '--text', 'Please unsubscribe me');
  assert.equal(r.json.kind, 'opt_out');
  assert.match(store.loadState().suppress.ids['linkedin:pat-lee-123'].reason, /opt_out/);
  assert.equal(G('replies', 'due').json.threads.length, 0);
  assert.equal(G('suppress', 'add', '--domain', 'gmail.com').code, 1);
  assert.equal(G('suppress', 'add', '--id', 'X:Someone', '--reason', 'person_said_so').json.suppressed, 'x:someone');
});

test('consent and the dry run by the CLI: the consent is refused without a postal address and inside a batch', () => {
  const G = (...a) => runGtm(home, a);
  assert.equal(G('consent', 'status').json.email, false);
  assert.equal(G('consent', 'record', 'email').json.rulesHash === undefined, false, 'recorded with its hash');
  assert.equal(G('consent', 'status').json.email, true);
  assert.match(G('dryrun', 'confirm').json.error, /no dry run/);
  store.updateState((s) => { s.batch = { mode: 'unattended', openedAt: new Date().toISOString(), touchedAt: new Date().toISOString() }; });
  for (const a of [['consent', 'record', 'email'], ['consent', 'revoke', 'email'], ['dryrun', 'confirm'], ['email', 'connector', 'none'], ['email', 'approve', 'L', '--id', 'x'], ['email', 'unknown', 'x', 'sent']]) assert.match(G(...a).json.error, /a batch is open/, a.join(' '));
  store.updateState((s) => { s.batch = null; });
  assert.equal(G('consent', 'revoke', 'email').json.revoked, 'email');
  G('profile', 'set', '--json', JSON.stringify({ sender: { postal: null } }));
});
void fs; void os; void path;
