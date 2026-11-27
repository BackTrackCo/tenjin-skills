import { graph } from './graph.mjs';
import { applyOp } from './store.mjs';
import { sha, contactProblem, contactedInfo, markContacted, isSuppressed, suppressPerson, suppressDomain, personDomain } from './dedupe.mjs';
import { canonical, capOf } from './overlay.mjs';
import { emailConsentCurrent, dryRunDone, recordDryRun } from './consent.mjs';
import { domainOfEmail } from './postinfo.mjs';
import { offerOfLead } from './offers.mjs';

// Email goes out through the person's Gmail connector, which only the model can call; code decides what may go. These are the
// gates (SKILL.md gates 1 to 6): a recorded yes for the exact address and text, a footer built here and never edited, an address
// that is published or found-and-valid, a draft instead of a send for Germany, Austria, Canada and Australia, one contact per
// person, suppression checked at handout, and a handout that is never repeated.
const DAY = 86400000;
const lower = (a) => String(a || '').trim().toLowerCase();
export const emailState = (s) => (s.emails ||= { drafts: {}, sent: {}, connector: null, log: [] });
export const MODES = ['send', 'drafts', 'none'];
export const FINAL = ['sent', 'drafted', 'shown', 'skipped', 'failed'];

// ---- the footer ------------------------------------------------------------------------------------------------------
const PLATFORM = { x: 'X', reddit: 'Reddit', linkedin: 'LinkedIn', hn: 'Hacker News', web: 'the web' };
export function sourceText(lead) {
  if (lead.kind === 'fit') return `a search for people in your role at your company${lead.signalUrl ? `, and your recent post: ${lead.signalUrl}` : ''}`;
  return `your post on ${PLATFORM[lead.source] || 'the web'}: ${lead.url}`;
}
export const needsNotice = (country) => !country || graph().noticeCountries.includes(country);

// Built here, from the profile and the lead, and nowhere else. No postal address, no email.
export function buildFooter({ profile, lead, country, addressSource }) {
  const s = profile.sender || {};
  const offer = offerOfLead(profile, lead);
  if (!String(s.postal || '').trim()) throw new Error('no postal address: an email needs the sender\'s postal address');
  if (!String(s.name || '').trim()) throw new Error('no sender name');
  if (!String(offer.name || '').trim()) throw new Error('no offer name');
  const f = graph().footer;
  const vars = { senderName: s.name, senderCompany: s.company || '', postalAddress: s.postal, source: sourceText(lead), offerName: offer.name };
  let lines = f.lines.map((l) => l.replace(/\{(\w+)\}/g, (_, k) => vars[k]));
  if (!s.company) lines = lines.map((l, i) => (i === 0 ? s.name : l));
  if (needsNotice(country)) lines.push(f.notice.replace('{dataSource}', addressSource === 'post' ? 'the address you published in your post' : 'a work-email lookup and your public profile'));
  return lines.join('\n');
}
export const withFooter = (body, footer) => `${String(body).trim()}\n\n--\n${footer}`;

// ---- the address -----------------------------------------------------------------------------------------------------
// published: the lead's own post held it. lookup: found by name and company domain, then checked. A found free-mail address is
// dropped; a found address is used only at the person's company domain and only when the check said `valid`.
export function addressFor(state, lead) {
  const p = state.people[lead.personKey];
  if (!p) return { problem: 'no_person' };
  const posted = p.emails.find((e) => e.source === 'post');
  if (posted) return { addr: posted.addr, source: 'post', status: null };
  const found = p.emails.filter((e) => e.source === 'lookup');
  if (!found.length) return { problem: 'no_address' };
  const free = found.find((e) => graph().freeMail.includes(domainOfEmail(e.addr)));
  const usable = found.find((e) => !graph().freeMail.includes(domainOfEmail(e.addr)));
  if (!usable) return { problem: free ? 'free_mail_dropped' : 'no_address' };
  const dom = personDomain({ ...p, emails: [] }) || p.domain;
  const d = domainOfEmail(usable.addr);
  if (dom && !(d === dom || d.endsWith(`.${dom}`) || dom.endsWith(`.${d}`))) return { problem: 'not_at_company_domain' };
  if (usable.status !== 'valid') return { problem: usable.status ? `not_valid:${usable.status}` : 'not_checked' };
  return { addr: usable.addr, source: 'lookup', status: 'valid' };
}

