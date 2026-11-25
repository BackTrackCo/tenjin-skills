import { sha } from './dedupe.mjs';
import { canonical, rulesHash, ruleValue } from './overlay.mjs';
import { employerName } from './employer.mjs';

// Email goes out through the person's Gmail connector, which only the model can call; code decides what may go. An email
// goes only to an address the poster published in the post itself, kept only when it appeared word for word in that post
// (`emailFromPost`, set by code when the post was read). An address from people search, a team page or anywhere else is a
// draft the person sends. One email per address in 90 days, no follow-up email by the skill, no attachment.
export const REPEAT_DAYS = 90;
const DAY = 86400000;

const lower = (a) => String(a || '').trim().toLowerCase();
export const emailState = (s) => (s.emails ||= { drafts: {}, sent: {}, connector: null, modeAsked: null, log: [] });

// What could be emailed now: an intro whose address the poster published. A lead that already joined a job is its contact.
export function candidates(state) {
  const out = [];
  for (const l of state.leads || []) {
    if (l.channel !== 'email' || !l.email || l.emailFromPost !== true || !l.intro || l.joinedJob || ['done', 'not_interested'].includes(l.status)) continue;
    out.push({ ref: `lead:${l.key}`, to: l.email, subject: l.intro.subject || '', text: l.intro.text, employer: l.employer || '', role: l.role || '', job: null });
  }
  for (const [jobKey, list] of Object.entries(state.contacts || {})) {
    const job = state.jobs[jobKey];
    for (const c of list || []) {
      if (c.channel !== 'email' || !c.email || c.emailFromPost !== true || !c.intro) continue;
      out.push({ ref: `contact:${jobKey}:${c.name}`, to: c.email, subject: c.intro.subject || '', text: c.intro.text, employer: job ? job.company : '', role: job ? job.title : '', job: jobKey });
    }
  }
  return out.map((c) => ({ ...c, id: sha(canonical([lower(c.to), c.subject, c.text])).slice(0, 12) }));
}

export const mailto = ({ to, subject, text }) => `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;

// What is still to decide or to send: a candidate with no final status.
export const FINAL = ['sent', 'drafted', 'shown', 'skipped'];
export function pending(state) {
  const e = emailState(state);
  return candidates(state).filter((c) => !FINAL.includes((e.drafts[c.id] || {}).status));
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

// The checks `J email next` runs on every recipient, whatever the mode.
export function recipientProblem(state, c, overlay, profile, { unattended = false, now = Date.now() } = {}) {
  const e = emailState(state);
  const last = e.sent[lower(c.to)];
  if (last && now - Date.parse(last) < REPEAT_DAYS * DAY) return 'repeat_within_90_days';
  const excluded = (overlay.rules || []).filter((r) => r.effect === 'exclude_company').map((r) => employerName(String(r.value)));
  if (c.employer && excluded.includes(employerName(c.employer))) return 'excluded_company';
  if (unattended && c.job) {
    const floor = (profile.unattended || {}).minScore;
    const job = state.jobs[c.job];
    if (typeof floor === 'number' && !(job && typeof job.fit === 'number' && job.fit >= floor)) return 'below_score_floor';
  }
  return null;
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
    if (!d || FINAL.includes(d.status)) continue;
    // a draft-only connector sends nothing, so an unattended run may make the drafts; a send needs a yes or the consent
    const allowed = d.status === 'approved' || (unattended && (consent || via === 'drafts'));
    if (!allowed) {
      queue.push({ id: c.id, reason: unattended ? 'no_email_consent' : 'not_approved' });
      continue;
    }
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

// The DM to an X poster is the person's: code builds the link, the model never opens x.com. A profile link with the text to
// paste is the fallback; whether X's DM link can carry the text is not verified, so none is built.
export const handleIn = (how) => (/@([A-Za-z0-9_]{1,15})/.exec(String(how || '')) || [])[1] || null;
export const dmLink = (handle, text) => ({ profile: `https://x.com/${handle}`, text, prefill: false, how: 'open the profile, press Message, paste the text, press Send yourself' });

// What `J ask email` shows: the pending drafts, read without recording anything.
export const addBatchPeek = (state) => pending(state);
