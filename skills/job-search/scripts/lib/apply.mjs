import fs from 'node:fs';
import { graph } from './graph.mjs';
import { duplicateWithin, sha } from './dedupe.mjs';
import { isFillOnly } from './fillonly.mjs';
import { frequencyOf, periodStart } from './schedule.mjs';
import { isNeverAutomated } from './platforms.mjs';
import { activeLessons, canonical, maxPay, rulesHash, ruleValue } from './overlay.mjs';

export const WRITING_SCOPE = 'application_free_text';

const HOUR = 3600000;

// ---- unattended consent -------------------------------------------------
// The positions rule: a number, or no limit. The person's words and date are kept with the rule.
// The rule is a number (the daily number), 'none', or {catchUp, perDay, at}: a first-run catch-up, then a daily number. The
// catch-up applies once, to the period the rule was recorded in, and is not carried over. The daily number is split across
// a twice-a-day period (the first takes the odd one: 9 gives 5 and 4) and counts 7 days' worth for a weekly one. A most,
// not a target.
export function periodLimit(overlay, { profile = {}, now = Date.now(), ignoreCatchUp = false } = {}) {
  const v = ruleValue(overlay, 'period_max');
  if (v === undefined || v === 'none' || v === null) return null;
  if (typeof v !== 'object') return Number(v); // the older rule: a number per period
  const freq = frequencyOf(profile);
  const obj = v;
  const at = obj.at ? Date.parse(obj.at) : NaN;
  if (!ignoreCatchUp && Number.isInteger(obj.catchUp) && !Number.isNaN(at) && periodStart(now, freq) === periodStart(at, freq)) return obj.catchUp;
  if (obj.perDay === 'none' || obj.perDay === undefined || obj.perDay === null) return null;
  const day = Number(obj.perDay);
  if (freq === 'weekly') return day * 7;
  if (freq === 'twice_daily') return new Date(now).getHours() < 12 ? Math.ceil(day / 2) : Math.floor(day / 2);
  return day;
}

export function unattendedProblems(profile) {
  const u = profile.unattended;
  const p = [];
  if (!u) return ['the unattended rules are not set'];
  if (!Array.isArray(u.roles) || !u.roles.length) p.push('no role terms');
  if (!Array.isArray(u.places) || !u.places.length) p.push('no place');
  if (typeof u.minScore !== 'number') p.push('no lowest fit score');
  if (!Array.isArray(u.hosts) || !u.hosts.length || u.hosts.some((h) => !graph().hosts.includes(h))) p.push('hosts must be from Greenhouse, Lever, Ashby');
  if (!profile.eeo) p.push('the EEO choice is not made');
  return p;
}

// Only an attended yes records it, and only with the person's choice for optional writing fields:
// skip leaves them out, wait holds the job for the person. There is no default.
export function recordConsent(state, profile, overlay, now = Date.now(), optionalWriting) {
  const problems = unattendedProblems(profile);
  if (problems.length) throw new Error(`cannot record consent: ${problems.join('; ')}`);
  if (!['skip', 'wait'].includes(optionalWriting)) throw new Error('the person picks skip or wait for optional writing fields; there is no default');
  // Limits that only tighten stay out of the hash, but the consent remembers the limits it was given under: removing or
  // raising the positions rule, or removing a fill-only rule, loosens an unattended run and needs a new consent.
  state.consent.unattended = { rulesHash: rulesHash(profile, overlay), at: new Date(now).toISOString(), optionalWriting, limits: limitsOf(overlay) };
  state.consent.dryRun = { records: [], confirmedAt: null, rulesHash: null };
  return state.consent.unattended;
}

// Writing consent is separate from the unattended consent: it covers new writing in an unattended submit.
// It is bound to the writing scope and the person's writing rules, so a changed rule makes it stale.
export const writingHash = (rulesText = '') => sha(canonical({ scope: WRITING_SCOPE, rules: String(rulesText).trim() }));
export function recordWritingConsent(state, rulesText = '', now = Date.now()) {
  state.consent.writing = { at: new Date(now).toISOString(), hash: writingHash(rulesText) };
  return state.consent.writing;
}
export function writingConsentCurrent(state, rulesText = '') {
  return Boolean(state.consent.writing && state.consent.writing.hash === writingHash(rulesText));
}
export function revokeConsent(state, which) {
  if (which === 'unattended') state.consent.unattended = null;
  else if (which === 'writing') state.consent.writing = null;
  else if (which === 'email') state.consent.email = null;
  else throw new Error('revoke unattended, writing or email');
}

