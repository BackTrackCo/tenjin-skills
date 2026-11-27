import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, fakeFetch, fixture } from './helpers/env.mjs';
import { parseCareersUrl, boardApiUrl, fetchBoard, hostedUrl, normalizeAshby, normalizeGreenhouse, normalizeLever, parseBoardUrl } from '../../skills/job-search/scripts/lib/boards.mjs';
import { normalizeUrl } from '../../skills/job-search/scripts/lib/dedupe.mjs';
import { ALLOWED_HOSTS, guardedFetch } from '../../skills/job-search/scripts/lib/net.mjs';

test('board URLs parse for each host, including gh_jid pages', () => {
  assert.deepEqual(parseBoardUrl('https://boards.greenhouse.io/figma/jobs/123?gh_src=x'), { ats: 'greenhouse', region: 'us', token: 'figma', jobId: '123' });
  assert.deepEqual(parseBoardUrl('https://job-boards.eu.greenhouse.io/acme/jobs/9'), { ats: 'greenhouse', region: 'eu', token: 'acme', jobId: '9' });
  assert.deepEqual(parseBoardUrl('https://www.example.com/careers/role?gh_jid=555'), { ats: 'greenhouse', region: 'us', token: null, jobId: '555' });
  assert.deepEqual(parseBoardUrl('https://jobs.lever.co/1inch/abc-123/apply'), { ats: 'lever', region: 'us', token: '1inch', jobId: 'abc-123' });
  assert.deepEqual(parseBoardUrl('https://jobs.ashbyhq.com/Linear/uuid/application'), { ats: 'ashby', region: 'us', token: 'Linear', jobId: 'uuid' });
  assert.equal(parseBoardUrl('https://example.com/jobs/1'), null);
  assert.equal(hostedUrl({ ats: 'greenhouse', token: 'figma', jobId: '123' }), 'https://boards.greenhouse.io/figma/jobs/123');
});

test('tracking parameters and fragments never change the job key', () => {
  assert.equal(normalizeUrl('https://boards.greenhouse.io/figma/jobs/1?gh_src=a&utm_source=b#top'), 'https://boards.greenhouse.io/figma/jobs/1');
  assert.equal(normalizeUrl('https://jobs.lever.co/x/1/?lever-source=li'), 'https://jobs.lever.co/x/1');
});

test('recorded fixtures normalize to postings with the fields the sweep needs', () => {
  const gh = normalizeGreenhouse(fixture('greenhouse-figma.json'), { token: 'figma', name: 'Figma', region: 'us' });
  const lv = normalizeLever(fixture('lever-1inch.json'), { token: '1inch', name: '1inch', region: 'us' });
  const ab = normalizeAshby(fixture('ashby-linear.json'), { token: 'Linear', name: 'Linear' });
  for (const list of [gh, lv, ab]) {
    assert.ok(list.length > 0);
    for (const j of list) { assert.ok(j.title && j.url && j.company); assert.ok(Array.isArray(j.applyLinks) && j.applyLinks.length); assert.equal(typeof j.remote, 'boolean'); }
  }
  assert.match(gh[0].url, /^https:\/\/boards\.greenhouse\.io\/figma\/jobs\/\d+$/);
  assert.match(lv[0].url, /^https:\/\/jobs\.lever\.co\/1inch\//);
  assert.match(ab[0].applyLinks[0], /^https:\/\/jobs\.ashbyhq\.com\/linear/i);
});

test('fetchBoard: ok, 429 and empty answers become holds, never throws', async () => {
  const entry = { ats: 'greenhouse', token: 'figma', name: 'Figma', region: 'us' };
  const ok = await fetchBoard(entry, fakeFetch({ 'https://boards-api.greenhouse.io/': fixture('greenhouse-figma.json') }));
  assert.equal(ok.ok, true);
  assert.equal((await fetchBoard(entry, fakeFetch({ 'https://boards-api.greenhouse.io/': 429 }))).reason, 'rate limited (429)');
  assert.equal((await fetchBoard(entry, fakeFetch({ 'https://boards-api.greenhouse.io/': { jobs: [] } }))).reason, 'no postings returned');
  assert.throws(() => boardApiUrl({ ats: 'greenhouse', token: '../evil' }), /bad board token/);
});

test('the network door refuses every host outside the list', async () => {
  await assert.rejects(guardedFetch('https://www.linkedin.com/jobs', {}, async () => ({})), /never-automated host refused/);
  await assert.rejects(guardedFetch('https://example.com/', {}, async () => ({})), /host not allowed/);
});

test('network host check: scripts name no host beyond the allowed list and documented pages', () => {
  const dir = path.join(ROOT, 'skills', 'job-search', 'scripts');
  const docs = ['tenjin.sh', 'github.com', 'creativecommons.org', 'x.com', 'www.linkedin.com', 'luma.com', 'www.ycombinator.com']; // x.com: only the profile link code gives the person, never fetched
  const files = [path.join(dir, 'jobs.mjs'), ...fs.readdirSync(path.join(dir, 'lib'), { recursive: true }).filter((f) => f.endsWith('.mjs')).map((f) => path.join(dir, 'lib', f))];
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase();
      const ok = ALLOWED_HOSTS.includes(host) || docs.includes(host) || /greenhouse\.io$|lever\.co$|ashbyhq\.com$/.test(host);
      assert.ok(ok, `${path.basename(f)} names ${host}`);
    }
  }
});

