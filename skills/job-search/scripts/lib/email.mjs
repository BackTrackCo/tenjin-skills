import { extendApp } from '../../../loop-base/lib/app.mjs';
import * as base from '../../../loop-base/lib/email.mjs';
import { employerName } from './employer.mjs';
import './paths.mjs';

// The email core (the drafts, the one-address-in-90-days rule, the hand-out, the consent) is the loop base's. Email goes out through the
// person's Gmail connector, which only the model can call; code decides what may go. An email goes only to an address the poster
// published in the post itself, kept only when it appeared word for word in that post (`emailFromPost`, set by code when the post was
// read). An address from people search, a team page or anywhere else is a draft the person sends. No follow-up email by the skill, no
// attachment. Job Search declares its candidates and its recipient checks.

// What could be emailed now: an intro whose address the poster published. A lead that already joined a job is its contact.
function jobCandidates(state) {
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
  // A referral request: the only address allowed is one the person typed in the session for that referrer (`J referral email`); never
  // a found, guessed or looked-up address. It is never sent without its own yes, and never under the email consent.
  for (const r of state.referralEmails || []) out.push({ ref: `referral:${r.id}`, to: r.to, subject: r.subject, text: r.text, employer: r.company, role: '', job: null, ownYesOnly: true });
  return out;
}

// The checks `J email next` runs on every recipient after the base's one-per-address rule.
function recipientChecks(state, c, overlay, profile, { unattended = false } = {}) {
  const excluded = (overlay.rules || []).filter((r) => r.effect === 'exclude_company').map((r) => employerName(String(r.value)));
  if (c.employer && excluded.includes(employerName(c.employer))) return 'excluded_company';
  if (unattended && c.job) {
    const floor = (profile.unattended || {}).minScore;
    const job = state.jobs[c.job];
    if (typeof floor === 'number' && !(job && typeof job.fit === 'number' && job.fit >= floor)) return 'below_score_floor';
  }
  return null;
}

extendApp({ email: { candidates: jobCandidates, recipientChecks } });

export const { REPEAT_DAYS, emailState, candidates, mailto, FINAL, pending, due, addBatch, emailConsentCurrent, recordEmailConsent, recipientProblem, nextEmail, markSent, approve, addBatchPeek } = base;

// The DM to an X poster is the person's: code builds the link, the model never opens x.com. A profile link with the text to
// paste is the fallback; whether X's DM link can carry the text is not verified, so none is built.
export const handleIn = (how) => (/@([A-Za-z0-9_]{1,15})/.exec(String(how || '')) || [])[1] || null;
export const dmLink = (handle, text) => ({ profile: `https://x.com/${handle}`, text, prefill: false, how: 'open the profile, press Message, paste the text, press Send yourself' });
