import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_LIB, demoApp, tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const guard = await import(path.join(BASE_LIB, 'netguard.mjs'));
const hosts = {
  allowed: ['api.example.test'],
  never: () => ['blocked.test'],
  userAgent: 'tenjin-skills-alpha',
  readModes: { pages: { assert: (url) => { const u = new URL(url); if (u.hostname !== 'pages.example.test' || u.pathname !== '/open') throw new Error(`not a readable page: ${url}`); } } },
};

test('an app that declared no hosts fails with a clear error', async () => {
  setApp(await demoApp('alpha'));
  assert.throws(() => guard.assertAllowed('https://api.example.test/x'), /has not declared its hosts/);
});

test('only the app\'s allowed hosts are fetched; a never host is refused by name first; a trailing dot or a look-alike never gets past', async () => {
  setApp(await demoApp('alpha', { hosts }));
  assert.doesNotThrow(() => guard.assertAllowed('https://api.example.test/x'));
  assert.throws(() => guard.assertAllowed('https://other.example.test/x'), /host not allowed: other\.example\.test/);
  assert.throws(() => guard.assertAllowed('https://api.example.test./x'), /host not allowed/);
  assert.throws(() => guard.assertAllowed('https://www.blocked.test/x'), /never-automated host refused: www\.blocked\.test/);
  assert.throws(() => guard.assertAllowed('https://blocked.test/x'), /never-automated/);
  assert.throws(() => guard.assertAllowed('https://api.example.test.evil.test/x'), /host not allowed/);
  setApp(await demoApp('outreach', { hosts: { allowed: ['api.other.test'], never: ['x.test'] } }));
  assert.throws(() => guard.assertAllowed('https://api.example.test/x'), /host not allowed/, 'each app has its own list');
});

test('a fixed host answers in place: no redirect is followed, a time limit applies, and the app\'s user agent is sent', async () => {
  setApp(await demoApp('alpha', { hosts }));
  let seen;
  await guard.guardedFetch('https://api.example.test/x', { headers: { accept: 'text/plain' } }, async (u, o) => { seen = o; return { ok: true }; });
  assert.equal(seen.redirect, 'manual');
  assert.ok(seen.signal);
  assert.deepEqual(seen.headers, { 'user-agent': 'tenjin-skills-alpha', accept: 'text/plain' });
});

test('a read mode is logged out: GET only, no cookie, no credentials, no redirect, and only the URLs its own check allows', async () => {
  setApp(await demoApp('alpha', { hosts }));
  let seen;
  await guard.guardedFetch('https://pages.example.test/open', { headers: { cookie: 'a=b' }, method: 'POST' }, async (u, o) => { seen = o; return {}; }, { mode: 'pages' });
  assert.equal(seen.method, 'GET');
  assert.equal(seen.credentials, 'omit');
  assert.equal(seen.redirect, 'manual');
  assert.equal(Object.keys(seen.headers).some((k) => /cookie|authorization/i.test(k)), false);
  await assert.rejects(guard.guardedFetch('https://pages.example.test/private', {}, async () => ({}), { mode: 'pages' }), /not a readable page/);
  await assert.rejects(guard.guardedFetch('https://pages.example.test/open', {}, async () => ({}), { mode: 'nope' }), /unknown read mode/);
  await assert.rejects(guard.guardedFetch('https://pages.example.test/open', {}, async () => ({})), /host not allowed/, 'without the mode the host is refused');
});

test('private and local addresses are refused by name or by literal IP, and a name that resolves to one is refused', async () => {
  for (const h of ['localhost', 'a.localhost', 'printer.local', 'svc.internal', 'intranet', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '[::1]', 'fd00::1', 'fe80::1']) assert.equal(guard.isLocalHost(h), true, h);
  for (const h of ['example.test', '8.8.8.8', '172.32.0.1', '2606:4700::1']) assert.equal(guard.isLocalHost(h), false, h);
  assert.equal(guard.isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(guard.isPrivateAddress('::ffff:7f00:1'), true);
  assert.equal(guard.isPrivateAddress('93.184.216.34'), false);
  await assert.rejects(guard.assertPublicName('localhost'), /local or private address refused/);
  await assert.rejects(guard.assertPublicName('a.example.test', async () => [{ address: '10.0.0.5' }]), /resolves to a local or private address/);
  await assert.rejects(guard.assertPublicName('a.example.test', async () => { throw new Error('nope'); }), /did not resolve/);
  await assert.rejects(guard.assertPublicName('a.example.test', async () => []), /did not resolve/);
  await guard.assertPublicName('a.example.test', async () => [{ address: '93.184.216.34' }]);
});

test('one exact URL outside the list may be read once, https only, and never a never host or a private name', async () => {
  setApp(await demoApp('alpha', { hosts }));
  const ok = 'https://files.example.test/resume.pdf';
  assert.doesNotThrow(() => guard.assertAllowed(ok, { allowUrl: ok }));
  assert.throws(() => guard.assertAllowed('https://files.example.test/other.pdf', { allowUrl: ok }), /not the one allowed/);
  assert.throws(() => guard.assertAllowed('http://files.example.test/resume.pdf', { allowUrl: 'http://files.example.test/resume.pdf' }), /https only/);
  assert.throws(() => guard.assertAllowed('https://blocked.test/a', { allowUrl: 'https://blocked.test/a' }), /never-automated/);
  assert.throws(() => guard.assertAllowed('https://10.0.0.1/a', { allowUrl: 'https://10.0.0.1/a' }), /local or private/);
  await assert.rejects(guard.guardedFetch(ok, {}, async () => ({}), { allowUrl: ok, lookup: async () => [{ address: '10.0.0.5' }] }), /resolves to a local or private address/);
  let called = false;
  await guard.guardedFetch(ok, {}, async () => { called = true; return {}; }, { allowUrl: ok, lookup: async () => [{ address: '93.184.216.34' }] });
  assert.equal(called, true);
});
