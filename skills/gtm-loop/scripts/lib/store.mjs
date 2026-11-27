import fs from 'node:fs';
import path from 'node:path';
import { graph } from './graph.mjs';
import { ensureDir, readJson, stateDir, writeJsonAtomic } from './paths.mjs';

export const SCHEMA_VERSION = 1;
// A lead's version changes only on real news about it: new data, a review, a status change. The watcher and the "leave it" record
// compare versions, never clocks.
export const bump = (lead) => { lead.v = (lead.v || 0) + 1; };

export function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    leads: {},
    people: {},
    ids: {},
    companies: {},
    suppress: { ids: {}, domains: {} },
    contacted: {},
    emails: { drafts: {}, sent: {}, connector: null, log: [] },
    consent: { email: null, dryRun: { records: [], confirmedAt: null, rulesHash: null } },
    signals: { counts: {} },
    held: [],
    lease: null,
    update: { lastCheckAt: null, status: null, waiting: null },
    updateLines: [],
    notified: {},
    shown: {},
    batch: null,
    tenjin: { status: null, version: null, checkedAt: null, askedAt: null, declinedAt: null },
    start: null,
    wakes: [],
    runs: [],
    rounds: [],
    phraseYield: {},
    spend: [],
    routed: { lastSearchAt: null, lastCost: null, roundLock: null },
    hn: { lastAt: null },
    search: { lastAt: null },
    watcher: { sent: [], fingerprint: null, notify: null },
    watcherEver: false,
    pushSent: false,
    rc: 'unknown',
    claims: {},
    left: {},
    handouts: [],
    outreach: [],
    reviewHand: [],
    writeHand: [],
    consentLog: [],
  };
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleepBuf, 0, 0, ms);
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

export const stateFile = () => path.join(stateDir(), 'state.json');

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

const score = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;

export function applyOp(state, op) {
  const g = graph();
  if (!op || !g.ops.includes(op.op)) throw new Error(`unknown op: ${op && op.op}`);
  const lead = op.key ? state.leads[op.key] : null;
  if (op.key && !lead) throw new Error(`unknown lead: ${op.key}`);
  switch (op.op) {
    case 'rank':
      if (![op.fit, op.intent, op.timing].every(score)) throw new Error('rank needs fit, intent and timing, each 0..100');
      lead.scores = { fit: op.fit, intent: op.intent, timing: op.timing, avg: Math.round((op.fit + op.intent + op.timing) / 3) };
      lead.line = String(op.line || '').slice(0, 240);
      lead.quote = String(op.quote || '').slice(0, 240);
      lead.channelProposed = op.channel || null;
      lead.reviewedHash = lead.hash;
      break;
    case 'warn':
      lead.warnings = [...new Set([...(lead.warnings || []), String(op.warning).slice(0, 120)])];
      break;
    case 'transition': {
      const allowed = g.transitions[lead.status] || [];
      if (!g.statuses.includes(op.to) || !allowed.includes(op.to)) throw new Error(`illegal transition ${lead.status} -> ${op.to}`);
      lead.status = op.to;
      bump(lead);
      lead.statusAt = op.at || new Date().toISOString();
      if (op.to === 'skipped') lead.skipReason = String(op.reason || 'no reason given').slice(0, 160);
      break;
    }
    case 'draft': {
      // One draft per channel the person may pick; `draft` is the one for the proposed channel.
      const d = { channel: op.channel, subject: op.subject || null, text: String(op.text), whyNow: String(op.whyNow || ''), sourceUrl: op.sourceUrl || lead.url, writtenAt: op.at || new Date().toISOString() };
      lead.drafts = { ...(lead.drafts || {}), [op.channel]: d };
      if (!lead.draft || op.channel === lead.channelProposed) lead.draft = d;
      break;
    }
    case 'signal': {
      const k = op.kind + (op.reason ? `:${op.reason}` : '');
      state.signals.counts[k] = (state.signals.counts[k] || 0) + 1;
      break;
    }
  }
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

export function view(state, { limit = 30 } = {}) {
  const counts = {};
  for (const l of Object.values(state.leads)) counts[l.status] = (counts[l.status] || 0) + 1;
  const open = Object.values(state.leads).filter((l) => !graph().terminal.includes(l.status));
  return {
    counts,
    leads: open.slice(0, limit).map((l) => ({ key: l.key, source: l.source, author: l.author || null, status: l.status, avg: l.scores ? l.scores.avg : null })),
    truncated: Math.max(0, open.length - limit),
    held: state.held,
    lease: state.lease,
  };
}
