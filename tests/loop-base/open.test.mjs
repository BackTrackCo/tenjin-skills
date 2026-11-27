import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE_LIB, demoApp, tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const open = await import(path.join(BASE_LIB, 'open.mjs'));
setApp(await demoApp('alpha'));

test('only an https link to a public host opens; a local or private address, a login in the link and a control character never do', () => {
  assert.equal(open.checkOpenUrl('https://jobs.example.test/a?b=1'), null);
  assert.equal(open.checkOpenUrl('not a link'), 'not a link');
  assert.equal(open.checkOpenUrl('http://jobs.example.test/a'), 'https links only');
  for (const u of ['https://localhost/a', 'https://10.0.0.1/a', 'https://192.168.1.1/a', 'https://127.0.0.1.nip.io/a', 'https://[::1]/a', 'https://printer.local/a']) assert.equal(open.checkOpenUrl(u), 'local or private address', u);
  assert.equal(open.checkOpenUrl('https://user:pw@jobs.example.test/a'), 'a link with a login in it');
  assert.equal(open.checkOpenUrl('https://jobs.example.test/a"b'), 'a link with a quote or a control character in it');
});

test('the open command names Chrome per platform, falls back to the default browser with one plain line, and never starts a shell', () => {
  assert.deepEqual(open.chromeCommand('https://x.test/a', 'darwin'), { bin: 'open', args: ['-a', 'Google Chrome', 'https://x.test/a'] });
  assert.deepEqual(open.defaultCommand('https://x.test/a', 'linux'), { bin: 'xdg-open', args: ['https://x.test/a'] });
  const calls = [];
  const spawn = (bin, args) => { calls.push([bin, args]); return { status: bin === 'open' && args[0] === '-a' ? 1 : 0 }; };
  const r = open.openPage('https://x.test/a b', { spawn, platform: 'darwin', env: {} });
  assert.deepEqual([r.ok, r.browser, r.line], [true, 'default', open.FALLBACK_LINE]);
  assert.equal(calls[1][1][0], 'https://x.test/a%20b', 'the parsed form, one argument');
  assert.equal(open.openPage('http://x.test', { spawn }).ok, false);
});

test('the app\'s env name replaces the whole command in tests', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-'));
  const log = path.join(dir, 'log');
  const bin = path.join(dir, 'open');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$1" >> "${log}"\n`, { mode: 0o755 });
  const r = open.openPage('https://x.test/a', { env: { ALPHA_OPEN_BIN: bin } });
  assert.deepEqual([r.ok, r.browser], [true, 'chrome']);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'https://x.test/a');
  assert.equal(open.openPage('https://x.test/a', { env: { ALPHA_OPEN_BIN: path.join(dir, 'missing') } }).ok, false);
  const seen = [];
  open.openPage('https://x.test/a', { spawn: (b) => { seen.push(b); return { status: 0 }; }, env: { OUTREACH_OPEN_BIN: '/nope' }, platform: 'linux', exists: () => false });
  assert.deepEqual(seen, ['google-chrome'], 'another app\'s variable is not read');
});
