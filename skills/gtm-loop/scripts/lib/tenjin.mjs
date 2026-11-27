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

// ---- the hint state: missing, outdated, unfunded or ready ----------------------
// From `tenjin --version` and the read-only `tenjin balance --json`. Alpha.35 and later print the same envelope,
// {schemaVersion, command, ok, data: {balance: {atomic, usd}, ...}} (checked in the alpha.35 source and on a later
// build); a bare dollar string or number in `usd` is read too. Nothing here changes a Tenjin setting.
export function readBalance({ run = defaultRun, bin }) {
  const r = run(bin, ['balance', '--json']);
  try {
    const j = JSON.parse(r.stdout);
    const b = j && j.data && j.data.balance;
    if (j.ok === true && b) {
      if (b.atomic !== undefined) return { ok: true, atomic: BigInt(String(b.atomic)) };
      const usd = parseFloat(String(b.usd).replace(/[^0-9.]/g, ''));
      if (Number.isFinite(usd)) return { ok: true, atomic: BigInt(Math.round(usd * 1e6)) };
    }
  } catch {}
  return { ok: false, atomic: null };
}

export function hintState({ run = defaultRun, bin = findTenjin() } = {}) {
  const t = checkTenjin({ run, bin });
  if (t.status === 'missing') return { status: 'missing', tested: TESTED_VERSION };
  if (t.status === 'outdated') return { status: 'outdated', version: t.version, tested: TESTED_VERSION };
  const b = readBalance({ run, bin: t.bin });
  // An unreadable balance is not "unfunded": the router answers for itself, so it counts as ready.
  return { status: b.ok && b.atomic === 0n ? 'unfunded' : 'ready', version: t.version, tested: TESTED_VERSION };
}
