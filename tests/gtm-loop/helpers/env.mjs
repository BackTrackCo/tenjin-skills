import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SKILL = path.join(ROOT, 'skills', 'gtm-loop');
export const GTM = path.join(SKILL, 'scripts', 'gtm.mjs');
export const FIX = path.join(ROOT, 'tests', 'gtm-loop', 'fixtures');
export const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
export const lib = (f) => path.join(SKILL, 'scripts', 'lib', f);

// Every test that touches settings or state runs in a temporary HOME. Never the real one.
export function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-test-'));
  process.env.HOME = dir;
  process.env.TENJIN_SKILLS_DIR = path.join(dir, '.tenjin-skills');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

export function runGtm(home, args, { input, cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [GTM, ...args], { encoding: 'utf8', input, cwd, env: { ...process.env, HOME: home, TENJIN_SKILLS_DIR: path.join(home, '.tenjin-skills'), PATH: '/usr/bin:/bin', ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

export function fakeFetch(map) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const hit = Object.entries(map).filter(([k]) => url.startsWith(k)).sort((a, b) => b[0].length - a[0].length)[0];
    if (!hit) return { ok: false, status: 404, url, text: async () => '', json: async () => ({}) };
    const v = hit[1];
    if (typeof v === 'number') return { ok: v < 400, status: v, url, text: async () => '', json: async () => ({}) };
    return { ok: true, status: 200, url, text: async () => JSON.stringify(v), json: async () => v };
  };
  f.calls = calls;
  return f;
}

export function mkLead(over = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const url = over.url || `https://x.com/someone/status/${100000 + n}`;
  return { key: over.key || url, url, source: 'x', kind: 'post', author: 'someone', text: 'Looking for a way to let my agent pay for APIs', postedAt: new Date().toISOString(), phrase: 'agent pay for APIs', status: 'new', v: 1, hash: 'h1', firstSeen: new Date().toISOString(), warnings: [], ...over };
}
