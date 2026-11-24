import { graph } from './graph.mjs';
import { duplicateWithin, sha } from './dedupe.mjs';
import { activeLessons, canonical, maxPay, rulesHash, ruleValue } from './overlay.mjs';

const HOUR = 3600000;

// ---- unattended consent -------------------------------------------------
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

// Only an attended yes records it. No rule or lesson can.
export function recordConsent(state, profile, overlay, now = Date.now()) {
  const problems = unattendedProblems(profile);
  if (problems.length) throw new Error(`cannot record consent: ${problems.join('; ')}`);
  state.consent.unattended = { rulesHash: rulesHash(profile, overlay), at: new Date(now).toISOString() };
  state.consent.dryRun = { records: [], confirmedAt: null, rulesHash: null };
  return state.consent.unattended;
}

export function consentStatus(state, profile, overlay) {
  const c = state.consent.unattended;
  if (!c) return { ok: false, reason: 'no_consent' };
  if (c.rulesHash !== rulesHash(profile, overlay)) return { ok: false, reason: 'rules_changed' };
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
export function unattendedRuleFailure(job, profile, overlay) {
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
  for (const l of activeLessons(overlay)) {
    if (l.effect === 'host_attended' && l.subject === job.ats) return 'lesson_host_attended';
    if (l.effect === 'company_attended' && String(job.company).toLowerCase() === String(l.subject).toLowerCase()) return 'lesson_company_attended';
  }
  return null;
}

// ---- apply next -----------------------------------------------------------
// Pure. ctx: {state, profile, overlay, mode, now, guard:{ok}, deepseek:{enabled}}.
// Returns {handout} or {refused} plus the jobs that must wait, each with its reason.
export function applyNext(ctx) {
  const { state, profile, overlay, mode = 'attended', now = Date.now(), guard, deepseek } = ctx;
  const queue = [];
  const out = (o) => ({ handout: null, refused: null, queue, ...o });
  if (!guard || !guard.ok) return out({ refused: 'guard_missing', detail: guard && guard.reasons });
  if (deepseek && deepseek.enabled !== false) return out({ refused: 'deepseek_on' });
  let dry = false;
  if (mode === 'unattended') {
    const cs = consentStatus(state, profile, overlay);
    if (!cs.ok) return out({ refused: cs.reason });
    dry = !dryRunDone(state, profile, overlay);
  }
  const dailyMax = ruleValue(overlay, 'daily_max');
  if (dailyMax !== undefined) {
    const today = new Date(now).toDateString();
    const done = state.applications.filter((a) => new Date(a.at).toDateString() === today).length;
    if (done >= Number(dailyMax)) return out({ refused: 'daily_max' });
  }
  const hostLast = new Set(activeLessons(overlay, now).filter((l) => l.effect === 'host_last').map((l) => l.subject));
  const cands = Object.values(state.jobs)
    .filter((j) => ['prepared', 'apply_ready'].includes(j.status))
    .sort((a, b) => Number(hostLast.has(a.ats)) - Number(hostLast.has(b.ats)));
  for (const job of cands) {
    const why = jobFailure({ job, state, profile, overlay, mode, now });
    if (why) {
      queue.push({ key: job.key, reason: why });
      continue;
    }
    return out({ handout: { key: job.key, url: job.applyLinks ? job.applyLinks[0] : job.url, sheetHash: job.sheet.hash, mode, dryRun: dry, submit: !dry } });
  }
  return out({});
}

export function jobFailure({ job, state, profile, overlay, mode, now }) {
  if (!graph().hosts.includes(job.ats)) return 'host_not_allowed';
  if (job.parked) return 'parked';
  if (!job.verifiedAt || now - Date.parse(job.verifiedAt) > graph().unattendedWindow.verifiedHours * HOUR) return 'not_verified_recently';
  if (!job.sheet || !job.sheet.passed) return 'sheet_not_checked';
  if (job.sheet.eeoMissing || !profile.eeo) return 'eeo_missing';
  if (duplicateWithin(state, job, now, graph().unattendedWindow.duplicateDays)) return 'applied_to_company_title_within_90_days';
  if (state.applications.some((a) => a.key === job.key)) return 'already_applied';
  if (mode === 'attended') {
    const a = state.approvals[job.key];
    if (!a) return 'no_recorded_yes';
    if (a.sheetHash !== job.sheet.hash) return 'sheet_changed_needs_new_yes';
    return null;
  }
  return unattendedRuleFailure(job, profile, overlay);
}

export const sheetHashOf = (fields) => sha(canonical(fields)).slice(0, 16);
