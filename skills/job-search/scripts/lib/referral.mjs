import { employerName } from './employer.mjs';
import { ruleValue } from './overlay.mjs';

// Referrals: a job at a company where the person could get a referral is not submitted unattended before the person has had the
// chance to get it. The skill cannot know who the person knows (it never reads LinkedIn connections), so the referral is a question
// to the person, one per company. The answers are kept in profile.referrals by company: {status, referrer, pendingAt, draft}.
//   pending: someone can refer the person, who waits for it    none: no one, apply as usual
//   in: the referral is in, apply now                           without: apply without it
export const referralKey = (company) => employerName(company);
export const recordOf = (profile, company) => ((profile && profile.referrals) || {})[referralKey(company)] || null;
export const DEFAULT_DELAY_DAYS = 7;
// A timing default, not a cap: the person can change the delay in their own words (a referral_delay_days rule).
export const delayDays = (overlay) => { const v = Number(ruleValue(overlay || { rules: [] }, 'referral_delay_days')); return Number.isFinite(v) && v > 0 ? v : DEFAULT_DELAY_DAYS; };

// What holds an unattended submit: the company's referral question is open, or its referral is pending. Never an attended apply.
export function referralHold(profile, job) {
  const r = recordOf(profile, job.company);
  if (!r) return 'referral_check';
  return r.status === 'pending' ? 'referral_pending' : null;
}

const LIVE = ['shortlisted', 'prepared', 'apply_ready'];
const planned = (j) => LIVE.includes(j.status) && j.employerPosting && ['exact', 'confirmed'].includes(j.employerPosting.confidence);

// The companies waiting on the person at this moment, from the jobs the skill plans to apply to: the question unanswered, and the
// follow-up due (a pending referral older than the delay).
export function referralWaiting(state, profile, overlay, now = Date.now()) {
  const check = new Map();
  const due = new Map();
  // The question matters for an automatic apply only: an attended person approves each job and can wait on their own.
  if (!String((profile && profile.applyMode) || '').startsWith('auto')) return { check: [], due: [] };
  for (const j of Object.values(state.jobs)) {
    if (!planned(j)) continue;
    const k = referralKey(j.company);
    const r = recordOf(profile, j.company);
    const group = (m) => m.set(k, { id: k, company: j.company, jobs: [...((m.get(k) || {}).jobs || []), j.key] });
    if (!r) group(check);
    else if (r.status === 'pending' && now - Date.parse(r.pendingAt) >= delayDays(overlay) * 86400000) group(due);
  }
  return { check: [...check.values()], due: [...due.values()] };
}

// The question tool's call: one question per company, merged across the companies waiting now, at most 4 per call.
export function referralCalls(groups) {
  const qs = groups.map((g) => ({
    id: g.id,
    question: { header: 'Referral', question: `Can someone at ${g.company} refer you? (${g.jobs.length > 1 ? `${g.jobs.length} jobs` : '1 job'})`.slice(0, 280), multiSelect: false, options: [
      { label: "Someone can refer me (I'll wait for it)", description: 'Auto applies at this company wait until your referral is in; I ask you for the name next.' },
      { label: 'No one, apply as usual', description: 'Apply under your chosen mode, and never ask about this company again.' },
      { label: g.jobs.length > 1 ? 'Skip these jobs' : 'Skip this job', description: 'Do not apply to this company.' },
    ] },
  }));
  const calls = [];
  for (let i = 0; i < qs.length; i += 4) calls.push({ questions: qs.slice(i, i + 4).map((x) => x.question), ids: qs.slice(i, i + 4).map((x) => x.id) });
  return calls;
}

export const followUpQuestion = (company) => ({ questions: [{ header: 'Referral', question: `Is your referral at ${company} in?`, multiSelect: false, options: [
  { label: 'Yes, apply now', description: 'The referral is in: the jobs at this company go on under your apply mode.' },
  { label: 'Not yet', description: 'Keep waiting; I ask again after the same delay.' },
  { label: 'Apply without it', description: 'Apply under your apply mode with no referral.' },
] }] });

// A form's referral field: the referrer's name the person gave, never guessed.
export const REFERRED_BY = /\b(referred by|referrer|who referred you|employee referral|referral (name|source))\b/i;
export const EMPLOYEE_OPTION = /\b(employee|referr|current or former)\b/i;
