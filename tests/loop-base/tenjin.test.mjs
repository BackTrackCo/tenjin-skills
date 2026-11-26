import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const t = await import('../../skills/loop-base/lib/tenjin.mjs');

const fakeRun = (script) => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args.join(' '));
    const hit = script.find(([k]) => args.join(' ') === k);
    return hit ? hit[1](calls) : { code: 1, stdout: '' };
  };
  run.calls = calls;
  return run;
};
const json = (data) => ({ code: 0, stdout: JSON.stringify({ schemaVersion: 1, ok: true, data }) });

test('versions compare, alpha builds included', () => {
  assert.ok(t.compareVersions('0.1.0-alpha.36', '0.1.0-alpha.35') > 0);
  assert.ok(t.compareVersions('0.1.0-alpha.9', '0.1.0-alpha.35') < 0);
  assert.ok(t.compareVersions('0.1.0', '0.1.0-alpha.99') > 0);
  assert.equal(t.compareVersions('0.1.0-alpha.35', '0.1.0-alpha.35'), 0);
});

test('the Tenjin check answers missing, outdated or present', () => {
  assert.equal(t.checkTenjin({ bin: null }).status, 'missing');
  assert.equal(t.checkTenjin({ bin: '/x/tenjin', run: fakeRun([['--version', () => ({ code: 0, stdout: 'tenjin 0.1.0-alpha.30\n' })]]) }).status, 'outdated');
  assert.equal(t.checkTenjin({ bin: '/x/tenjin', run: fakeRun([['--version', () => ({ code: 0, stdout: '0.1.0-alpha.35' })]]) }).status, 'present');
  assert.equal(t.checkTenjin({ bin: '/x/tenjin', run: fakeRun([['--version', () => ({ code: 0, stdout: '0.2.0' })]]) }).status, 'present');
  assert.equal(t.checkTenjin({ bin: '/x/tenjin', run: fakeRun([]) }).status, 'missing');
});

test('findTenjin looks on PATH, then in ~/.local/bin', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-'));
  assert.equal(t.findTenjin({ env: { PATH: '' }, home }), null);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'tenjin'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(t.findTenjin({ env: { PATH: '' }, home }), path.join(home, '.local', 'bin', 'tenjin'));
});

const balance = (atomic, usd) => ({ code: 0, stdout: JSON.stringify({ schemaVersion: 1, command: 'balance', ok: true, data: { address: '0x0', balance: { atomic: String(atomic), usd }, low: false } }) });

test('the hint state: missing, outdated, unfunded or ready', () => {
  const run = (version, bal) => fakeRun([['--version', () => ({ code: 0, stdout: version })], ['balance --json', () => bal]]);
  assert.equal(t.hintState({ bin: null }).status, 'missing');
  assert.equal(t.hintState({ bin: '/x/tenjin', run: run('0.1.0-alpha.30', balance(5000000, '$5.00')) }).status, 'outdated');
  assert.equal(t.hintState({ bin: '/x/tenjin', run: run('0.1.0-alpha.35', balance(0, '$0.00')) }).status, 'unfunded');
  assert.equal(t.hintState({ bin: '/x/tenjin', run: run('0.1.0-alpha.35', balance(5000000, '$5.00')) }).status, 'ready');
  assert.equal(t.hintState({ bin: '/x/tenjin', run: run('0.1.0-alpha.110', balance(1, '$0.000001')) }).status, 'ready', 'a later build prints the same shape');
});

test('the balance is read in both known shapes, and an unreadable one is not called unfunded', () => {
  const r = (out) => t.readBalance({ bin: '/x/tenjin', run: () => ({ code: 0, stdout: out }) });
  assert.equal(r(JSON.stringify({ ok: true, data: { balance: { atomic: '0', usd: '$0.00' } } })).atomic, 0n);
  assert.equal(r(JSON.stringify({ ok: true, data: { balance: { usd: '$2.50' } } })).atomic, 2500000n);
  assert.equal(r('not json').ok, false);
  assert.equal(t.hintState({ bin: '/x/tenjin', run: fakeRun([['--version', () => ({ code: 0, stdout: '0.1.0-alpha.35' })]]) }).status, 'ready');
});

test('the skill reads Tenjin with --version and balance --json only, and runs nothing that changes a setting', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push(args.join(' ')); return args[0] === '--version' ? { code: 0, stdout: '0.1.0-alpha.35' } : balance(1, '$0.000001'); };
  t.hintState({ bin: '/x/tenjin', run });
  assert.deepEqual(calls, ['--version', 'balance --json']);
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'loop-base', 'lib', 'tenjin.mjs'), 'utf8');
  const cmds = [...src.matchAll(/run\(bin, \[([^\]]*)\]/g)].map((m) => m[1].replace(/['\s]/g, ''));
  assert.deepEqual(cmds.sort(), ['--version', 'balance,--json'].sort());
  assert.doesNotMatch(src, /config|subagents|deepseek/i);
});
