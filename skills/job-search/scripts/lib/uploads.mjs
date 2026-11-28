import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, stateDir } from './paths.mjs';

// The files a form takes live in their own folder, apart from the state files; each is copied into the working folder only for the moment of an upload.
export const uploadsDir = () => path.join(stateDir(), 'uploads');
export const ensureUploads = () => {
  const d = ensureDir(uploadsDir());
  fs.chmodSync(d, 0o700);
  return d;
};

// A copy of the file for Chrome, under the original's own name (the employer sees the name of the file that is uploaded). The original is never touched.
const safeName = (n) => String(n || '').replace(/[\\/\u0000-\u001f]/g, '').replace(/^\.+/, '').trim();
export function copyToUploads(src, name = null) {
  const dir = ensureUploads();
  const dest = path.join(dir, safeName(name) || safeName(path.basename(src)) || `resume${path.extname(src).toLowerCase()}`);
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

// ---- staging in the working folder ---------------------------------------------------------------------------
// Chrome uploads only from folders the session may read, so no grant is asked for: just before each upload code copies the file into
// a hidden folder in the session's own working folder, under its own name (the employer sees it), and deletes the copy and the folder
// right after. Only that exact folder name is ever touched in the working folder: never read, listed, written or deleted otherwise.
export const STAGE_DIR = '.job-search-upload';
export const workingFolder = (env = process.env) => env.CLAUDE_PROJECT_DIR || process.cwd();
export const stageDirOf = (folder = workingFolder()) => path.join(folder, STAGE_DIR);
export const stagedPathFor = (src, folder = workingFolder()) => path.join(stageDirOf(folder), path.basename(src));
const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch { return null; } };

export function stageUpload(src, { folder = workingFolder() } = {}) {
  const dir = stageDirOf(folder);
  const st = lstatOrNull(dir);
  // A link or a file under that name is never followed or replaced.
  if (st && !st.isDirectory()) return { ok: false, why: `${STAGE_DIR} in the working folder is a ${st.isSymbolicLink() ? 'link' : 'file'}, so nothing was copied` };
  if (!src || !fs.existsSync(src)) return { ok: false, why: 'the file to upload is missing' };
  try {
    if (!st) fs.mkdirSync(dir, { mode: 0o700 });
    const dest = stagedPathFor(src, folder);
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o600);
    return { ok: true, path: dest, name: path.basename(src) };
  } catch (e) {
    try { if (!st) fs.rmdirSync(dir); } catch {}
    return { ok: false, why: `the working folder cannot be written (${e.code || e.message})` };
  }
}

// Removes the staging folder, by that exact name, when it is a real folder. A link or a file by that name is left alone.
export function removeStage({ folder = workingFolder() } = {}) {
  const dir = stageDirOf(folder);
  const st = lstatOrNull(dir);
  if (!st || !st.isDirectory()) return { removed: false };
  fs.rmSync(dir, { recursive: true, force: true });
  return { removed: true };
}
