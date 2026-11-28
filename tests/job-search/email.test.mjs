import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL, mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const work = await import(`${S}work.mjs`);
const em = await import(`${S}email.mjs`);
const qs = await import(`${S}questions.mjs`);
const report = await import(`${S}report.mjs`);
const net = await import(`${S}net.mjs`);
const plat = await import(`${S}platforms.mjs`);
const ing = await import(`${S}ingest.mjs`);

const NOW = Date.parse('2026-11-25T10:00:00Z');
const empty = { rules: [], lessons: [] };
const reset = (extra = {}) => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'rules.json'), { force: true });
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState(), extra); });
};
const lead = (i, over = {}) => ({ url: `hn:${i}`, key: `hn:${i}`, source: 'hn', channel: 'email', author: `poster${i}`, handle: null, email: `hire${i}@acme${i}.test`, emailFromPost: true, employer: `Acme${i}`, role: 'Engineer', place: '', excerpt: 'x', status: 'new', intro: { channel: 'email', subject: `Hello ${i}`, text: `A short note ${i}.`, writtenAt: 'x' }, joinedJob: null, ...over });
const ids = () => em.pending(store.loadState()).map((c) => c.id);
const J = (...a) => runJobs(home, a);

test('only an address the poster published, found word for word by code, can be emailed', () => {
  const job = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/1', status: 'reviewed' });
  reset({ jobs: { [job.key]: job }, leads: [lead(1), lead(2, { emailFromPost: false })] });
  store.updateState((s) => {
    // a people-search contact with an email address, and a model op that tries to claim the flag
    s.contacts[job.key] = [{ name: 'Lee', title: 'CTO', sourceUrl: 'https://acme.test/team', how: 'lee@acme.test', cares: 'x', channel: 'email', email: 'lee@acme.test', intro: { channel: 'email', subject: 's', text: 't' } }];
  });
  store.applyOps([{ op: 'contact', key: job.key, name: 'Mo', title: '', sourceUrl: 'https://acme.test/t', how: 'mo@acme.test', cares: 'x', channel: 'email', email: 'mo@acme.test', emailFromPost: true }]);
  const refs = em.candidates(store.loadState()).map((c) => c.ref);
  assert.deepEqual(refs, ['lead:hn:1'], 'a team-page address, a forged flag and a lead without the flag stay drafts');
});

test('the author of an HN post becomes a contact whose address is flagged by code, from the post text', async () => {
  reset({ posts: [{ url: 'https://news.ycombinator.com/item?id=77', author: 'poster', source: 'hn', text: 'Acme hiring, mail jobs@acme.test https://job-boards.greenhouse.io/acme/jobs/9', status: 'new' }] });
  const gh = { jobs: [{ id: 9, title: 'Software Engineer', company_name: 'Acme', location: { name: 'Berlin' }, first_published: '2026-11-20T00:00:00Z', content: 'x' }] };
  const fetch = async (u) => ({ ok: true, status: 200, url: u, json: async () => gh, text: async () => '' });
  await ing.resolveBoardPosts({ profile: {}, overlay: empty, fetch, now: NOW });
  const c = Object.values(store.loadState().contacts)[0]?.[0];
  assert.ok(c, 'a contact');
  assert.equal(c.emailFromPost, true);
  assert.equal(c.email, 'jobs@acme.test');
});

test('drafts wait for one batch question: only the ticked ones go, one at a time, and each send is recorded', () => {
  reset({ leads: [lead(1), lead(2), lead(3)] });
  const b = J('email', 'batch').json;
  assert.equal(b.drafts.length, 3);
  assert.equal(b.askMode, true, 'the first batch asks the mode once');
  assert.equal(J('email', 'next').json.handout, null, 'nothing is handed out before a yes');
  assert.deepEqual(J('email', 'next').json.queue.map((q) => q.reason), ['not_approved', 'not_approved', 'not_approved']);
  const [a, bb] = b.drafts;
  assert.equal(J('email', 'approve', a.id, '--skip-rest').code, 0);
  const h = J('email', 'next').json.handout;
  assert.equal(h.id, a.id);
  assert.deepEqual([h.to, h.subject, h.attachments], ['hire1@acme1.test', 'Hello 1', []], 'no attachment');
  assert.match(h.mailto, /^mailto:hire1@acme1\.test\?subject=Hello%201&body=/);
  assert.equal(J('email', 'sent', a.id, 'msg-1').json.status, 'sent');
  assert.equal(J('email', 'next').json.handout, null, 'the unticked drafts were skipped and never go');
  const st = store.loadState();
  assert.equal(st.emails.drafts[bb.id].status, 'skipped');
  assert.equal(em.pending(st).length, 0);
  assert.equal(J('email', 'approve', 'nope').code, 2);
});

