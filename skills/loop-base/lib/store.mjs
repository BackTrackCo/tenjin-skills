import fs from 'node:fs';
import path from 'node:path';
import { getApp } from './app.mjs';
import { ensureDir, readJson, stateDir, writeJsonAtomic } from './paths.mjs';

// The state store: one lock, one file per app, atomic writes. The app's own ops and state shape come in through its declaration.
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) {
  Atomics.wait(sleepBuf, 0, 0, ms);
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function withLock(fn, { timeoutMs = 15000 } = {}) {
  const dir = ensureDir(stateDir());
  const lockFile = path.join(dir, 'state.lock');
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let text;
      try {
        text = fs.readFileSync(lockFile, 'utf8');
      } catch (er) {
        if (er.code === 'ENOENT') continue; // released between our attempt and our read
        throw er;
      }
      const holder = Number(text);
      let stale = false;
      if (text.trim() && Number.isInteger(holder) && holder > 0) stale = !pidAlive(holder);
      else {
        // empty or garbage: a holder may be mid-write, so only an old file counts as stale
        try {
          stale = Date.now() - fs.statSync(lockFile).mtimeMs > 2000;
        } catch {}
      }
      if (stale) {
        try {
          if (fs.readFileSync(lockFile, 'utf8') === text) fs.unlinkSync(lockFile);
        } catch {}
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new Error('state lock timeout');
      sleep(5);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch {}
  }
}

export function stateFile() {
  return path.join(stateDir(), 'state.json');
}

// The app declares its state shape: state: { empty(), schemaVersion, applyOp(state, op), oldFields(raw) }.
function shape() {
  const app = getApp();
  if (!app.state || typeof app.state.empty !== 'function') throw new Error(`the app ${app.name} has not declared its state shape (state.empty)`);
  return app.state;
}

export function loadState() {
  const st = shape();
  const s = readJson(stateFile(), null);
  if (!s) return st.empty();
  if (s.schemaVersion > st.schemaVersion) throw new Error(`state.json is schema ${s.schemaVersion}, newer than this code (${st.schemaVersion})`);
  return { ...st.empty(), ...s };
}

// Every read-modify-write goes through here.
export function updateState(fn) {
  return withLock(() => {
    const state = loadState();
    const out = fn(state);
    writeJsonAtomic(stateFile(), state);
    return out;
  });
}

// Every op of a batch is validated on a copy first, so a bad op lands nothing.
export function applyOps(ops) {
  const { applyOp } = shape();
  return updateState((state) => {
    const copy = JSON.parse(JSON.stringify(state));
    for (const op of ops) applyOp(copy, op);
    for (const op of ops) applyOp(state, op);
    return { applied: ops.length };
  });
}

// Fields an older version of the app wrote to state.json. There is no converter: a state that holds one is refused with its name.
export function readOldStateFields() {
  const raw = readJson(stateFile(), null);
  const { oldFields } = shape();
  return typeof oldFields === 'function' ? oldFields(raw) : [];
}
export const oldStateError = (list) => `state.json has ${list.length > 1 ? 'old fields' : 'an old field'} the skill no longer reads: ${list.map((o) => `${o.field} (${o.why})`).join('; ')}. Remove ${list.length > 1 ? 'them' : 'it'} from state.json, then run the command again.`;
