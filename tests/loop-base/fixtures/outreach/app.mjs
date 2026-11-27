// A GTM-shaped demo app that runs the whole loop frame: a signal comes in on a step, becomes an outreach draft, the person approves it,
// the send waits for its own yes, and a follow-up comes due after a set number of days. Tests only; it names no real app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.resolve(HERE, '..', '..', '..', '..', 'skills', 'loop-base', 'lib');
const load = (f) => import(path.join(BASE, f));
const { defineApp, setApp } = await load('app.mjs');
const { q, plain } = await load('questions.mjs');
const { transition } = await load('kinds.mjs');
const { itemVersion, notifyLine, withClaimEpoch } = await load('work.mjs');
const { loadOverlay } = await load('rules.mjs');
const { ruleValue } = await load('rules.mjs');
const { afterDays } = await load('schedule.mjs');
const email = await load('email.mjs');
const graph = JSON.parse(fs.readFileSync(path.join(HERE, 'graph.json'), 'utf8'));

const DAY = 86400000;
const empty = () => ({
  schemaVersion: 1, signals: {}, outreach: {}, lease: null, claims: {}, claimEpochs: {}, shown: {}, notified: {}, held: [], updateLines: [], consentLog: [], wakes: [], runs: [],
  update: { lastCheckAt: null, status: null, installed: null, waiting: null }, batch: null, emails: null, watcher: { sent: [], fingerprint: null, notify: null },
  consent: { unattended: null, writing: null, email: null, dryRun: { records: [], confirmedAt: null, rulesHash: null } }, sentAt: {},
});

function applyOp(state, op) {
  switch (op && op.op) {
    case 'signal': {
      if (!op.id || !op.company) throw new Error('a signal needs an id and a company');
      state.signals[op.id] ||= { id: op.id, company: op.company, person: op.person || null, address: op.address || null, text: String(op.text || '').slice(0, 200), status: 'new', at: op.at };
      break;
    }
    case 'draft': {
      const s = state.signals[op.id];
      if (!s) throw new Error(`unknown signal: ${op.id}`);
      transition(state, 'signal', s, 'drafted', op);
      state.outreach[op.id] = { id: op.id, company: s.company, to: s.address, subject: op.subject, text: op.text, status: 'drafted', at: op.at };
      break;
    }
    case 'sent': {
      const o = state.outreach[op.id];
      if (!o) throw new Error(`unknown outreach: ${op.id}`);
      transition(state, 'outreach', o, 'sent', op);
      o.sentAt = op.at;
      break;
    }
    default:
      throw new Error(`unknown op: ${op && op.op}`);
  }
}

const dueItems = (state, now) => {
  const items = [];
  for (const s of Object.values(state.signals)) if (s.status === 'new') items.push({ key: s.id, reason: 'review_signal', title: s.company });
  for (const o of Object.values(state.outreach)) {
    const d = (state.emails && state.emails.drafts) || {};
    const approved = Object.values(d).some((x) => x.to === o.to && x.status === 'approved');
    if (o.status === 'drafted' && !approved) items.push({ key: o.id, reason: 'approve_outreach', title: o.company, waitsForPerson: true });
    if (o.status === 'sent' && afterDays(Date.parse(o.sentAt), graph.followUpDays, now)) items.push({ key: o.id, reason: 'follow_up_due', title: o.company });
  }
  return items.map((i) => ({ ...i, v: itemVersion({ ...(state.signals[i.key] || state.outreach[i.key] || {}) }, ['at']), waitsForPerson: Boolean(i.waitsForPerson) }));
};

export async function buildOutreach({ skillDir, incoming = [] } = {}) {
  const { loadState } = await load('store.mjs');
  const app = defineApp({
    skillDir,
    state: { schemaVersion: 1, empty, applyOp, oldFields: () => [] },
    kinds: {
      signal: { collection: 'signals', statuses: ['new', 'drafted', 'dropped'], transitions: { new: ['drafted', 'dropped'], drafted: [], dropped: [] }, terminal: ['dropped'] },
      outreach: { collection: 'outreach', statuses: graph.statuses, transitions: graph.transitions, terminal: graph.terminal },
    },
    steps: [{ name: 'signals', run: ({ now }) => { const { applyOps } = appStore; const ops = incoming.splice(0).map((s) => ({ op: 'signal', ...s, at: new Date(now).toISOString() })); if (ops.length) applyOps(ops); } }],
    watcher: {
      codeFiles: ['manifest.json'], readProfile: () => ({}), blocking: /^(park|held|consent):/, rearm: 'run the outreach skill again to re-arm', commands: { work: 'O work --commit', watch: 'O watch' },
      wakeLine: ({ counts, notify, newNotify }) => `Outreach round: handle each item, then start O watch last. Due: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'waiting on you'}${newNotify ? `; notify: ${notify}` : ''}.`,
    },
    work: {
      list: ({ now = Date.now() } = {}) => { const s = loadState(); const items = dueItems(s, now).map((i) => ({ ...i, v: withClaimEpoch(s, i) })); const n = notifyLine(s, loadOverlay(), now); return { items, notify: n.line, notifyQuiet: Boolean(n.quiet) }; },
      roundMark: (s) => `${Object.keys(s.signals).length}`,
      waitingSetRaw: (s) => Object.fromEntries(Object.values(s.outreach).filter((o) => o.status === 'drafted').map((o) => [`send:${o.id}`, o.company])),
      notifyParts: (fresh) => [`${fresh.length} outreach draft${fresh.length > 1 ? 's wait' : ' waits'} for your yes`],
      clockFields: ['at'],
    },
    rules: { effects: () => graph.ruleEffects, lessonEffects: () => graph.lessonEffects, lessonDays: () => graph.lessonDays, lessonTemplates: {}, exempt: ['daily_send_max', 'notify_off', 'notify_quiet_hours'], hashParts: () => ({}) },
    consents: { kinds: ['unattended', 'writing', 'email'], writingScope: 'outreach_text', problems: () => [], limitsOf: (o) => ({ dailyMax: Number(ruleValue(o, 'daily_send_max')) || null }), loosened: (was, now) => was.dailyMax !== null && (now.dailyMax === null || now.dailyMax > was.dailyMax) },
    batch: { denied: [['rules', 'add']], unattendedDenied: [['approve', null]], openExtras: () => ({}) },
    email: { candidates: (s) => Object.values(s.outreach).filter((o) => o.to).map((o) => ({ ref: `outreach:${o.id}`, to: o.to, subject: o.subject, text: o.text, employer: o.company, role: '', job: null })), recipientChecks: () => null },
    questions: { noMarker: [], markers: [], firstOptionOk: [] },
    hosts: { allowed: [], never: [] },
    suppliers: [],
    release: { repo: 'Org/skills', displayName: 'Outreach', skillsCli: 'skills@1.9.0', companions: [] },
    report: {
      sections: ({ state, now }) => [[`# Outreach report, ${new Date(now).toISOString().slice(0, 10)}`, ''], [`${Object.values(state.signals).filter((s) => s.status === 'new').length} new signals; ${Object.values(state.outreach).filter((o) => o.status === 'drafted').length} drafts waiting; ${Object.values(state.outreach).filter((o) => o.status === 'sent').length} sent`], { shared: 'rules' }, { shared: 'consent' }],
    },
    cli: { order: [], commands: { watch: 'O watch' }, personCommands: [], isNews: () => false, deriveLessons: () => [] },
  });
  setApp(app);
  const appStore = await load('store.mjs');
  return { app, appStore, email, q, plain };
}