test('careers URLs: every documented pattern gives the system and the token', () => {
  const cases = [
    ['https://boards.greenhouse.io/acme', 'greenhouse', 'acme', 'us'],
    ['https://job-boards.greenhouse.io/acme/jobs/123', 'greenhouse', 'acme', 'us'],
    ['https://job-boards.eu.greenhouse.io/acme', 'greenhouse', 'acme', 'eu'],
    ['https://boards.greenhouse.io/embed/job_app?for=acme&token=999', 'greenhouse', 'acme', 'us'],
    ['https://jobs.lever.co/acme', 'lever', 'acme', 'us'],
    ['https://jobs.lever.co/acme/0b0b0b0b-1111-2222-3333-444444444444/apply', 'lever', 'acme', 'us'],
    ['https://jobs.eu.lever.co/acme', 'lever', 'acme', 'eu'],
    ['https://jobs.ashbyhq.com/Acme', 'ashby', 'Acme', 'us'],
    ['https://jobs.ashbyhq.com/Acme/uuid-1/application', 'ashby', 'Acme', 'us'],
  ];
  for (const [url, ats, token, region] of cases) {
    const p = parseCareersUrl(url);
    assert.deepEqual([p.ats, p.token, p.region], [ats, token, region], url);
  }
  assert.equal(parseCareersUrl('https://www.example.com/careers'), null);
});

test('a page with only ?gh_jid= has no token: the report asks for the board link', async () => {
  const p = parseCareersUrl('https://www.acme.test/careers/role?gh_jid=555');
  assert.deepEqual(p, { needsBoard: true, ats: 'greenhouse', jobId: '555' });
  const { resolveWatchList, runSweep } = await import('../../skills/job-search/scripts/lib/sweep.mjs');
  const r = resolveWatchList({ watch: [{ url: 'https://www.acme.test/careers/role?gh_jid=555', name: 'Acme' }] });
  assert.deepEqual(r.entries, []);
  assert.deepEqual(r.unresolved, ['Acme']);
  const { emptyState } = await import('../../skills/job-search/scripts/lib/store.mjs');
  const p2 = await runSweep({ state: emptyState(), profile: { watch: [{ url: 'https://www.acme.test/x?gh_jid=5', name: 'Acme' }] }, overlay: { rules: [], lessons: [] }, fetch: fakeFetch({}), now: Date.now() });
  assert.match(p2.held[0].detail, /Acme: no board link found, paste the board link/);
});

test('no cap: every watched company is read, in turn', async () => {
  const { resolveWatchList } = await import('../../skills/job-search/scripts/lib/sweep.mjs');
  const watch = Array.from({ length: 120 }, (_, i) => ({ url: `https://boards.greenhouse.io/co${i}` }));
  assert.equal(resolveWatchList({ watch }).entries.length, 120);
  assert.equal(resolveWatchList({ watch: [...watch, { url: 'https://boards.greenhouse.io/co0/jobs/1' }] }).entries.length, 120, 'the same board twice is read once');
});

test('the EU API hosts are allowed and still marked not verified in code', () => {
  assert.match(boardApiUrl({ ats: 'greenhouse', region: 'eu', token: 'acme' }), /^https:\/\/boards-api\.eu\.greenhouse\.io\//);
  assert.match(boardApiUrl({ ats: 'lever', region: 'eu', token: 'acme' }), /^https:\/\/api\.eu\.lever\.co\//);
  const src = fs.readFileSync(path.join(ROOT, 'skills', 'job-search', 'scripts', 'lib', 'net.mjs'), 'utf8');
  assert.match(src, /boards-api\.eu\.greenhouse\.io', \/\/ not verified/);
});