export const mailto = ({ to, subject, text }) => `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
export const isMustDraft = (country, source) => source === 'lookup' && graph().draftCountries.includes(country);

// The effective way an email leaves: the connector's mode, lowered to drafts for a found address in a draft-only country.
export function viaOf(state, c) {
  const mode = MODES.includes(emailState(state).connector) ? emailState(state).connector : 'none';
  if (mode === 'send' && c.mustDraft) return 'drafts';
  return mode;
}

// ---- the candidate and the approval -------------------------------------------------------------------------------------
// What the person says yes to: the exact address and the exact text, footer included. The id is the hash of both, so a changed
// word is a different email and needs its own yes.
export function buildCandidate(state, lead, profile) {
  const d = lead.drafts && lead.drafts.email;
  if (!d) throw new Error('the lead has no email draft');
  const a = addressFor(state, lead);
  if (a.problem) throw new Error(`no address to send to (${a.problem})`);
  const p = state.people[lead.personKey];
  const country = p.country || null;
  const footer = buildFooter({ profile, lead, country, addressSource: a.source });
  const text = withFooter(d.text, footer);
  const subject = d.subject;
  const id = sha(canonical([lower(a.addr), subject, text])).slice(0, 12);
  return { id, leadKey: lead.key, personKey: lead.personKey, to: a.addr, subject, text, source: a.source, country, notice: needsNotice(country), mustDraft: isMustDraft(country, a.source), footer };
}

// The person's yes for this exact email. `by` is the person (an attended turn) or consent (an unattended batch).
export function approveEmail(state, lead, profile, { expectId = null, by = 'person', now = Date.now() } = {}) {
  if (lead.status !== 'picked' && !(by === 'consent' && lead.status === 'drafted')) throw new Error(`the lead is ${lead.status}: pick Email for it first`);
  if (!(lead.pick && lead.pick.channel === 'email') && by !== 'consent') throw new Error('the pick for this lead is not email');
  const problem = contactProblem(state, lead.personKey, { followUp: lead.followUp || null, now });
  if (problem) throw new Error(`refused: ${problem}`);
  const c = buildCandidate(state, lead, profile);
  if (expectId && expectId !== c.id) throw new Error('the yes names an email that has changed: ask again');
  const e = emailState(state);
  const have = e.drafts[c.id];
  if (have && FINAL.includes(have.status)) throw new Error(`that email is ${have.status}`);
  e.drafts[c.id] = { ...(have || {}), id: c.id, leadKey: c.leadKey, personKey: c.personKey, to: c.to, subject: c.subject, text: c.text, source: c.source, country: c.country, mustDraft: c.mustDraft, status: 'approved', approvedAt: new Date(now).toISOString(), approvedBy: by };
  if (lead.status === 'drafted') {
    lead.pick = { channel: 'email', at: new Date(now).toISOString(), by };
    applyOp(state, { op: 'transition', key: lead.key, to: 'picked', at: lead.pick.at });
  }
  applyOp(state, { op: 'transition', key: lead.key, to: 'approved', at: new Date(now).toISOString() });
  return { id: c.id, to: c.to, via: viaOf(state, c) };
}

// ---- the handout -----------------------------------------------------------------------------------------------------
// One handout at a time, only for an approved email (or, in an unattended batch under the consent and a confirmed dry run, an
// email code approved on the consent) that passes every check again. The model sends exactly what is handed out.
// A handout that has no recorded result is never handed out again: it becomes `unknown`.
export function settleHandouts(state, now = Date.now()) {
  const e = emailState(state);
  const unknown = [];
  for (const d of Object.values(e.drafts)) {
    if (d.status === 'handed_out') { d.status = 'unknown'; d.unknownAt = new Date(now).toISOString(); }
    if (d.status === 'unknown') unknown.push({ id: d.id, to: d.to, subject: d.subject, handedAt: d.handedAt });
  }
  return unknown;
}

export function recipientProblem(state, d, profile, overlay, { now = Date.now() } = {}) {
  const e = emailState(state);
  const lead = state.leads[d.leadKey];
  if (!lead) return 'no_lead';
  const sup = isSuppressed(state, d.personKey);
  if (sup) return `suppressed:${sup}`;
  if (state.suppress.ids[`email:${lower(d.to)}`]) return 'suppressed:address';
  // One contact per person on any channel, unless this email is the person's own follow-up, allowed once by their rule.
  const cp = contactProblem(state, d.personKey, { followUp: lead.followUp || null, now });
  if (cp) return cp;
  if (!lead.followUp && e.sent[lower(d.to)]) return 'already_contacted';
  const s = profile.sender || {};
  if (!String(s.postal || '').trim()) return 'no_postal_address';
  if (!String(s.name || '').trim()) return 'no_sender_name';
  const a = addressFor(state, lead);
  if (a.problem || lower(a.addr) !== lower(d.to)) return `address:${a.problem || 'changed'}`;
  const cap = capOf(overlay, 'emails_per_day');
  if (cap !== null && e.log.filter((x) => now - Date.parse(x.at) < DAY).length >= cap) return 'emails_per_day';
  return null;
}

export function nextEmail(state, { profile, overlay, unattended = false, now = Date.now() }) {
  const e = emailState(state);
  const unknown = settleHandouts(state, now);
  const queue = unknown.map((u) => ({ id: u.id, reason: 'unknown' }));
  const consent = emailConsentCurrent(state, profile, overlay);
  const dry = dryRunDone(state, profile, overlay);
  for (const d of Object.values(e.drafts)) {
    if (d.status !== 'approved') continue;
    // an unattended batch hands out only an email approved on the consent or by a person earlier; with no consent, only drafts
    const problem = recipientProblem(state, d, profile, overlay, { now });
    if (problem) {
      queue.push({ id: d.id, reason: problem });
      if (problem.startsWith('suppressed') || problem === 'already_contacted') d.status = 'skipped';
      continue;
    }
    let via = viaOf(state, d);
    if (unattended) {
      if (via === 'send' && !(consent && dry)) via = consent ? 'dry_run' : 'drafts';
      if (via === 'none') via = 'drafts';
    }
    if (via === 'dry_run') {
      if (!state.consent.dryRun.records.some((r) => r.id === d.id)) recordDryRun(state, { id: d.id, to: d.to, subject: d.subject, at: new Date(now).toISOString() });
      queue.push({ id: d.id, reason: 'dry_run_recorded' });
      continue;
    }
    d.status = 'handed_out';
    d.handedAt = new Date(now).toISOString();
    d.via = via;
    return { handout: { id: d.id, to: d.to, subject: d.subject, text: d.text, via, mailto: mailto(d), instruction: via === 'send' ? "Send with the connected Gmail tool's send, from the person's own address, to this address only, with exactly this subject and text. Then run G email sent <id> <message id>." : via === 'drafts' ? "Make a Gmail draft with the connected tool's draft function, to this address, with exactly this subject and text; the person presses Send. Then run G email sent <id> <draft id> --how drafted." : 'Show the person the text with the mailto link; they send it from their own mail app. Then run G email sent <id> --how shown.' }, queue };
  }
  return { handout: null, queue };
}

// The result: sent (a send went), drafted (a Gmail draft exists, the send is the person's) or shown (the mailto text). Any of the
// three counts as contacting that person.
export function markSent(state, id, { messageId = null, threadId = null, how = 'sent', now = Date.now() } = {}) {
  const e = emailState(state);
  const d = e.drafts[id];
  if (!d) throw new Error(`unknown email: ${id}`);
  if (!['sent', 'drafted', 'shown'].includes(how)) throw new Error('how is sent, drafted or shown');
  if (d.status !== 'handed_out') throw new Error(`that email is ${d.status}, not handed out${d.status === 'unknown' ? ': record what happened with G email unknown <id> sent|not_sent' : ''}`);
  return finishSend(state, d, { messageId, threadId, how, now });
}

function finishSend(state, d, { messageId, threadId, how, now }) {
  const e = emailState(state);
  const at = new Date(now).toISOString();
  Object.assign(d, { status: how, messageId, threadId, sentAt: at });
  e.sent[lower(d.to)] = at;
  e.log.push({ id: d.id, to: d.to, how, at });
  if (e.log.length > 500) e.log.splice(0, e.log.length - 500);
  const lead = state.leads[d.leadKey];
  if (lead && lead.status === 'approved') applyOp(state, { op: 'transition', key: lead.key, to: 'contacted', at });
  markContacted(state, d.personKey, { channel: 'email', leadKey: d.leadKey, followUp: Boolean(lead && lead.followUp), now });
  state.outreach.push({ at, key: d.leadKey, personKey: d.personKey, channel: 'email', emailId: d.id });
  return { id: d.id, status: how };
}

// The person says whether an unknown handout went.
export function resolveUnknown(state, id, outcome, now = Date.now()) {
  const d = emailState(state).drafts[id];
  if (!d || d.status !== 'unknown') throw new Error('that email is not unknown');
  if (outcome === 'sent') return finishSend(state, d, { messageId: null, threadId: null, how: 'sent', now });
  if (outcome === 'not_sent') {
    d.status = 'failed';
    d.failedAt = new Date(now).toISOString();
    const lead = state.leads[d.leadKey];
    if (lead && lead.status === 'approved') applyOp(state, { op: 'transition', key: lead.key, to: 'picked' });
    return { id, status: 'failed', note: 'it needs a new yes: G email approve' };
  }
  throw new Error('outcome is sent or not_sent');
}

export const pendingApproved = (state) => Object.values(emailState(state).drafts).filter((d) => d.status === 'approved');
export const unknownList = (state) => Object.values(emailState(state).drafts).filter((d) => d.status === 'unknown');

// ---- replies ---------------------------------------------------------------------------------------------------------
// Only the threads this skill sent. The model reads each thread `G replies due` names; code records the outcome.
export const REPLY_DAYS = 30;
export function repliesDue(state, now = Date.now()) {
  return Object.values(emailState(state).drafts).filter((d) => d.status === 'sent' && d.threadId && !d.replyAt && now - Date.parse(d.sentAt) < REPLY_DAYS * DAY).map((d) => ({ id: d.id, to: d.to, subject: d.subject, threadId: d.threadId, messageId: d.messageId, sentAt: d.sentAt }));
}
export const hasOptOutWord = (text) => {
  const t = String(text || '').toLowerCase();
  return graph().optOutWords.some((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(t));
};

// kind: replied | opt_out | bounce | not_interested. A reply is marked replied (it ends any follow-up). An opt-out word in its text,
// a bounce or "not interested" suppresses that person for good; a request to stop the company suppresses its domain.
export function recordReply(state, id, kind, { text = '', company = false, now = Date.now() } = {}) {
  const d = emailState(state).drafts[id];
  if (!d) throw new Error(`unknown email: ${id}`);
  if (!['replied', 'opt_out', 'bounce', 'not_interested'].includes(kind)) throw new Error('kind is replied, opt_out, bounce or not_interested');
  const at = new Date(now).toISOString();
  d.replyAt = at;
  d.replyKind = kind;
  const effective = kind === 'replied' && hasOptOutWord(text) ? 'opt_out' : kind;
  const c = contactedInfo(state, d.personKey);
  if (c) for (const i of Object.keys(state.contacted)) if (state.contacted[i] === c) state.contacted[i] = { ...c, replied: true };
  const lead = state.leads[d.leadKey];
  const out = { id, kind: effective };
  if (effective === 'replied') {
    if (lead && lead.status === 'contacted') applyOp(state, { op: 'transition', key: lead.key, to: 'replied', at });
    return out;
  }
  if (lead && lead.status === 'contacted') applyOp(state, { op: 'transition', key: lead.key, to: 'replied', at });
  suppressPerson(state, d.personKey, effective, now);
  if (effective === 'bounce') state.suppress.ids[`email:${lower(d.to)}`] = { reason: 'bounce', at };
  if (company) {
    const dom = domainOfEmail(d.to);
    out.domain = suppressDomain(state, dom, 'company_opt_out', now).suppressed;
  }
  return out;
}

