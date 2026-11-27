import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tmpHome } from './helpers/env.mjs';
import { fake, runAnswer, specAnswer } from './helpers/fake-router.mjs';

tmpHome();
const router = await import('../../skills/gtm-loop/scripts/lib/router.mjs');
const sup = await import('../../skills/gtm-loop/scripts/lib/suppliers/index.mjs');
const routed = await import('../../skills/gtm-loop/scripts/lib/routed.mjs');

const client = (f) => new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 500, collect: 40, poll: 10 } });
async function run(kind, fx, fields) {
  const need = routed.fillNeed(kind, fields);
  const f = fake({ answers: [specAnswer(fx.host), runAnswer(fx.host, fx.result)] });
  const [r] = await router.runRound([need], { client: client(f) });
  return { r, calls: f.calls() };
}

test('every post adapter turns its fixture into posts, and the mapper makes the recorded input', async () => {
  const cases = [
    ['x_posts', 'router/x-posts.json', { query: 'agent pay for APIs', since: '2026-11-20' }, 2, 'x'],
    ['x_posts', 'router/x-search.json', { query: 'agent pay for APIs', since: '2026-11-20' }, 2, 'x'],
    ['reddit_posts', 'router/reddit-glim.json', { query: 'agent pay for APIs', since: '2026-11-20' }, 1, 'reddit'],
    ['reddit_posts', 'router/reddit-anyapi.json', { query: 'agent pay for APIs', since: '2026-11-20' }, 2, 'reddit'],
    ['linkedin_posts', 'router/linkedin-posts.json', { query: 'agent pay for APIs', since: new Date(Date.now() - 3 * 86400000).toISOString() }, 1, 'linkedin'],
    ['web_research', 'router/web-research.json', { query: 'agent pay for APIs' }, 2, null],
  ];
  for (const [kind, file, fields, n, source] of cases) {
    const fx = fixture(file);
    const { r, calls } = await run(kind, fx, fields);
    assert.equal(r.ok, true, `${file}: ${r.reason}`);
    assert.equal(r.ingest.posts.length, n, file);
    assert.deepEqual(calls[1].input, fx.input, `${file}: the mapper makes the fixture's input`);
    for (const p of r.ingest.posts) {
      assert.match(p.url, /^https:\/\//);
      assert.ok(p.text.length > 0 && p.text.length <= 1000);
      if (source) assert.equal(p.source, source);
    }
  }
});

test('post details: X links, Reddit permalinks made absolute, LinkedIn author profile, web results labelled by their own site', async () => {
  let { r } = await run('x_posts', fixture('router/x-posts.json'), { query: 'agent pay for APIs', since: '2026-11-20' });
  assert.deepEqual(r.ingest.posts[1].links, ['https://example.org/notes']);
  ({ r } = await run('reddit_posts', fixture('router/reddit-anyapi.json'), { query: 'agent pay for APIs', since: '2026-11-20' }));
  assert.equal(r.ingest.posts[0].url, 'https://www.reddit.com/r/ClaudeAI/comments/abc123/how_do_i_let_my_agent_pay/');
  ({ r } = await run('linkedin_posts', fixture('router/linkedin-posts.json'), { query: 'agent pay for APIs', since: '2026-11-20' }));
  assert.equal(r.ingest.posts[0].author, 'pat-lee-123');
  ({ r } = await run('web_research', fixture('router/web-research.json'), { query: 'agent pay for APIs' }));
  assert.deepEqual(r.ingest.posts.map((p) => p.source), ['web', 'x']);
});

test('an answer with no list, or a post with no text, is refused by its adapter', async () => {
  for (const [kind, fxn, bad] of [['reddit_posts', 'router/reddit-glim.json', { nope: 1 }], ['linkedin_posts', 'router/linkedin-posts.json', { output: { found: true, data: {} } }], ['web_research', 'router/web-research.json', { results: [{ url: 'nope' }] }], ['x_posts', 'router/x-search.json', { output: { data: { items: [{ url: 'https://x.com/a/status/1', text: '' }] } } }]]) {
    const fx = { ...fixture(fxn), result: bad };
    const { r } = await run(kind, fx, { query: 'a', since: '2026-11-20' });
    assert.equal(r.status, 'schema_failure', fxn);
  }
});

test('the identity reads: the X profile gives a country and a link, both LinkedIn readers give a company', async () => {
  let { r } = await run('x_profile', fixture('router/x-profile.json'), { handle: 'dev_one' });
  assert.equal(r.ok, true);
  assert.equal(r.ingest.location, 'Berlin, Germany');
  assert.ok(r.ingest.links.includes('https://www.linkedin.com/in/dev-one-77/'));
  const li = fixture('router/linkedin-profile.json');
  for (const k of ['first', 'second']) {
    ({ r } = await run('linkedin_profile', { host: li[k].host, result: li[k].result }, { url: 'https://www.linkedin.com/in/pat-lee-123' }));
    assert.equal(r.ok, true, k);
    assert.equal(r.ingest.company, 'Acme Robotics');
    assert.match(r.ingest.location, /Canada/);
  }
  const bad = routed.fillNeed('linkedin_profile', { url: 'https://example.org/in/x' });
  const f = fake({ answers: [specAnswer('x402.orthogonal.com')] });
  const [h] = await router.runRound([bad], { client: client(f) });
  assert.equal(h.status, 'no_input', 'a link that is not a LinkedIn profile never reaches the router');
});

test('a need names no seller, fills its template, and refuses a missing field', () => {
  const g = JSON.parse(JSON.stringify(sup.SUPPLIERS.map((s) => s.host)));
  assert.ok(g.length >= 8);
  const need = routed.fillNeed('x_posts', { query: 'agent pay for APIs', since: '2026-11-20' });
  assert.match(need.text, /agent pay for APIs/);
  assert.doesNotMatch(need.text, new RegExp(['glim', 'anyapi', 'exa', 'apollo'].join('|'), 'i'));
  assert.throws(() => routed.fillNeed('x_posts', { query: 'a' }), /no since/);
  assert.throws(() => routed.fillNeed('nope', {}), /unknown need/);
});
