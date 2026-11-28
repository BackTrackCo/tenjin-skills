import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL, fixture, runGtm, tmpHome } from './helpers/env.mjs';
import { fake, runAnswer, specAnswer } from './helpers/fake-router.mjs';

const home = tmpHome();
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const codeid = await import('../../skills/gtm-loop/scripts/lib/codeid.mjs');
const routed = await import('../../skills/gtm-loop/scripts/lib/routed.mjs');
const router = await import('../../skills/gtm-loop/scripts/lib/router.mjs');
const rep = await import('../../skills/gtm-loop/scripts/lib/report.mjs');

const profile = { offers: [{ id: 'gtm', name: 'LoopA', phrases: ['how did you get your first users'], subreddits: ['startups'] }], sources: ['x'] };

test('a held line records the code that recorded it: the manifest version and a hash of the scripts', async () => {
  const id = codeid.codeId();
  assert.match(id, /^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);
  assert.equal(id.split('+')[0], JSON.parse(fs.readFileSync(path.join(SKILL, 'manifest.json'), 'utf8')).version);
  const x = fixture('router/x-posts.json');
  const f = fake({ answers: [specAnswer(x.host), { status: 'needs_input', reason: 'the input has no field foo' }] });
  await routed.runPostRound({ profile, overlay: { rules: [] }, client: new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300 } }), now: Date.now() });
  const h = store.loadState().held.find((x2) => x2.status === 'input_break');
  assert.equal(h.codeId, id);
});

function seedOld() {
  store.updateState((s) => {
    s.held = [
      { key: 'need:linkedin_posts:how did you get your first users', reason: 'need_held', status: 'needs_input', detail: 'linkedin_posts (how did you get your first users): the router answered needs_input' },
      { key: 'need:reddit_posts:how did you get your first users', reason: 'need_held', status: 'needs_input', codeId: '0.1.0+oldhash00000', detail: 'reddit_posts (how did you get your first users): the input has no field subreddit' },
      { key: 'need:x_posts:how did you get your first users', reason: 'need_held', status: 'needs_approval', detail: 'x_posts (how did you get your first users): over the daily budget' },
      { key: 'need:web_research:how did you get your first users', reason: 'need_held', status: 'needs_input', codeId: codeid.codeId(), detail: 'web_research (how did you get your first users): recorded by this code' },
      { reason: 'source_empty', detail: 'fit: x' },
    ];
  });
}

test('on start after an update, the refusals an older version recorded are dropped, with one line that those searches run again; other holds stay', () => {
  seedOld();
  assert.equal(codeid.dropStaleHolds(JSON.parse(JSON.stringify(store.loadState()))), 2);
  const r = runGtm(home, ['start', 'status']);
  assert.equal(r.code, 0);
  assert.equal(r.json.note, '2 searches that an older version of this skill held (its own request was refused) run again at the next round.');
  const keys = store.loadState().held.map((h) => h.key || h.reason);
  assert.deepEqual(keys, ['need:x_posts:how did you get your first users', 'need:web_research:how did you get your first users', 'source_empty'], 'a budget hold and a hold of this code stay');
  assert.equal(runGtm(home, ['start', 'status']).json.note, undefined, 'said once');
});

test('G work drops them too, and a one-line note says so', () => {
  seedOld();
  const w = runGtm(home, ['work']);
  assert.match(w.json.note, /^2 searches that an older version/);
  assert.equal(store.loadState().held.some((h) => h.status === 'needs_input' && h.codeId !== codeid.codeId()), false);
  assert.equal(codeid.staleHoldsLine(1), '1 search that an older version of this skill held (its own request was refused) runs again at the next round.');
  assert.equal(codeid.staleHoldsLine(0), null);
});

test('the report says a refused input is a defect of the skill to report, and never asks the person for a field', () => {
  const s = store.emptyState();
  s.held = [
    { key: 'need:reddit_posts:how did you get your first users', reason: 'need_held', status: 'needs_input', detail: 'reddit_posts (how did you get your first users): the input has no field subreddit' },
    { key: 'need:x_posts:how did you get your first users', reason: 'need_held', status: 'needs_approval', detail: 'x_posts (how did you get your first users): over the daily budget' },
  ];
  const text = rep.report(s, profile, Date.now()).text;
  assert.match(text, /Held: reddit_posts \(how did you get your first users\): the input has no field subreddit\. The skill's own request was refused: that is a defect in the skill to report, not something you fill in\./);
  assert.match(text, /Held: x_posts \(how did you get your first users\): over the daily budget\.\n?/);
  assert.doesNotMatch(text.split('\n').filter((l) => /over the daily budget/.test(l)).join(''), /defect/);
  assert.doesNotMatch(text, /tell me the subreddits|you need to give|please provide/i);
});

test('SKILL.md names the search-now commands, forbids asking the person to fill a refused input, and the old hold text is not read as a missing field', () => {
  const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(md, /The person asks to search now/);
  assert.match(md, /`G hn`, then `G search route`/);
  assert.match(md, /Never answer "no work is due" to a request to search/);
  assert.match(md, /do not ask them for a field, a subreddit or a phrase because of it/);
});
