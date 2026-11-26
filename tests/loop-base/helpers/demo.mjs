import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const BASE_LIB = path.join(ROOT, 'skills', 'loop-base', 'lib');
export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

// A temporary skills root for one test file: nothing touches the real home.
export function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-base-'));
  process.env.TENJIN_SKILLS_DIR = dir;
  return dir;
}

// A demo app object from a fixture folder (`alpha`, or `outreach` for the GTM-shaped one).
export async function demoApp(name, extra = {}) {
  const { defineApp } = await import(path.join(BASE_LIB, 'app.mjs'));
  return defineApp({ skillDir: path.join(FIXTURES, name), state: demoState(), ...extra });
}

// The smallest state shape an app can declare: an empty state, a schema version, one op, and one old field.
export function demoState() {
  return {
    schemaVersion: 1,
    empty: () => ({ schemaVersion: 1, counts: {}, lease: null, items: {}, n: 0 }),
    applyOp(state, op) {
      if (!op || op.op !== 'count') throw new Error(`unknown op: ${op && op.op}`);
      state.counts[op.key] = (state.counts[op.key] || 0) + 1;
    },
    oldFields: (raw) => (raw && raw.legacy !== undefined ? [{ field: 'legacy', why: 'it is gone' }] : []),
  };
}

// A fake fetch: the longest matching URL prefix answers; a number is a status, anything else is the JSON body.
export function fakeFetch(map) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const hit = Object.entries(map).filter(([k]) => url.startsWith(k)).sort((a, b) => b[0].length - a[0].length)[0];
    if (!hit) return { ok: false, status: 404, url, json: async () => ({}) };
    const v = hit[1];
    if (typeof v === 'number') return { ok: v < 400, status: v, url, json: async () => ({}) };
    return { ok: true, status: 200, url, json: async () => v };
  };
  f.calls = calls;
  return f;
}

// A temporary skill folder for an app that releases: SKILL.md with a gate section, a graph and one gate file, and a manifest that lists them.
export function releasableSkill(name = 'alpha') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n\n<!-- gates:start -->\n1. Never send without a yes.\n<!-- gates:end -->\n\nOther text.\n`);
  fs.writeFileSync(path.join(dir, 'graph.json'), '{"statuses":[]}\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'gate.mjs'), 'export const gate = 1;\n');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name, version: '0.1.0', writing: 'writing-v0.1.0', gateFiles: ['graph.json', 'scripts/gate.mjs'] }));
  return dir;
}