test('a second email to the same address within 90 days is refused; after 90 days it may go', () => {
  reset({ leads: [lead(1)] });
  const [d] = J('email', 'batch').json.drafts;
  J('email', 'approve', d.id);
  J('email', 'sent', d.id, 'm1');
  // a new draft to the same address
  store.updateState((s) => { s.leads.push(lead(9, { email: 'HIRE1@acme1.test', intro: { channel: 'email', subject: 'again', text: 'second' } })); });
  const [n] = J('email', 'batch').json.drafts;
  J('email', 'approve', n.id);
  const r = J('email', 'next').json;
  assert.equal(r.handout, null);
  assert.equal(r.queue[0].reason, 'repeat_within_90_days');
  const st = store.loadState();
  const late = em.nextEmail(JSON.parse(JSON.stringify(st)), { profile: {}, overlay: empty, now: Date.parse(st.emails.sent['hire1@acme1.test']) + 91 * 86400000 });
  assert.equal(late.handout.id, n.id);
});

test('unattended email needs its own consent: refused inside a batch, bound to the rules hash, revocable', () => {
  reset({ leads: [lead(1)] });
  const [d] = J('email', 'batch').json.drafts;
  assert.equal(J('email', 'connector', 'send').code, 0);
  assert.equal(J('email', 'next', '--unattended').json.queue[0].reason, 'no_email_consent');
  J('batch', 'open');
  assert.equal(J('consent', 'record', 'email').code, 4, 'refused inside a batch');
  assert.equal(J('email', 'approve', d.id).code, 4, 'a yes is refused inside a batch too');
  J('batch', 'close');
  assert.equal(J('consent', 'record', 'email').code, 0);
  assert.equal(store.loadState().emails.modeAsked !== null, true);
  const h = J('email', 'next', '--unattended').json.handout;
  assert.equal(h.id, d.id);
  assert.equal(h.via, 'send');
  assert.match(h.instruction, /connector's send tool/);
  // a rule that changes the hash makes the consent stale
  J('rules', 'add', '--effect', 'exclude_term', '--value', 'sales', '--words', 'no sales');
  assert.equal(J('email', 'next', '--unattended').json.queue[0].reason, 'no_email_consent');
  assert.equal(J('consent', 'record', 'email').code, 0);
  J('consent', 'revoke', 'email');
  assert.equal(store.loadState().consent.email, null);
  assert.equal(J('email', 'next', '--unattended').json.handout, null);
});

test('unattended sends keep the person\'s rules: an excluded company and a fit floor stop it', () => {
  const job = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/5', status: 'reviewed', company: 'Acme5', fit: 40 });
  reset({ jobs: { [job.key]: job }, contacts: { [job.key]: [{ name: 'Pat', title: '', sourceUrl: 'https://news.ycombinator.com/user?id=pat', how: 'pat@acme5.test', cares: 'x', channel: 'email', email: 'pat@acme5.test', emailFromPost: true, intro: { channel: 'email', subject: 's', text: 't' } }] }, leads: [lead(1, { employer: 'Blocked Co' })] });
  J('profile', 'set', JSON.stringify({ unattended: { minScore: 70 } }));
  J('email', 'batch');
  J('consent', 'record', 'email');
  J('rules', 'add', '--effect', 'exclude_company', '--value', 'Blocked Co', '--words', 'never');
  J('consent', 'record', 'email');
  const r = J('email', 'next', '--unattended').json;
  assert.equal(r.handout, null);
  assert.deepEqual(r.queue.map((q) => q.reason).sort(), ['below_score_floor', 'excluded_company']);
});

test('a connector that only makes drafts: the unattended run makes drafts with no consent and sends nothing; no connector: a mailto link', () => {
  reset({ leads: [lead(1), lead(2)] });
  J('email', 'batch');
  J('email', 'connector', 'drafts');
  const h = J('email', 'next', '--unattended').json.handout;
  assert.equal(h.via, 'drafts');
  assert.match(h.instruction, /draft tool; the person presses Send/);
  assert.equal(J('email', 'sent', h.id, '--drafted').json.status, 'drafted');
  assert.equal(store.loadState().emails.sent['hire1@acme1.test'] !== undefined, true, 'a drafted address counts for 90 days');
  J('email', 'connector', 'none');
  const second = J('email', 'next', '--unattended').json;
  assert.equal(second.handout, null, 'no connector: nothing is made without a yes');
  const [d2] = em.pending(store.loadState());
  J('email', 'approve', d2.id);
  const m = J('email', 'next').json.handout;
  assert.equal(m.via, 'none');
  assert.match(m.instruction, /mailto link/);
  assert.equal(J('email', 'sent', m.id, '--shown').json.status, 'shown');
});

test('the batch question fits the tool: 4 options per question, 16 drafts, then send all, none or the numbers', () => {
  const d = (n) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, to: `a${i}@x.test`, subject: `s${i}`, employer: 'E' }));
  const q16 = qs.emailBatchQuestion(d(16));
  assert.equal(q16.questions.length, 4);
  assert.deepEqual(qs.validateAsk(q16), []);
  assert.ok(q16.questions.every((q) => q.multiSelect === true && q.options.length <= 4));
  const q17 = qs.emailBatchQuestion(d(17));
  assert.deepEqual(q17.questions[0].options.map((o) => o.label), ['Yes, send all 17', 'Pick in groups of 16', 'None']);
  assert.deepEqual(qs.validateAsk(q17), []);
  assert.deepEqual(qs.validateAsk(qs.emailModeQuestion()), []);
  assert.match(qs.emailModeQuestion().questions[0].options[0].label, /Ask me each batch \(Recommended\)/);
  reset({ leads: [lead(1)] });
  const asked = J('ask', 'email').json;
  assert.equal(asked.questions[0].options[0].label, 'hire1@acme1.test');
  assert.ok(asked.questions[0].options.length >= 2, 'a lone draft still fits the tool\'s 2 to 4 options');
});