export function limitsOf(overlay) {
  const fill = (overlay.rules || []).filter((r) => r.effect === 'fill_only').map((r) => (r.value === true || r.value === 'all' ? '*' : String(r.value).toLowerCase()));
  return { periodMax: periodLimit(overlay, { ignoreCatchUp: true }), fillOnly: [...new Set(fill)] };
}
// True when the current limits are looser than the ones the consent was given under.
export function loosened(was, now) {
  if (!was) return false;
  if (was.periodMax !== null && (now.periodMax === null || now.periodMax > was.periodMax)) return true;
  if (was.fillOnly.includes('*') && !now.fillOnly.includes('*')) return true;
  return was.fillOnly.some((v) => v !== '*' && !now.fillOnly.includes(v) && !now.fillOnly.includes('*'));
}

export function consentStatus(state, profile, overlay) {
  const c = state.consent.unattended;
  if (!c) return { ok: false, reason: 'no_consent' };
  if (c.rulesHash !== rulesHash(profile, overlay) || loosened(c.limits, limitsOf(overlay))) return { ok: false, reason: 'rules_changed' };
  return { ok: true };
}

export function recordDryRun(state, record) {
  state.consent.dryRun.records.push({ ...record, submitted: false });
}
export function confirmDryRun(state, profile, overlay, now = Date.now()) {
  if (!consentStatus(state, profile, overlay).ok) throw new Error('record the unattended consent first');
  if (!state.consent.dryRun.records.length) throw new Error('the dry run has no records to review');
  state.consent.dryRun.confirmedAt = new Date(now).toISOString();
  state.consent.dryRun.rulesHash = rulesHash(profile, overlay);
}
export const dryRunDone = (state, profile, overlay) => Boolean(state.consent.dryRun.confirmedAt && state.consent.dryRun.rulesHash === rulesHash(profile, overlay));

// ---- the unattended rules against one job ---------------------------------
export function unattendedRuleFailure(job, profile, overlay, now = Date.now()) {
  const u = profile.unattended;
  const title = job.title.toLowerCase();
  if (!u.hosts.includes(job.ats)) return 'host_not_in_rules';
  if (!u.roles.some((r) => title.includes(String(r).toLowerCase()))) return 'role_not_in_rules';
  const hay = `${job.city} ${job.region} ${job.country}`.toLowerCase();
  if (!u.places.some((p) => hay.includes(String(p).toLowerCase())) && !(job.remote && u.remote === true)) return 'place_not_in_rules';
  if ((u.excludeLevels || []).some((l) => title.includes(String(l).toLowerCase()))) return 'level_excluded';
  const floor = u.minPay;
  if (typeof floor === 'number') {
    const top = maxPay(job.salary);
    if (top !== null && top < floor) return 'below_pay_floor';
  }
  const excluded = [...(u.excludeCompanies || []), ...(overlay.rules || []).filter((r) => r.effect === 'exclude_company').map((r) => r.value)];
  if (excluded.some((c) => c && String(job.company).toLowerCase().includes(String(c).toLowerCase()))) return 'company_excluded';
  if (typeof job.fit !== 'number' || job.fit < u.minScore) return 'score_below_rule';
  if ((job.warnings || []).some((w) => /layoff|stealth|recruiter|injection/i.test(w))) return 'warning_blocks_unattended';
  for (const l of activeLessons(overlay, now)) {
    if (l.effect === 'host_attended' && l.subject === job.ats) return 'lesson_host_attended';
    if (l.effect === 'company_attended' && String(job.company).toLowerCase() === String(l.subject).toLowerCase()) return 'lesson_company_attended';
  }
  return null;
}

