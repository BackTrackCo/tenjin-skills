import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The lowest Tenjin this skill was tested on: the latest release when v0 was written.
export const TESTED_VERSION = '0.1.0-alpha.35';

export function parseVersion(v) {
  const m = /(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z]+)\.?(\d+))?/.exec(String(v));
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? { tag: m[4], n: Number(m[5] || 0) } : null };
}
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  if (x.pre.tag !== y.pre.tag) return x.pre.tag < y.pre.tag ? -1 : 1;
  return x.pre.n - y.pre.n;
}

export function defaultRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000 });
  return { code: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

export function findTenjin({ env = process.env, home = os.homedir() } = {}) {
  const dirs = [...String(env.PATH || '').split(path.delimiter), path.join(home, '.local', 'bin')].filter(Boolean);
  for (const d of dirs) {
    const f = path.join(d, 'tenjin');
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return f;
    } catch {}
  }
  return null;
}

// missing | outdated | present. Anything else (wallet, balance) is for `tenjin doctor`.
export function checkTenjin({ run = defaultRun, bin = findTenjin() } = {}) {
  if (!bin) return { status: 'missing', tested: TESTED_VERSION };
  const r = run(bin, ['--version']);
  const v = parseVersion(r.stdout);
  if (r.code !== 0 || !v) return { status: 'missing', tested: TESTED_VERSION, detail: 'tenjin --version did not answer' };
  const version = `${v.core.join('.')}${v.pre ? `-${v.pre.tag}.${v.pre.n}` : ''}`;
  return { status: compareVersions(version, TESTED_VERSION) < 0 ? 'outdated' : 'present', version, tested: TESTED_VERSION, bin };
}

// ---- DeepSeek subagents: read-only check, then off only on a yes ----------
export function readSubagents({ run = defaultRun, bin }) {
  const r = run(bin, ['config', 'subagents', '--json']);
  try {
    const j = JSON.parse(r.stdout);
    if (j.ok === true && j.data && typeof j.data.enabled === 'boolean') return { ok: true, enabled: j.data.enabled };
  } catch {}
  return { ok: false, enabled: null, detail: 'could not read tenjin config subagents --json' };
}

export const DEEPSEEK_WHY = 'A DeepSeek worker has no Claude in Chrome tools, so every application would stop. Until Tenjin\'s DeepSeek workers can use Claude in Chrome, v0 needs DeepSeek subagents off.';

// yes: true runs `tenjin config subagents off`. Nothing else is ever changed.
export function deepseekStep({ run = defaultRun, bin, yes = false, keep = false }) {
  if (!bin) return { state: 'no_tenjin', enabled: false };
  const before = readSubagents({ run, bin });
  if (!before.ok) return { state: 'unreadable', enabled: null, detail: before.detail };
  if (!before.enabled) return { state: 'off', enabled: false };
  if (keep) return { state: 'on_kept', enabled: true, why: DEEPSEEK_WHY };
  if (!yes) return { state: 'on_ask', enabled: true, why: DEEPSEEK_WHY };
  const r = run(bin, ['config', 'subagents', 'off']);
  const after = readSubagents({ run, bin });
  return { state: after.ok && after.enabled === false ? 'turned_off' : 'off_failed', enabled: after.enabled, code: r.code };
}
