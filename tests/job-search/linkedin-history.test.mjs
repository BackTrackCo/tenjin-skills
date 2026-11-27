import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, tmpHome } from './helpers/env.mjs';

tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const hist = await import('../../skills/loop-base/lib/suppliers/linkedin-history.mjs');
const thin = await import('../../skills/loop-base/lib/suppliers/linkedin.mjs');
const sup = await import(`${S}suppliers/index.mjs`);
const router = await import(`${S}router.mjs`);
const routed = await import(`${S}routed.mjs`);
const resume = await import(`${S}resume.mjs`);
const profileLib = await import(`${S}profile.mjs`);

const body = fixture('router/linkedin-profile-history.json');
const FAKE = path.join(import.meta.dirname, 'helpers', 'fake-tenjin.mjs');
function fake(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faketenjin-'));
  const sf = path.join(dir, 'script.json');
  const lf = path.join(dir, 'log.jsonl');
  fs.writeFileSync(sf, JSON.stringify(script));
  const bin = path.join(dir, 'tenjin');
  fs.writeFileSync(bin, `#!/bin/sh\nFAKE_SCRIPT="${sf}" FAKE_LOG="${lf}" exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  return { bin, log: () => (fs.existsSync(lf) ? fs.readFileSync(lf, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}
const client = (f) => new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300 } });
const spec = (host) => ({ status: 'spec', id: 'offer-1', __text: `Request: POST https://${host}/v1/run/linkedin.profile\nInputs: url` });
const fulfilled = (supplier) => ({ status: 'fulfilled', supplier, result: JSON.stringify(body), cost: ['provider price 0.0035 USD'] });
const URL_IN = 'https://www.linkedin.com/in/placeholder-person';

test('the new reader parses the work history: titles and dates, schools only, no connection count and no person list', () => {
  const a = hist.adapter(body);
  assert.equal(a.thin, false, 'titles are present: not a thin profile');
  assert.deepEqual(a.history, [
    { company: 'Example Co', title: 'Software Engineer', start: '2021-03', end: null },
    { company: 'Placeholder Labs', title: 'Backend Developer', start: '2018-06', end: '2021-02' },
    { company: 'Sample Systems', title: 'Intern', start: '2017', end: '2017' },
  ]);
  assert.deepEqual(a.titles, ['Software Engineer', 'Backend Developer', 'Intern']);
  assert.deepEqual(a.current, [{ company: 'Example Co', title: 'Software Engineer' }]);
  assert.deepEqual(a.schools, [{ name: 'Example University', start: '2014', end: '2018' }]);
  assert.match(a.text, /Experience:\n- Software Engineer, Example Co \(2021-03 to now\)/);
  assert.match(a.text, /Example University/);
  assert.doesNotMatch(JSON.stringify(a), /connection|follower|500|120\b/i, 'a count is not kept');
  assert.throws(() => hist.adapter({ output: { found: false } }), /not found/);
  assert.throws(() => hist.adapter({ output: { found: true, data: {} } }), /no name, headline or about/);
});

test('through the router: the new host is picked, the titles give a role hint, and the thin reader still works', async () => {
  assert.equal(sup.pickSupplier('POST https://api.getanyapi.com/v1/run/linkedin.profile', 'linkedin_profile').host, 'api.getanyapi.com');
  assert.equal(sup.pickSupplier('GET https://x402.orthogonal.com/linkedin/profile', 'linkedin_profile').host, 'x402.orthogonal.com');
  const f = fake({ answers: [spec('api.getanyapi.com'), fulfilled('api.getanyapi.com')] });
  const r = await routed.readLinkedIn({ url: URL_IN, client: client(f) });
  assert.equal(r.ok, true);
  assert.equal(r.thin, false);
  assert.deepEqual(r.current, ['Software Engineer']);
  assert.equal(r.history.length, 3);
  const link = await resume.setFromLink({ url: URL_IN, state: { tenjin: { status: 'ready' } }, client: client(fake({ answers: [spec('api.getanyapi.com'), fulfilled('api.getanyapi.com')] })) });
  assert.equal(link.read, true);
  assert.equal(link.thin, false);
  assert.deepEqual(link.roleHint.current, ['Software Engineer']);
  assert.equal(link.roleHint.titles.length, 3);
  assert.equal(link.history[1].company, 'Placeholder Labs');
  const t = thin.adapter({ result: { name: 'Pat Example', about: 'placeholder', experience: [{ name: 'Placeholder Labs', member: { startDate: '2018-06' } }], education: [] } });
  assert.equal(t.thin, true);
  assert.deepEqual(t.employers.map((e) => e.name), ['Placeholder Labs']);
  assert.deepEqual(profileLib.validateProfile({ search: { role: 'software engineer', sources: { role: 'linkedin' } } }), []);
});

test('an unknown host still holds as no_adapter with nothing paid', async () => {
  const f = fake({ answers: [spec('unknown-profiles.example'), fulfilled('unknown-profiles.example')] });
  const [r] = await router.runRound([{ kind: 'linkedin_profile', text: 'read the profile', fields: { url: URL_IN }, query: { url: URL_IN } }], { client: client(f) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'no_adapter');
  assert.equal(f.log().filter((l) => l.call).length, 1, 'only the free spec step ran: no payment');
});
