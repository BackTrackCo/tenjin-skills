import fs from 'node:fs';
import path from 'node:path';
import { graph } from './graph.mjs';
import { ensureDir, readJson, stateDir, writeJsonAtomic } from './paths.mjs';

export const SCHEMA_VERSION = 1;

export function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    jobs: {},
    dedupe: {},
    sources: {},
    sweep: { lastAt: null },
    approvals: {},
    applications: [],
    contacts: {},
    signals: { counts: {}, observations: [] },
    held: [],
    lease: null,
    setup: { stage: null, next: null, deepseek: null },
    update: { lastCheckAt: null, status: null, installed: null, waiting: null },
    consent: { unattended: null, writing: null, dryRun: { records: [], confirmedAt: null } },
    notified: {},
    rounds: [],
    queryYield: {},
    stops: [],
    contactsRequested: [],
    applyYourself: [],
    posts: [],
    routed: { skipReason: null, lastSearchAt: null, lastCost: null },
    watched: null,
    hn: { seen: [], lastAt: null, remaining: 0 },
  };
}

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

export function loadState() {
  const s = readJson(stateFile(), null);
  if (!s) return emptyState();
  if (s.schemaVersion > SCHEMA_VERSION) throw new Error(`state.json is schema ${s.schemaVersion}, newer than this code (${SCHEMA_VERSION})`);
  return { ...emptyState(), ...s };
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

export function applyOp(state, op) {
  const g = graph();
  if (!op || !g.ops.includes(op.op)) throw new Error(`unknown op: ${op && op.op}`);
  const job = op.key ? state.jobs[op.key] : null;
  if (op.key && !job && op.op !== 'contact') throw new Error(`unknown job: ${op.key}`);
  switch (op.op) {
    case 'rank':
      if (typeof op.fit !== 'number' || op.fit < 0 || op.fit > 100) throw new Error('rank needs fit 0..100');
      job.fit = op.fit;
      job.fitLine = String(op.line || '').slice(0, 200);
      job.reviewedHash = job.hash;
      break;
    case 'warn':
      job.warnings = [...new Set([...(job.warnings || []), String(op.warning).slice(0, 120)])];
      break;
    case 'transition': {
      const allowed = g.transitions[job.status] || [];
      if (!g.statuses.includes(op.to) || !allowed.includes(op.to)) throw new Error(`illegal transition ${job.status} -> ${op.to}`);
      job.status = op.to;
      job.statusAt = op.at || new Date().toISOString();
      if (op.to === 'submitted') {
        state.applications.push({ key: job.key, companyKey: companyTitleKey(job), at: job.statusAt });
      }
      break;
    }
    case 'contact':
      if (!op.sourceUrl) throw new Error('a contact needs a source link');
      (state.contacts[op.key] ||= []).push({ name: op.name, title: op.title, sourceUrl: op.sourceUrl });
      break;
    case 'draft':
      job.drafts = { ...(job.drafts || {}), [op.field]: String(op.text) };
      break;
    case 'approve':
      if (!job.sheet || job.sheet.hash !== op.sheetHash) throw new Error('the yes must name this job and its current sheet hash');
      state.approvals[op.key] = { sheetHash: op.sheetHash, at: op.at || new Date().toISOString() };
      break;
    case 'signal': {
      const k = op.kind + (op.reason ? `:${op.reason}` : '');
      state.signals.counts[k] = (state.signals.counts[k] || 0) + 1;
      break;
    }
  }
}

export function normLabel(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
export function companyTitleKey(job) {
  return `${normLabel(job.company)}|${normLabel(job.title)}`;
}

export function applyOps(ops) {
  return updateState((state) => {
    // validate the whole batch on a copy first, so a bad op lands nothing
    const copy = JSON.parse(JSON.stringify(state));
    for (const op of ops) applyOp(copy, op);
    for (const op of ops) applyOp(state, op);
    return { applied: ops.length };
  });
}

export function view(state, { keys, limit = 30 } = {}) {
  const counts = {};
  for (const j of Object.values(state.jobs)) counts[j.status] = (counts[j.status] || 0) + 1;
  const pick = (j) => ({ key: j.key, title: j.title, company: j.company, status: j.status, fit: j.fit ?? null, parked: j.parked ? j.parked.reasons : null });
  let jobs = Object.values(state.jobs).filter((j) => !graph().terminal.includes(j.status));
  if (keys) jobs = keys.map((k) => state.jobs[k]).filter(Boolean);
  return {
    counts,
    jobs: jobs.slice(0, limit).map(pick),
    truncated: Math.max(0, jobs.length - limit),
    held: state.held,
    setup: state.setup,
    lease: state.lease,
    update: { status: state.update.status, waiting: state.update.waiting },
  };
}

export function compact(state, now = Date.now(), days = 30) {
  const cutoff = now - days * 86400000;
  const archive = [];
  for (const [k, j] of Object.entries(state.jobs)) {
    if (graph().terminal.includes(j.status) && Date.parse(j.statusAt || j.lastSeen || 0) < cutoff) {
      archive.push(j);
      state.dedupe[k] = 1;
      state.dedupe[`ct:${companyTitleKey(j)}`] = 1;
      delete state.jobs[k];
    }
  }
  if (archive.length) {
    const dir = ensureDir(path.join(stateDir(), 'archive'));
    const file = path.join(dir, `${new Date(now).toISOString().slice(0, 7)}.jsonl`);
    fs.appendFileSync(file, archive.map((j) => JSON.stringify(j)).join('\n') + '\n', { mode: 0o600 });
  }
  return archive.length;
}