// ---- apply next -----------------------------------------------------------
// Pure. ctx: {state, profile, overlay, mode, now, batchOpen}. A job is handed out only in an open batch.
// Returns {handout} or {refused} plus the jobs that must wait, each with its reason.
export function applyNext(ctx) {
  const { state, profile, overlay, mode = 'attended', now = Date.now(), batchOpen, writingRulesText = '' } = ctx;
  const writingOk = writingConsentCurrent(state, writingRulesText);
  const queue = [];
  const out = (o) => ({ handout: null, refused: null, queue, ...o });
  if (!batchOpen) return out({ refused: 'no_batch' });
  let dry = false;
  if (mode === 'unattended') {
    const cs = consentStatus(state, profile, overlay);
    if (!cs.ok) return out({ refused: cs.reason });
    dry = !dryRunDone(state, profile, overlay);
  }
  // Positions per period: how many applications an unattended run makes in one period. The rest stay ranked in the
  // queue for the next period and none is dropped. No rule, or "none", means no limit.
  const limit = periodLimit(overlay, { profile, now });
  if (mode === 'unattended' && limit !== null) {
    const start = periodStart(now, frequencyOf(profile));
    const done = (state.handouts || []).filter((h) => h.counted && Date.parse(h.at) >= start).length;
    if (done >= limit) return out({ refused: 'period_max', limit, done });
  }
  const hostLast = new Set(activeLessons(overlay, now).filter((l) => l.effect === 'host_last').map((l) => l.subject));
  const cands = Object.values(state.jobs)
    .filter((j) => ['prepared', 'apply_ready'].includes(j.status) && !j.fillReady)
    .sort((a, b) => Number(hostLast.has(a.ats)) - Number(hostLast.has(b.ats)));
  for (const job of cands) {
    const why = jobFailure({ job, state, profile, overlay, mode, now, writingOk });
    if (why) {
      queue.push({ key: job.key, reason: why });
      continue;
    }
    const skipFields = mode === 'unattended' && !writingOk && state.consent.unattended.optionalWriting === 'skip' ? (job.sheet.fields || []).filter((f) => f.tag === 'new_writing' && !f.required).map((f) => f.label) : [];
    const fillOnly = isFillOnly(job, overlay);
    return out({ handout: { key: job.key, url: job.employerPosting.url, sheetHash: job.sheet.hash, mode, dryRun: dry, fillOnly, submit: !dry && !fillOnly, skipFields } });
  }
  return out({});
}

export function jobFailure({ job, state, profile, overlay, mode, now, writingOk = false }) {
  // Only the employer's own posting on Greenhouse, Lever or Ashby, found exactly or confirmed, is ever handed out.
  const ep = job.employerPosting;
  if (!ep || !['exact', 'confirmed'].includes(ep.confidence)) return 'no_employer_posting';
  if (job.openConfirmed !== true) return 'not_confirmed_open';
  if (isNeverAutomated(ep.url)) return 'platform_url';
  if (!graph().hosts.includes(ep.system) || !(graph().applyHostNames[ep.system] || []).includes(new URL(ep.url).hostname)) return 'host_not_allowed';
  if (job.parked) return 'parked';
  if (job.noChromeTools) return 'no_chrome_tools';
  if (!job.verifiedAt || now - Date.parse(job.verifiedAt) > graph().unattendedWindow.verifiedHours * HOUR) return 'not_verified_recently';
  if (!job.sheet || !job.sheet.passed) return 'sheet_not_checked';
  if (job.sheet.eeoMissing || !profile.eeo) return 'eeo_missing';
  // A resume given as text only has no file: a form that requires one holds this job, which asks once for the file.
  if ((job.sheet.fields || []).some((f) => f.tag === 'upload') && profile.resumeSource && !(profile.resumePath && fs.existsSync(profile.resumePath))) return 'needs_resume_file';
  if (duplicateWithin(state, job, now, graph().unattendedWindow.duplicateDays)) return 'applied_to_company_title_within_90_days';
  if (state.applications.some((a) => a.key === job.key)) return 'already_applied';
  if (mode === 'attended') {
    if (isFillOnly(job, overlay)) return null; // nothing is submitted, so no yes is needed
    const a = state.approvals[job.key];
    if (!a) return 'no_recorded_yes';
    if (a.sheetHash !== job.sheet.hash) return 'sheet_changed_needs_new_yes';
    return null;
  }
  const rule = unattendedRuleFailure(job, profile, overlay, now);
  if (rule) return rule;
  // New writing needs its own consent. Optional writing follows the recorded skip or wait.
  if (!writingOk) {
    const nw = (job.sheet.fields || []).filter((f) => f.tag === 'new_writing');
    const needs = nw.some((f) => f.required) || (nw.length > 0 && state.consent.unattended.optionalWriting === 'wait');
    if (needs) return 'writing_needs_yes';
  }
  return null;
}

export const sheetHashOf = (fields) => sha(canonical(fields)).slice(0, 16);