test('pending drafts are an item that waits for the person, until the email consent makes it work the model can do', () => {
  reset({ leads: [lead(1)] });
  const item = () => work.buildWorkList(store.loadState(), empty, NOW, {}).items.find((i) => i.reason === 'email_due');
  assert.equal(item().waitsForPerson, true);
  assert.match(work.notifyLine(store.loadState(), empty, NOW).line, /1 intro email draft to approve/);
  store.updateState((s) => em.recordEmailConsent(s, {}, empty));
  assert.equal(item().waitsForPerson, false);
  assert.match(report.renderReport(store.loadState(), empty, { now: NOW }), /1 intro email draft will be sent to the addresses the posters published \(you gave consent for that\)/, 'under the consent no yes is needed, and the report says so');
});

test('an X lead\'s DM is the person\'s: code gives the profile link and the text, and nothing opens or fetches x.com', async () => {
  const handle = em.handleIn('DM @some_poster on X');
  assert.equal(handle, 'some_poster');
  const d = em.dmLink(handle, 'Hi there');
  assert.deepEqual([d.profile, d.text, d.prefill], ['https://x.com/some_poster', 'Hi there', false]);
  reset({ leads: [lead(3, { channel: 'x', source: 'x', handle: 'some_poster', email: null, emailFromPost: false, intro: { channel: 'x', subject: null, text: 'Hi there' } })] });
  const text = report.renderReport(store.loadState(), empty, { now: NOW });
  assert.match(text, /Open https:\/\/x\.com\/some_poster, press Message, paste, and send it yourself: Hi there/);
  assert.equal(em.candidates(store.loadState()).length, 0, 'an X DM is never an email');
  for (const url of ['https://x.com/some_poster', 'https://twitter.com/i/status/1', 'https://mobile.x.com/a']) {
    assert.equal(plat.isNeverAutomated(url), true, url);
    await assert.rejects(net.guardedFetch(url, {}, async () => ({})), /never-automated host refused/, url);
  }
});

test('SKILL.md and the references: send only what J email next handed out; no connector tool name is hard-coded', () => {
  const skill = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(skill, /send only what `J email next` handed out/i);
  assert.match(skill, /except the deny list: LinkedIn, Indeed, Glassdoor, ZipRecruiter, Monster, SimplyHired, CareerBuilder, Dice, Wellfound/);
  assert.match(skill, /X \(x\.com, twitter\.com\)/);
  const contacts = fs.readFileSync(path.join(SKILL, 'references', 'contacts.md'), 'utf8');
  assert.match(contacts, /Gmail connector/);
  assert.match(contacts, /word for word/);
  for (const f of ['SKILL.md', ...fs.readdirSync(path.join(SKILL, 'references')).map((r) => `references/${r}`)]) {
    assert.doesNotMatch(fs.readFileSync(path.join(SKILL, f), 'utf8'), /mcp__claude_ai_Gmail|send_email|gmail_send/i, f);
  }
});

