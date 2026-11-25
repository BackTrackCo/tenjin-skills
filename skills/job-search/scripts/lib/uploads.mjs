import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, stateDir } from './paths.mjs';

// The files a form takes live in their own folder, apart from the state files, so one grant for Claude in Chrome (a Chrome upload
// counts as a read, and only folders the session may read can be uploaded from) opens the uploads folder and nothing else.
export const uploadsDir = () => path.join(stateDir(), 'uploads');
export const ensureUploads = () => {
  const d = ensureDir(uploadsDir());
  fs.chmodSync(d, 0o700);
  return d;
};

// A copy of the file for Chrome, named resume with the original's extension. The original is never touched.
export function copyToUploads(src, name = null) {
  const dir = ensureUploads();
  const dest = path.join(dir, name || `resume${path.extname(src).toLowerCase()}`);
  if (path.resolve(src) !== dest) fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o600);
  return dest;
}

// Writes a downloaded file (a resume PDF from a link) straight into the uploads folder.
export function saveToUploads(name, data) {
  const dest = path.join(ensureUploads(), name);
  fs.writeFileSync(dest, data, { mode: 0o600 });
  fs.chmodSync(dest, 0o600);
  return dest;
}

// ---- the grant ----------------------------------------------------------------------------------------------
// Claude Code's working directories include `permissions.additionalDirectories` from settings. Read-only, and only that one key,
// from the user settings, the project's settings and its local settings; nothing else is kept and nothing is written.
function additionalDirs(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = o && o.permissions && Array.isArray(o.permissions.additionalDirectories) ? o.permissions.additionalDirectories : [];
    return list.filter((x) => typeof x === 'string');
  } catch {
    return [];
  }
}
const expand = (p, home) => path.resolve(p.startsWith('~') ? path.join(home, p.slice(1)) : p);
export function uploadsGranted({ env = process.env, home = os.homedir(), project = env.CLAUDE_PROJECT_DIR || process.cwd(), recorded = false } = {}) {
  if (recorded) return true;
  const dir = env.CLAUDE_CONFIG_DIR;
  const files = [dir ? path.join(dir, 'settings.json') : path.join(home, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json')];
  const target = path.resolve(uploadsDir());
  return files.flatMap(additionalDirs).map((p) => expand(p, home)).some((d) => target === d || target.startsWith(d.endsWith(path.sep) ? d : d + path.sep));
}

// One plain line, not a question.
export const uploadsLine = () => `So Chrome can attach your resume to forms, type /add-dir ${uploadsDir()} and pick "Yes, and remember this directory". That remembers the folder for this project only.`;
export const uploadBlockedStep = () => `Chrome refused to upload from the uploads folder: type /add-dir ${uploadsDir()}, pick "Yes, and remember this directory", then say go on. In fill-only or open-only you can also attach the file in the form yourself.`;
