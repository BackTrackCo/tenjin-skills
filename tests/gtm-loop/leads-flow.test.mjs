import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGtm, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const tmpStore = () => storeMod;
const storeMod = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const tmp = (name, obj) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gtmflow-')), name); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
const G = (...args) => runGtm(home, args);

test('start: handles are saved on their own, the model is told what is missing, the start question is valid, the answers are recorded', () => {
  const s = G('start', 'status');
  assert.equal(s.json.done, false);
  assert.ok(s.json.missing[0].startsWith('your name'), 'the sender name is asked in the same first message');
  assert.equal(G('profile', 'set', '--json', JSON.stringify({ sender: { handles: { x: 'sam_thing', linkedin: 'SamThing' } } })).code, 0, 'a partial answer with no sender name is saved');
  assert.deepEqual(G('profile').json.profile.sender.handles, { x: 'sam_thing', linkedin: 'SamThing' });
  const offers = [{ id: 'main', name: 'Thing', what: 'lets an agent pay for APIs', who: 'founders and builders', link: 'https://example.org/thing', phrases: ['agent pay for APIs', 'pay per call for Claude'], subreddits: ['ClaudeAI', 'r/LocalLLaMA'] }];
  assert.equal(G('offers', 'set', '--json', JSON.stringify(offers)).code, 0);
  const m = G('start', 'status').json.missing;
  assert.ok(m.some((x) => x.startsWith('your name')));
  assert.ok(m.some((x) => x.startsWith('a buyer for "Thing"')), 'a buyer is proposed when only who it helps is given');
  assert.equal(G('profile', 'set', '--json', JSON.stringify({ sender: { name: 'Sam', company: 'Co', handles: { x: 'sam_thing' } }, offers: [{ ...offers[0], buyerAsked: true }] })).code, 0);
  assert.equal(G('profile').json.profile.sender.handles.linkedin, 'SamThing', 'handles merge, nothing is lost');
  const ask = G('ask', 'start');
  assert.equal(ask.code, 0);
  assert.equal(ask.json.questions.length, 3);
  assert.deepEqual(ask.json.questions.map((q) => q.header), ['Email', 'Search', 'Sources']);
  assert.ok(ask.json.questions.every((q) => q.options[0].label.endsWith('(Recommended)')));
  assert.match(G('start', 'record').json.error, /needs --email-mode/);
  assert.equal(G('start', 'record', '--email-mode', 'drafts', '--frequency', 'weekly', '--sources', 'free').json.recorded.sources.join(), 'hn,web');
  assert.equal(G('start', 'status').json.done, true);
  assert.match(G('start', 'record', '--sources', 'everything').json.error, /sources is all, social or free/);
  assert.match(G('phrases', 'set', 'a very long phrase that goes on and on and on like an article title for a reader').json.error, /words at most/);
});

test('the free path: ingest a post file, refuse a bad one with its problems, review through the file, and read the report', () => {
  const posts = [
    { url: 'https://forum.example.org/t/1', author: 'asker1', source: 'web', text: 'Has anyone found a way to let an agent pay for APIs on its own?', postedAt: '2026-11-25T10:00:00Z' },
    { url: 'https://x.com/asker2/status/1900000000000000100', author: 'asker2', source: 'x', text: 'I wish my agent could pay for APIs by itself.' },
    { url: 'https://x.com/sam_thing/status/1900000000000000200', author: 'sam_thing', source: 'x', text: 'my own post about agent pay for APIs' },
  ];
  const bad = G('ingest', '--file', tmp('bad.json', { phrase: 'nope', status: 'fulfilled', posts: [{ url: 'x' }] }));
  assert.equal(bad.code, 1);
  assert.match(bad.json.error, /rewrite it/);
  const ok = G('ingest', '--file', tmp('ok.json', { phrase: 'agent pay for APIs', status: 'fulfilled', posts }));
  assert.equal(ok.json.added, 2);
  assert.deepEqual(ok.json.dropped.map((d) => d.reason), ['own_post']);
  const next = G('review', 'next');
  assert.equal(next.json.count, 2);
  assert.equal(next.json.batches.length, 1);
  assert.equal(next.json.batches[0].leads[0].offer.name, 'Thing', 'each lead carries its own offer');
  next.json.leads = next.json.batches.flatMap((b) => b.leads);
  const refuse = G('review', 'ingest', '--file', tmp('r0.json', { reviews: [] }));
  assert.match(refuse.json.error, /reviews must be|has no review|handed out/);
  const reviews = next.json.leads.map((l) => ({ key: l.key, fit: 80, intent: 90, timing: 50, quote: l.source === 'x' ? 'my agent could pay for APIs' : 'let an agent pay for APIs', line: 'Asks for it', channel: l.source === 'x' ? 'x_reply' : 'email', keep: true }));
  const done = G('review', 'ingest', '--file', tmp('r1.json', { reviews }));
  assert.equal(done.json.kept.length, 2);
  const rep = G('report').json.text;
  assert.match(rep, /Reviewed: 2/);
  assert.match(rep, /"agent pay for APIs": 1 from web, 1 from x/);
  const st = G('state').json;
  assert.equal(st.counts.reviewed, 2);
});

test('the work list shows review_due for new leads, and the plan of the free step follows the chosen sources', () => {
  G('ingest', '--file', tmp('more.json', { phrase: 'pay per call for Claude', status: 'fulfilled', posts: [{ url: 'https://forum.example.org/t/9', source: 'web', text: 'Need pay per call for Claude, who has done it?' }] }));
  const w = G('work').json;
  assert.deepEqual(w.items.map((i) => i.reason).sort(), ['review_due', 'write_due'], 'two leads reviewed earlier wait for the writer');
  assert.equal(w.items.find((i) => i.reason === 'review_due').count, 1);
  const plan = G('search', 'plan').json;
  assert.equal(plan.queries.length, 2, 'Hacker News and the web were chosen: one web query per phrase, Hacker News runs in code');
  assert.deepEqual(plan.queries.map((q) => q.source), ['web', 'web']);
});

test('G search route refuses without Tenjin ready, and no command here runs the live router', () => {
  const r = G('search', 'route');
  assert.equal(r.code, 1);
  assert.match(r.json.error, /Tenjin is not ready/);
});

test('G work compacts old finished leads and keeps the suppression list and the contacted ledger', () => {
  const store = tmpStore();
  store.updateState((st) => {
    st.leads.old = { key: 'old', status: 'skipped', statusAt: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z', firstSeen: '2026-01-01T00:00:00Z', personKey: 'x:gone' };
    st.people['x:gone'] = { key: 'x:gone', ids: ['x:gone'], emails: [] };
    st.ids['x:gone'] = 'x:gone';
    st.suppress.ids['x:gone'] = { reason: 'opt_out', at: 'x' };
    st.contacted['x:gone'] = { at: '2026-01-01T00:00:00Z', channel: 'x_reply' };
  });
  G('work');
  const s = store.loadState();
  assert.equal(s.leads.old, undefined);
  assert.ok(s.suppress.ids['x:gone']);
  assert.ok(s.contacted['x:gone']);
});
