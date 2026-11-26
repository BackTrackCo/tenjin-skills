import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const work = await import(`${S}work.mjs`);
const em = await import(`${S}email.mjs`);
const report = await import(`${S}report.mjs`);
const ing = await import(`${S}ingest.mjs`);
const watcher = await import(`${S}watcher.mjs`);
const lease = await import('../../skills/loop-base/lib/lease.mjs');

const NOW = Date.parse('2026-11-25T10:00:00Z');
const empty = { rules: [], lessons: [] };
const J = (...a) => runJobs(home, a);
const reset = (extra = {}, profile = {}) => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'rules.json'), { force: true });
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState(), extra); });
  J('profile', 'set', JSON.stringify(profile));
};
const lead = (i, over = {}) => ({ url: `hn:${i}`, key: `hn:${i}`, source: 'hn', channel: 'email', author: `poster${i}`, handle: null, email: `hire${i}@acme${i}.test`, emailFromPost: true, employer: `Acme${i}`, role: 'Engineer', place: '', excerpt: 'x', status: 'new', intro: { channel: 'email', subject: 'Hello', text: 'hi' }, ...over });
const ready = (n, over = {}) => mkJob({ key: `https://boards.greenhouse.io/acme/jobs/${n}`, status: 'apply_ready', company: `Co${n}`, fit: 90, verifiedAt: new Date(NOW).toISOString(), sheet: { hash: `h${n}`, passed: true, eeoMissing: false, unanswered: [], forbidden: [], fields: [] }, ...over });

// ---- 8 ------------------------------------------------------------------------------------------------------------
test('8: an item the model cannot progress wakes it once when its claim times out, not every twenty minutes', () => {
  const j = ready(1);
  reset({ jobs: { [j.key]: j }, approvals: { [j.key]: { sheetHash: 'h1' } } }, { applyMode: 'attended' });
  const items = (at) => work.workList({ now: at }).items;
  const item = items(NOW).find((i) => i.key === j.key);
  assert.ok(item);
  const claim = (at) => store.updateState((s) => { work.claimItems(s, [item], at); });
  const settle = (at) => store.updateState((s) => work.settleClaims(s, items(at), at));
  const tokenAt = (at) => items(at).find((i) => i.key === j.key).v;
  claim(NOW);
  const v0 = tokenAt(NOW);
  settle(NOW + 21 * 60000);
  const v1 = tokenAt(NOW + 21 * 60000);
  assert.notEqual(v1, v0, 'the first timeout wakes it once');
  claim(NOW + 21 * 60000);
  settle(NOW + 42 * 60000);
  assert.equal(tokenAt(NOW + 42 * 60000), v1, 'the second timeout changes nothing: no new wake');
  settle(NOW + 63 * 60000);
  assert.equal(tokenAt(NOW + 63 * 60000), v1);
});

test('8: an approved job with no Chrome tools, an auto mode with no consent, and a repeat email draft do not wake the model', () => {
  const j = ready(2, { noChromeTools: true });
  reset({ jobs: { [j.key]: j }, approvals: { [j.key]: { sheetHash: 'h2' } } }, { applyMode: 'attended' });
  assert.equal(work.workList({ now: NOW }).items.find((i) => i.key === j.key).waitsForPerson, true);
  const k = ready(3);
  reset({ jobs: { [k.key]: k } }, { applyMode: 'auto_write', unattended: { roles: ['e'], places: ['x'], minScore: 0, hosts: ['*'] } });
  assert.equal(work.workList({ now: NOW }).items.find((i) => i.key === k.key).waitsForPerson, true, 'no consent');
  // a second draft to an address already approached: not due, and J leave email works for what is left
  reset({ leads: [lead(1)] });
  const [d] = J('email', 'batch').json.drafts;
  J('email', 'approve', d.id);
  J('email', 'sent', d.id, 'm1');
  store.updateState((s) => { s.leads.push(lead(9, { email: 'HIRE1@acme1.test', intro: { channel: 'email', subject: 'again', text: 'second' } })); });
  assert.equal(work.workList({ now: NOW }).items.some((i) => i.reason === 'email_due'), false, 'a draft that can never be sent is not an item');
  store.updateState((s) => { s.leads.push(lead(2)); });
  assert.equal(work.workList({ now: NOW }).items.some((i) => i.reason === 'email_due'), true);
  const left = J('leave', 'email', '--reason', 'not_sending');
  assert.equal(left.code, 0, left.stdout);
  assert.equal(work.workList({ now: NOW }).items.some((i) => i.reason === 'email_due'), false);
  store.updateState((s) => { s.leads.push(lead(3)); });
  assert.equal(work.workList({ now: NOW }).items.some((i) => i.reason === 'email_due'), true, 'new drafts bring it back');
});

