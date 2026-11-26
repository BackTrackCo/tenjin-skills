import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const { pushSettings } = await import('../../skills/loop-base/lib/pushsettings.mjs');

// Every test reads fixture files in a temporary folder, never the real config of the machine that runs the tests.
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-config-'));
const put = (d, rel, v) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), typeof v === 'string' ? v : JSON.stringify(v)); };
const IN = 'inputNeededNotifEnabled';
const AG = 'agentPushNotifEnabled';
const ACTIONS = 'Then open /config and turn on "Push when actions required", so questions reach your phone.';
const DECIDES = 'Then open /config and turn on "Push when Claude decides", so updates reach your phone.';
const BOTH = 'Then open /config and turn on "Push when actions required" and "Push when Claude decides", so questions and updates reach your phone.';

test('the reader takes the two keys from the global config file, then the settings file, and treats everything else as unknown', () => {
  const d = dir();
  assert.deepEqual(pushSettings({ env: { CLAUDE_CONFIG_DIR: d }, home: '/nonexistent' }), { input: null, agent: null }, 'no files: unknown');
  put(d, '.claude.json', { [IN]: true, [AG]: false, oauthAccount: { emailAddress: 'a@b.test' } });
  assert.deepEqual(pushSettings({ env: { CLAUDE_CONFIG_DIR: d } }), { input: true, agent: false });
  put(d, '.claude.json', { [IN]: false });
  put(d, 'settings.json', { [AG]: true, [IN]: true });
  assert.deepEqual(pushSettings({ env: { CLAUDE_CONFIG_DIR: d } }), { input: false, agent: true }, 'the global value wins, the settings file fills a missing key');
  put(d, '.claude.json', '{ not json');
  assert.deepEqual(pushSettings({ env: { CLAUDE_CONFIG_DIR: d } }), { input: true, agent: true }, 'an unreadable file falls through to the settings file');
  put(d, '.claude.json', { [IN]: 'yes', [AG]: 1 });
  put(d, 'settings.json', { [IN]: null });
  assert.deepEqual(pushSettings({ env: { CLAUDE_CONFIG_DIR: d } }), { input: null, agent: null }, 'a value that is not a boolean is unknown');
  put(d, '.claude.json', [1, 2]);
  assert.deepEqual(pushSettings({ env: { CLAUDE_CONFIG_DIR: d } }), { input: null, agent: null });
});

test('without CLAUDE_CONFIG_DIR the reader uses ~/.claude.json and ~/.claude/settings.json under the given home', () => {
  const h = dir();
  put(h, '.claude.json', { [IN]: true });
  put(h, '.claude/settings.json', { [AG]: false });
  assert.deepEqual(pushSettings({ env: {}, home: h }), { input: true, agent: false });
});

test('the reader returns only the two keys, never writes or copies a file, and never prints another key', () => {
  const d = dir();
  const secret = 'TOKEN-should-never-appear';
  put(d, '.claude.json', { [IN]: true, [AG]: true, apiKey: secret, oauthAccount: { emailAddress: 'someone@x.test' } });
  put(d, 'settings.json', { env: { SECRET: secret } });
  const before = fs.readdirSync(d).map((f) => [f, fs.statSync(path.join(d, f)).mtimeMs, fs.readFileSync(path.join(d, f), 'utf8')]);
  const logs = [];
  const orig = [console.log, console.error, process.stdout.write, process.stderr.write];
  console.log = (...a) => logs.push(a.join(' ')); console.error = console.log;
  process.stdout.write = (c) => { logs.push(String(c)); return true; }; process.stderr.write = process.stdout.write;
  let r;
  try { r = pushSettings({ env: { CLAUDE_CONFIG_DIR: d } }); } finally { [console.log, console.error, process.stdout.write, process.stderr.write] = orig; }
  assert.deepEqual(Object.keys(r).sort(), ['agent', 'input']);
  assert.equal(JSON.stringify(r).includes(secret), false);
  assert.equal(logs.join('').includes(secret), false, 'nothing is printed');
  assert.deepEqual(fs.readdirSync(d).map((f) => [f, fs.statSync(path.join(d, f)).mtimeMs, fs.readFileSync(path.join(d, f), 'utf8')]), before, 'no file was written');
  assert.equal(fs.readdirSync(d).length, 2, 'no copy was made');
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'loop-base', 'lib', 'pushsettings.mjs'), 'utf8');
  assert.doesNotMatch(src, /writeFile|copyFile|appendFile|console\./, 'the module has no write, copy or log call');
});
