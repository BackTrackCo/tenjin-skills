import fs from 'node:fs';
import path from 'node:path';
import { graph } from './graph.mjs';
import { isYc } from './platforms.mjs';
import { ensureDir, readJson, stateDir, writeJsonAtomic } from './paths.mjs';

export const SCHEMA_VERSION = 1;
// A job's version changes only on real news about it: new data, a re-verify result, a status change. The watcher and the
// "leave it" record compare versions, never clocks.
export const bump = (job) => { job.v = (job.v || 0) + 1; };
const CHANNELS = ['x', 'linkedin', 'email', 'other'];

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
    update: { lastCheckAt: null, status: null, installed: null, waiting: null },
    consent: { unattended: null, writing: null, dryRun: { records: [], confirmedAt: null } },
    notified: {},
    shown: {},
    chrome: null,
    uploads: null,
    rc: 'unknown',
    pushSent: false,
    rcPushSaid: false,
    hostsReported: [],
    rounds: [],
    queryYield: {},
    stops: [],
    answerV: 0,
    watcher: { sent: [], fingerprint: null, notify: null },
    yc: { done: [], sites: {}, lastAt: null, remaining: 0 },
    wakes: [],
    updateLines: [],
    leads: [],
    postOutcomes: {},
    handouts: [],
    consentLog: [],
    batch: null,
    tenjin: { status: null, version: null, checkedAt: null, askedHolder: null, declinedAt: null },
    start: null,
    contactsRequested: [],
    applyYourself: [],
    posts: [],
    routed: { skipReason: null, lastSearchAt: null, lastCost: null },
    watched: null,
    hn: { seen: [], thread: null, lastRead: 0, lastAt: null, remaining: 0 },
    search: { session: null, webPending: null },
    emails: null,
    watcherEver: false,
    tenjinSetup: null,
    claims: {},
    claimEpochs: {},
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
      bump(job);
      job.statusAt = op.at || new Date().toISOString();
      if (op.to === 'submitted') { job.fillReady = null; job.submitNow = null; job.inFlight = null; }
      if (op.to === 'skipped') job.skipReason = String(op.reason || 'no reason given').slice(0, 160);
      if (op.to === 'submitted') {
        state.applications.push({ key: job.key, companyKey: companyTitleKey(job), at: job.statusAt });
      }
      break;
    }
    case 'contact':
      // A contact needs a source link, how to reach them and one thing they care about. A likely person is shown only
      // when marked not confirmed. Never a guess, and never the YC company page or a fetched LinkedIn page.
      if (!op.sourceUrl || !/^https?:\/\//.test(op.sourceUrl)) throw new Error('a contact needs a source link');
      if (isYc(op.sourceUrl) && !/news\.ycombinator\.com\/user|hn:/.test(op.sourceUrl)) throw new Error('a Y Combinator page is not a contact source');
      if (!String(op.how || '').trim()) throw new Error('a contact needs how to reach them');
      if (!String(op.cares || '').trim()) throw new Error('a contact needs one thing they care about');
      if (op.basis === 'likely' && op.notConfirmed !== true) throw new Error('a likely person is shown only when marked not confirmed');
      if (op.channel !== undefined && !CHANNELS.includes(op.channel)) throw new Error(`a contact's channel is one of ${CHANNELS.join(', ')}`);
      (state.contacts[op.key] ||= []).push({ name: op.name, title: op.title, sourceUrl: op.sourceUrl, how: op.how, cares: op.cares, channel: op.channel || null, notConfirmed: op.notConfirmed === true, ...(op.weak === true ? { weak: true } : {}) });
      break;
    case 'intro': {
      // An example intro for a contact who can be messaged. A draft, never sent. It fits its channel.
      const c = (state.contacts[op.key] || []).find((x) => x.name === op.name);
      if (!c) throw new Error('no such contact');
      if (!c.channel) throw new Error('a contact with no channel gets no intro');
      const text = String(op.text || '').trim();
      if (!text) throw new Error('an intro needs text');
      if (c.channel === 'email') {
        if (!String(op.subject || '').trim()) throw new Error('an email intro needs a subject line');
        if (text.split(/\s+/).length > 120) throw new Error('an email intro is about 120 words at most');
      } else if (text.length > 300) throw new Error('an X or LinkedIn intro is under 300 characters');
      c.intro = { channel: c.channel, subject: c.channel === 'email' ? String(op.subject) : null, text, writtenAt: op.at || new Date().toISOString(), sources: [c.sourceUrl] };
      break;
    }
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

// Fields an older version of the skill wrote to state.json. There is no converter: a state that holds one is refused with its
// name, and the person (or the model) removes it from state.json. The watch list is the profile's `watch` list, kept only on the
// person's own request.
const OLD_STATE_FIELDS = {
  found: 'boards are no longer added by the skill; the watch list is profile.watch, from the person\'s own request (J watch add)',
  removedBoards: 'it only guarded the automatic adds, which are gone',
  watchTipShown: 'the skill no longer suggests a watch list',
  dropLines: 'boards no longer drop by themselves',
};
// Fields on a job record from the LinkedIn-only option: the job-site option keeps siteLinks, siteShownAt and siteAskedV.
const OLD_JOB_FIELDS = { linkedinUrl: 'now siteLinks, one link per job site', linkedinShownAt: 'now siteShownAt', linkedinAskedV: 'now siteAskedV' };
export function oldStateFields(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const list = Object.keys(OLD_STATE_FIELDS).filter((k) => raw[k] !== undefined).map((k) => ({ field: k, why: OLD_STATE_FIELDS[k] }));
  const jobs = Object.values(raw.jobs || {});
  for (const [k, why] of Object.entries(OLD_JOB_FIELDS)) if (jobs.some((j) => j && j[k] !== undefined)) list.push({ field: `jobs.*.${k}`, why });
  if (jobs.some((j) => j && j.applyVia === 'linkedin')) list.push({ field: 'jobs.*.applyVia', why: 'the "linkedin" value is now "site"' });
  return list;
}
export const oldStateError = (list) => `state.json has ${list.length > 1 ? 'old fields' : 'an old field'} the skill no longer reads: ${list.map((o) => `${o.field} (${o.why})`).join('; ')}. Remove ${list.length > 1 ? 'them' : 'it'} from state.json, then run the command again.`;
export function readOldStateFields() {
  return oldStateFields(readJson(stateFile(), null));
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
    lease: state.lease,
    update: { status: state.update.status, waiting: state.update.waiting },
  };
}

