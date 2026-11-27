import { getApp } from './app.mjs';
import { canonical, sha } from './hash.mjs';
import { rulesHash } from './rules.mjs';

// Email goes out through the person's Gmail connector, which only the model can call; code decides what may go. The app declares what
// could be sent and its own checks on a recipient:
//   email: { candidates(state) -> [{ ref, to, subject, text, employer, role, job, ownYesOnly? }], recipientChecks(state, c, overlay, profile, ctx) }
// One email per address in 90 days, no follow-up email by the skill, no attachment. A candidate marked `ownYesOnly` is never sent under the
// email consent or in an unattended turn: it waits for its own yes. This file is a gate file for every app that uses it.
const decl = () => {
  const e = getApp().email;
  if (!e || typeof e.candidates !== 'function') throw new Error(`the app ${getApp().name} has not declared its email candidates`);
  return e;
};
export const REPEAT_DAYS = 90;
const DAY = 86400000;

const lower = (a) => String(a || '').trim().toLowerCase();
export const emailState = (s) => (s.emails ||= { drafts: {}, sent: {}, connector: null, modeAsked: null, log: [] });

// What could be emailed now: the app's candidates, each with an id from its address, subject and text.
export function candidates(state) {
  return decl().candidates(state).map((c) => ({ ...c, id: sha(canonical([lower(c.to), c.subject, c.text])).slice(0, 12) }));
}

export const mailto = ({ to, subject, text }) => `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;

// What is still to decide or to send: a candidate with no final status.
export const FINAL = ['sent', 'drafted', 'shown', 'skipped'];
export function pending(state) {
  const e = emailState(state);
  return candidates(state).filter((c) => !FINAL.includes((e.drafts[c.id] || {}).status));
}
// The drafts that are work or a wait for the person: one to an address already approached within 90 days can never be sent, so it
// is not an item that comes back (the handout queue still names it).
export function due(state, now = Date.now()) {
  const e = emailState(state);
  return pending(state).filter((c) => !(e.sent[lower(c.to)] && now - Date.parse(e.sent[lower(c.to)]) < REPEAT_DAYS * DAY));
}

export function addBatch(state, now = Date.now()) {
  const e = emailState(state);
  const list = pending(state);
  for (const c of list) if (!e.drafts[c.id]) e.drafts[c.id] = { id: c.id, ref: c.ref, to: c.to, subject: c.subject, status: 'pending', addedAt: new Date(now).toISOString() };
  return list;
}

export const emailConsentCurrent = (state, profile, overlay) => Boolean(state.consent.email && state.consent.email.rulesHash === rulesHash(profile, overlay));
export function recordEmailConsent(state, profile, overlay, now = Date.now()) {
  state.consent.email = { rulesHash: rulesHash(profile, overlay), at: new Date(now).toISOString() };
  return state.consent.email;
}

// The checks `J email next` runs on every recipient, whatever the mode: the one-per-address rule here, the app's own checks after it.
export function recipientProblem(state, c, overlay, profile, { unattended = false, now = Date.now() } = {}) {
  const e = emailState(state);
  const last = e.sent[lower(c.to)];
  if (last && now - Date.parse(last) < REPEAT_DAYS * DAY) return 'repeat_within_90_days';
  const checks = decl().recipientChecks;
  return typeof checks === 'function' ? checks(state, c, overlay, profile, { unattended, now }) || null : null;
}

// One handout at a time, only for an approved draft (or any pending one under the email consent, unattended) that still
// matches its recorded hash and passes the recipient checks. The model sends exactly what is handed out.
export function nextEmail(state, { profile, overlay, unattended = false, now = Date.now() }) {
  const e = emailState(state);
  const consent = emailConsentCurrent(state, profile, overlay);
  const queue = [];
  const via = e.connector === 'send' || e.connector === 'drafts' ? e.connector : 'none';
  for (const c of candidates(state)) {
    const d = e.drafts[c.id];
    if (!d) { queue.push({ id: c.id, reason: 'not_in_batch' }); continue; } // never added by `J email batch`: say so
    if (FINAL.includes(d.status)) continue;
    // a draft-only connector sends nothing, so an unattended run may make the drafts; a send needs a yes or the consent
    const allowed = d.status === 'approved' || (!c.ownYesOnly && unattended && (consent || via === 'drafts'));
    if (!allowed) {
      queue.push({ id: c.id, reason: unattended ? 'no_email_consent' : 'not_approved' });
      continue;
    }
    // handed out and not yet marked sent: the same draft is not handed out again for half an hour
    if (d.handedAt && now - Date.parse(d.handedAt) < 30 * 60000) { queue.push({ id: c.id, reason: 'handed_out' }); continue; }
    const problem = recipientProblem(state, c, overlay, profile, { unattended, now });
    if (problem) {
      queue.push({ id: c.id, reason: problem });
      continue;
    }
    d.handedAt = new Date(now).toISOString();
    return { handout: { id: c.id, to: c.to, subject: c.subject, text: c.text, attachments: [], via, mailto: mailto(c), instruction: via === 'send' ? "Send with the connector's send tool, from the person's own Gmail, to this address only." : via === 'drafts' ? "Make a Gmail draft with the connector's draft tool; the person presses Send." : 'Show the text with the mailto link; the person sends it.' }, queue };
  }
  return { handout: null, queue };
}

export function markSent(state, id, { messageId = null, how = 'sent', now = Date.now() } = {}) {
  const e = emailState(state);
  const d = e.drafts[id];
  if (!d) throw new Error(`unknown draft: ${id}`);
  if (!['sent', 'drafted', 'shown'].includes(how)) throw new Error('how is sent, drafted or shown');
  d.status = how;
  d.messageId = messageId;
  d.at = new Date(now).toISOString();
  e.sent[lower(d.to)] = d.at; // an address approached by any of the three counts for 90 days
  e.log.push({ id, to: d.to, how, at: d.at });
  if (e.log.length > 300) e.log.splice(0, e.log.length - 300);
  return { id, status: how };
}

export function approve(state, ids, { skipRest = false, now = Date.now() } = {}) {
  const e = emailState(state);
  const list = pending(state);
  const known = new Set(list.map((c) => c.id));
  for (const id of ids) if (!known.has(id) || !e.drafts[id]) throw new Error(`no pending draft: ${id}`);
  for (const c of list) {
    const d = e.drafts[c.id];
    if (!d) continue;
    if (ids.includes(c.id)) Object.assign(d, { status: 'approved', approvedAt: new Date(now).toISOString() });
    else if (skipRest) d.status = 'skipped';
  }
  return { approved: ids.length };
}

// What `J ask email` shows: the pending drafts, read without recording anything.
export const addBatchPeek = (state) => pending(state);