test('an address published word for word in an X post counts like one in an HN comment: channel email, the DM link shown, one draft', async () => {
  reset({ posts: [
    { url: 'https://x.com/poster_a/status/101', author: 'poster_a', source: 'x', text: 'We are hiring an engineer, mail jobs@acme-a.test', status: 'new' },
    { url: 'https://x.com/poster_b/status/102', author: 'poster_b', source: 'x', text: 'Hiring, DM me', status: 'new' },
    { url: 'https://x.com/poster_c/status/103', author: 'poster_c', source: 'x', text: 'Hiring: a@acme-c.test or b@acme-c.test', status: 'new' },
  ] });
  const obj = { need: 'hn_hiring_posts', status: 'fulfilled', query: { role: 'e', place: '', remote: false, since: null }, postings: [], batch: ['https://x.com/poster_a/status/101', 'https://x.com/poster_b/status/102', 'https://x.com/poster_c/status/103'], outcomes: [101, 102, 103].map((n) => ({ url: `https://x.com/poster_${'abc'[n - 101]}/status/${n}`, outcome: 'lead' })), leads: [{ url: 'https://x.com/poster_c/status/103', email: 'b@acme-c.test' }] };
  const out = await ing.ingest({ obj, state: store.loadState(), profile: {}, overlay: empty, fetch: async () => ({ ok: false }), now: NOW });
  assert.deepEqual(out.held, []);
  const [a, b, c] = store.loadState().leads;
  assert.deepEqual([a.channel, a.handle, a.email, a.emailFromPost, a.source], ['email', 'poster_a', 'jobs@acme-a.test', true, 'x'], 'a handle and an address: the channel is email');
  assert.deepEqual([b.channel, b.email], ['x', null], 'no address: the DM stays the person\'s');
  assert.deepEqual([c.channel, c.email], ['email', 'b@acme-c.test'], 'the model may pick one of two addresses, if it is in the post word for word');
  // a made-up address that is not in the post is refused
  store.updateState((s) => { s.posts = [{ url: 'https://x.com/poster_d/status/104', author: 'poster_d', source: 'x', text: 'Hiring', status: 'new' }]; });
  const bad = await ing.ingest({ obj: { ...obj, batch: ['https://x.com/poster_d/status/104'], outcomes: [{ url: 'https://x.com/poster_d/status/104', outcome: 'lead' }], leads: [{ url: 'https://x.com/poster_d/status/104', email: 'ceo@elsewhere.test' }] }, state: store.loadState(), profile: {}, overlay: empty, fetch: async () => ({ ok: false }), now: NOW });
  assert.match(bad.held[0], /not word for word in the post/);
  // the same checks as any email: a batch yes, 90 days, no attachment
  store.updateState((s) => { for (const l of s.leads) l.intro = { channel: l.channel, subject: l.channel === 'email' ? 'Hello' : null, text: 'A short note.', writtenAt: 'x' }; });
  assert.deepEqual(em.candidates(store.loadState()).map((c) => c.to).sort(), ['b@acme-c.test', 'jobs@acme-a.test'], 'the X lead without an address is never an email');
  const batch = J('email', 'batch').json;
  assert.equal(batch.drafts.length, 2, 'one draft per address, none for the DM link');
  assert.equal(J('email', 'next').json.handout, null, 'nothing goes before the batch yes');
  J('email', 'approve', batch.drafts[0].id);
  const h = J('email', 'next').json.handout;
  assert.deepEqual(h.attachments, []);
  J('email', 'sent', h.id, 'm1');
  store.updateState((s) => { s.leads.push({ ...s.leads[0], key: 'x:999', url: 'https://x.com/poster_a/status/999', intro: { channel: 'email', subject: 'Again', text: 'Another.' } }); });
  const again = J('email', 'batch').json.drafts.find((d) => d.subject === 'Again');
  J('email', 'approve', again.id);
  assert.equal(J('email', 'next').json.queue.find((q) => q.id === again.id).reason, 'repeat_within_90_days');
  const text = report.renderReport(store.loadState(), empty, { now: NOW });
  assert.match(text, /poster_a.*DM link, if you prefer to write there: https:\/\/x\.com\/poster_a/);
  assert.equal((text.match(/Intro \(email/g) || []).length >= 1, true);
});
