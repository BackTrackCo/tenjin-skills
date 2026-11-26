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
