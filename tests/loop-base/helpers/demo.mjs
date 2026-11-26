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
export async function demoApp(name) {
  const { defineApp } = await import(path.join(BASE_LIB, 'app.mjs'));
  return defineApp({ skillDir: path.join(FIXTURES, name) });
}
