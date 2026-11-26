import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getApp } from './app.mjs';

// Everything an app keeps lives in its own folder under the person's skills root; the folder comes only from the registered app's name.
export function rootDir() {
  return process.env.TENJIN_SKILLS_DIR || path.join(os.homedir(), '.tenjin-skills');
}
export function stateDir() {
  return path.join(rootDir(), getApp().name);
}
export function skillDir() {
  return getApp().skillDir;
}
// The person's writing rules belong to the writing skill; a loop may read the file and never writes it.
export function writingRulesPath() {
  return path.join(rootDir(), 'writing', 'rules.md');
}
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