// ---- 38 -----------------------------------------------------------------------------------------------------------
test('38: a lead\'s email must be one of the addresses in the post, compared whole', async () => {
  const post = { url: 'hn:55', author: 'poster', postedAt: null, text: 'Email hiring@acme.com to apply', source: 'hn', status: 'new' };
  reset({ posts: [post] });
  const run = (email) => ing.ingest({ obj: { need: 'hn_hiring_posts', status: 'fulfilled', query: { role: 'e', place: '', remote: false, since: null }, postings: [], batch: ['hn:55'], outcomes: [{ url: 'hn:55', outcome: 'lead' }], leads: [{ url: 'hn:55', email }] }, state: store.loadState(), profile: {}, overlay: empty, fetch: async () => ({ ok: false, status: 404 }), now: NOW });
  for (const bad of ['g@acme.co', 'ring@acme.com']) {
    const r = await run(bad);
    assert.match(r.held[0] || '', /not word for word in the post/, bad);
  }
  const ok = await run('hiring@acme.com');
  assert.equal(ok.held.length, 0, JSON.stringify(ok.held));
  assert.equal(store.loadState().leads[0].emailFromPost, true);
});

// ---- 39, 62 -------------------------------------------------------------------------------------------------------
test('39: a draft handed out is not handed out again until it is marked sent or half an hour passes; 62: a draft never batched says so', () => {
  reset({ leads: [lead(1)] });
  const [d] = J('email', 'batch').json.drafts;
  J('email', 'approve', d.id);
  const first = J('email', 'next').json;
  assert.equal(first.handout.id, d.id);
  const second = J('email', 'next').json;
  assert.equal(second.handout, null);
  assert.deepEqual(second.queue, [{ id: d.id, reason: 'handed_out' }]);
  J('email', 'sent', d.id, 'm1');
  reset({ leads: [lead(4)] });
  const r = J('email', 'next', '--unattended').json;
  assert.deepEqual(r.queue.map((q) => q.reason), ['not_in_batch']);
});

// ---- 40 -----------------------------------------------------------------------------------------------------------
test('40: a notification held back by quiet hours is pushed once they end', async () => {
  const j = ready(5, { parked: { key: 'k', reasons: ['captcha'] } });
  reset({ jobs: { [j.key]: j } }, { applyMode: 'attended' });
  J('rules', 'add', '--effect', 'notify_quiet_hours', '--value', '22-7', '--words', 'quiet at night');
  const night = new Date(NOW); night.setHours(23, 30, 0, 0);
  const morning = new Date(night.getTime() + 9 * 3600000);
  const ov = { rules: [{ effect: 'notify_quiet_hours', value: '22-7' }] };
  lease.claimLease({ holder: 'w', now: night.getTime() });
  const w1 = work.workList({ now: night.getTime() });
  assert.equal(w1.notify, null);
  assert.equal(w1.notifyQuiet, true);
  const lines = (await watcher.tick({ holder: 'w', now: night.getTime(), seen: { sig: null } })).lines;
  assert.deepEqual(lines, [], 'nothing at night');
  const st = store.loadState();
  assert.equal(Boolean((st.watcher || {}).waiting && Object.keys(st.watcher.waiting).length), false, 'the stop is not saved as seen');
  const later = work.workList({ now: morning.getTime() });
  assert.match(later.notify, /stop/);
  void ov;
});

// ---- 41 -----------------------------------------------------------------------------------------------------------
test('41: an update line never wakes the session on its own, and the same line is kept once', () => {
  reset({ updateLines: ['Update check failed: offline'] });
  const w = work.waitingSet(store.loadState());
  assert.deepEqual(Object.keys(w).filter((k) => k.startsWith('update:')).length, 1);
  store.updateState((s) => { s.updateLines.push('Update check failed: offline'); });
  assert.equal(Object.keys(work.waitingSet(store.loadState())).filter((k) => k.startsWith('update:')).length, 1, 'a repeated line is one key');
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'scripts', 'lib', 'watcher.mjs'), 'utf8');
  assert.match(src, /!k\.startsWith\('update:'\)/);
});

