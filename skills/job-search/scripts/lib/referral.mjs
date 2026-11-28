import { employerName } from './employer.mjs';
import { ruleValue } from './overlay.mjs';

// Referrals: the person lists once, at the start, the companies where they can get a referral (a plain question, never a choice). A job
// at a listed company is not submitted unattended before the person has had the chance to get it; a company not on the list is never
// asked about. The skill never reads LinkedIn connections. The list is profile.referralList = {answeredAt, words}; one record per listed
// company is kept in profile.referrals: {company, status, referrer, listedAt, pendingAt, draft}.
//   pending: someone can refer the person, who waits for it    in: the referral is in, apply now    without: apply without it
export const referralKey = (company) => employerName(company);
export const recordOf = (profile, company) => ((profile && profile.referrals) || {})[referralKey(company)] || null;
export const DEFAULT_DELAY_DAYS = 7;
// A timing default, not a cap: the person can change the delay in their own words (a referral_delay_days rule).
export const delayDays = (overlay) => { const v = Number(ruleValue(overlay || { rules: [] }, 'referral_delay_days')); return Number.isFinite(v) && v > 0 ? v : DEFAULT_DELAY_DAYS; };

export const referralListAnswered = (profile) => Boolean(profile && profile.referralList && profile.referralList.answeredAt);
// An auto mode with the list unanswered waits for the person, with no time limit; the other modes never wait on it.
export const referralListWaiting = (profile) => String((profile && profile.applyMode) || '').startsWith('auto') && !referralListAnswered(profile);
export const REFERRAL_LIST_LINE = 'Auto apply waits for one answer: which companies can you get a referral at, or none?';

// The plain question at the start, in every apply mode: no options, a normal message.
export const REFERRAL_QUESTION = 'Which companies can you get a referral at? List each one, with the name of the person who can refer you if you like, for example: Company A (their name); Company B. Say none if there are none. You can add or remove one any time by telling me.';

const NONE_WORDS = /^(none|no|nobody|no one|n\/a)\.?$/i;
// The person's own words to a list: items split on newlines, semicolons or commas (a comma inside parentheses stays); a referrer's name
// in parentheses or after a colon, " via " or " through "; a leading "and" dropped; deduped by employer name. "none" is an empty list.
export function parseReferralList(words) {
  const text = String(words || '').trim();
  if (!text || NONE_WORDS.test(text)) return [];
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[\n;,]/.test(ch)) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  const out = new Map();
  for (const raw of parts) {
    let item = raw.trim().replace(/^and\s+/i, '').replace(/[.]+$/, '').trim();
    if (!item || NONE_WORDS.test(item)) continue;
    let company = item;
    let referrer = null;
    const paren = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(item);
    const sep = /^(.*?)(?:\s*:\s*|\s+(?:via|through)\s+)(.+)$/i.exec(item);
    if (paren && paren[1].trim()) { company = paren[1].trim(); referrer = paren[2].trim(); } else if (sep && sep[1].trim()) { company = sep[1].trim(); referrer = sep[2].trim(); }
    company = company.replace(/^and\s+/i, '').trim();
    if (!company) continue;
    const key = employerName(company);
    if (!key || out.has(key)) continue;
    out.set(key, { company, ...(referrer ? { referrer } : {}) });
  }
  return [...out.values()];
}

// What holds an unattended submit: a listed company whose referral is pending. Never an attended apply, and never a company not listed.
export function referralHold(profile, job) {
  const r = recordOf(profile, job.company);
  return r && r.status === 'pending' ? 'referral_pending' : null;
}

const LIVE = ['shortlisted', 'prepared', 'apply_ready'];
const planned = (j) => LIVE.includes(j.status) && j.employerPosting && ['exact', 'confirmed'].includes(j.employerPosting.confidence);

// The follow-up due: a pending referral at a company with a planned job, after the delay. The clock is pendingAt ("Not yet") or, when
// that is absent, the earliest planned job at the company (its firstSeen), computed and never written.
export function referralWaiting(state, profile, overlay, now = Date.now()) {
  const groups = new Map();
  for (const j of Object.values(state.jobs)) {
    if (!planned(j)) continue;
    const k = referralKey(j.company);
    const r = recordOf(profile, j.company);
    if (!r || r.status !== 'pending') continue;
    const g = groups.get(k) || { id: k, company: r.company || j.company, jobs: [], since: Infinity };
    g.jobs.push(j.key);
    const t = Date.parse(j.firstSeen);
    if (Number.isFinite(t)) g.since = Math.min(g.since, t);
    groups.set(k, g);
  }
  const due = [];
  for (const g of groups.values()) {
    const r = recordOf(profile, g.company);
    const from = r.pendingAt ? Date.parse(r.pendingAt) : g.since;
    if (Number.isFinite(from) && now - from >= delayDays(overlay) * 86400000) due.push({ id: g.id, company: g.company, jobs: g.jobs });
  }
  return { due };
}

export const followUpQuestion = (company) => ({ questions: [{ header: 'Referral', question: `Is your referral at ${company} in?`, multiSelect: false, options: [
  { label: 'Yes, apply now', description: 'The referral is in: the jobs at this company go on under your apply mode.' },
  { label: 'Not yet', description: 'Keep waiting; I ask again after the same delay.' },
  { label: 'Apply without it', description: 'Apply under your apply mode with no referral.' },
] }] });

// A form's referral field: the referrer's name the person gave, never guessed.
export const REFERRED_BY = /\b(referred by|referrer|who referred you|employee referral|referral (name|source))\b/i;
export const EMPLOYEE_OPTION = /\b(employee|referr|current or former)\b/i;

// A pending referral shown beside a job the person submits or opens themselves (fill-only, just open the pages, a job site): it never blocks.
export const referralNote = (profile, job) => { const r = recordOf(profile, job.company); return r && r.status === 'pending' ? `referral pending at ${job.company}${r.referrer ? `: ${r.referrer}` : ''}` : null; };