// ---- 42, 43, 44 ---------------------------------------------------------------------------------------------------
test('42: the email wording follows the email consent under the real profile', () => {
  reset({ leads: [lead(1)] }, { unattended: { roles: ['e'], places: ['x'], minScore: 0, hosts: ['*'] } });
  const profile = JSON.parse(fs.readFileSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), 'utf8'));
  store.updateState((s) => em.recordEmailConsent(s, profile, empty));
  assert.match(work.notifyLine(store.loadState(), empty, NOW).line, /to send/);
  assert.match(report.renderReport(store.loadState(), empty, { now: NOW, profile }), /will be sent to the addresses the posters published/);
  assert.doesNotMatch(report.renderReport(store.loadState(), empty, { now: NOW, profile }), /none goes without it/);
});

test('43: reports and pushes say a yes is needed only when one is', () => {
  const j = ready(6);
  const view = (profile) => { reset({ jobs: { [j.key]: j } }, profile); return { text: report.renderReport(store.loadState(), empty, { now: NOW, profile }), short: report.renderReport(store.loadState(), empty, { now: NOW, profile, short: true }), push: work.notifyLine(store.loadState(), empty, NOW).line || '' }; };
  const attended = view({ applyMode: 'attended' });
  assert.match(attended.text, /Ready for your yes/);
  assert.match(attended.push, /waits for your yes/);
  for (const mode of ['fill_only', 'auto_write', 'auto_no_new']) {
    const v = view({ applyMode: mode });
    assert.doesNotMatch(v.text, /Ready for your yes|needs your yes/, mode);
    assert.doesNotMatch(v.short, /waiting for your yes/, mode);
    assert.doesNotMatch(v.push, /waits for your yes/, mode);
  }
});

test('44: a job a sweep closed is no longer listed as waiting on the person', () => {
  const j = ready(7, { status: 'closed', parked: { key: 'k', reasons: ['captcha'] }, fillReady: { at: new Date(NOW).toISOString() } });
  reset({ jobs: { [j.key]: j } });
  const text = report.renderReport(store.loadState(), empty, { now: NOW });
  assert.doesNotMatch(text, /Waiting on you|Filled, waiting for your submit \([1-9]/);
  assert.doesNotMatch(report.renderReport(store.loadState(), empty, { now: NOW, short: true }), /Waiting on you/);
});

// ---- 45 -----------------------------------------------------------------------------------------------------------
test('45: no "watcher: stopped" line while a round is open, so a restart is not asked for mid-round', () => {
  const j = ready(8, { status: 'new' });
  reset({ jobs: { [j.key]: j }, watcherEver: true });
  const before = J('work');
  assert.equal(before.json.watcher, 'stopped');
  J('work', '--commit');
  const during = J('profile', 'get');
  assert.equal(during.json.watcher, undefined, 'a round is open: start the watcher last');
  store.updateState((s) => { s.claims = {}; });
  assert.equal(J('profile', 'get').json.watcher, 'stopped');
});

// ---- 60 -----------------------------------------------------------------------------------------------------------
test('60: one over-long lead intro does not drop the round\'s other answers', () => {
  reset({ leads: [lead(1, { channel: 'x', handle: 'p', intro: null }), lead(2, { channel: 'x', handle: 'q', intro: null })] });
  const file = path.join(home, 'round.json');
  fs.writeFileSync(file, JSON.stringify({ answers: {}, leads: { 'hn:1': { subject: '', text: 'x'.repeat(400) }, 'hn:2': { subject: '', text: 'short enough' } }, intros: {} }));
  const r = J('write-result', '--round', '--result', file);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.leads, 1);
  assert.equal(r.json.refused, 1);
  assert.equal(store.loadState().leads.find((l) => l.url === 'hn:2').intro.text, 'short enough');
});

// ---- 61 -----------------------------------------------------------------------------------------------------------
test('61: leaving one item releases only its own claim', () => {
  const j = ready(9);
  reset({ jobs: { [j.key]: j }, contactsRequested: [j.key] }, { applyMode: 'attended' });
  store.updateState((s) => { s.claims = { [`${j.key}|apply_ready`]: { at: new Date().toISOString() }, [`${j.key}|contacts_requested`]: { at: new Date().toISOString() } }; });
  assert.equal(J('leave', `contacts:${j.key}`, '--reason', 'none_found').code, 0);
  assert.deepEqual(Object.keys(store.loadState().claims), [`${j.key}|apply_ready`]);
});

// ---- 63 -----------------------------------------------------------------------------------------------------------
test('63: the short report leaves the update lines unshown for the full report', () => {
  reset({ updateLines: ['Updated Job Search to 0.2.0.'] });
  const r = J('report');
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /Updated Job Search to/);
  const shown = Object.keys(store.loadState().shown || {}).filter((k) => k.startsWith('update:'));
  assert.deepEqual(shown, [], 'not marked shown');
  assert.match(J('report', '--all').stdout, /Updated Job Search to 0.2.0/);
});
