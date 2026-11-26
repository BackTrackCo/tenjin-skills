import { isFillOnly } from './fillonly.mjs';
import { AUTO_MODES, companyExcluded, consentStatus, dryRunDone, periodLimit, writingConsentCurrent } from './apply.mjs';
import { frequencyOf, periodStart } from '../../../loop-base/lib/schedule.mjs';
import { referralHold, referralListAnswered } from './referral.mjs';

// What the person is told after every approval, from code and as given: what was and was not submitted. It names companies
// only, never personal details. The model never says it is "recording your yes" without this line.
export const CHROME_STEPS = 'To turn it on: install the Claude in Chrome extension if it is not installed, then exit and run `claude --chrome --resume`.';

export function stateLine(state, profile, overlay, keys) {
  const names = (ks) => [...new Set(ks.map((k) => state.jobs[k].company))].join(', ');
  const filling = keys.filter((k) => isFillOnly(state.jobs[k], overlay, profile));
  const applying = keys.filter((k) => !filling.includes(k));
  const parts = ['Submitted: none.'];
  if (filling.length) parts.push(`Filling, never submitting: ${names(filling)}.`);
  if (applying.length) parts.push(`Applying next: ${names(applying)}.`);
  if (state.chrome === 'off' && keys.length) parts.push(`Waiting: Claude in Chrome is off in this session, so nothing fills or submits yet. ${CHROME_STEPS}`);
  return parts.join(' ');
}

// The last check right before the submit click, and the only one: there is no hook. It says no when the job changed after its
// yes or its handout: fill-only turned on, the yes withdrawn, the sheet hash changed or no longer passes, the batch closed, a
// stop recorded, the job already submitted or already past this check, a read-back that failed, or a company since excluded.
// In an unattended batch there is no yes on file; the job must have been handed out for a submit, and the consent, its rules
// hash, the dry run, the writing consent, the period limit and the apply mode must all still hold.
export function maySubmit(state, profile, overlay, key, sheetHash, batchActive, { now = Date.now(), mode = 'attended', writingRulesText = '' } = {}) {
  const job = state.jobs[key];
  if (!job) return { ok: false, why: 'unknown_job' };
  if (!batchActive) return { ok: false, why: 'batch_closed' };
  if (!['prepared', 'apply_ready'].includes(job.status) || (state.applications || []).some((a) => a.key === key)) return { ok: false, why: 'already_applied' };
  if (profile.applyMode === 'open_only') return { ok: false, why: 'open_only_mode' };
  if (isFillOnly(job, overlay, profile)) return { ok: false, why: 'fill_only' };
  if (job.parked || job.noChromeTools) return { ok: false, why: 'stopped' };
  if (!job.sheet || job.sheet.hash !== sheetHash) return { ok: false, why: 'sheet_changed' };
  if (job.sheet.passed !== true) return { ok: false, why: 'sheet_not_passed' };
  if (job.readbackBad && job.readbackBad.hash === sheetHash) return { ok: false, why: 'readback_failed' };
  if (job.mayAt) return { ok: false, why: 'already_checked' };
  if (companyExcluded(job, profile, overlay)) return { ok: false, why: 'company_excluded' };
  const h = job.inFlight;
  if (!h) return { ok: false, why: 'not_handed_out' };
  if (h.sheetHash && h.sheetHash !== sheetHash) return { ok: false, why: 'sheet_changed' };
  if (mode === 'unattended') {
    if (h.mode !== 'unattended' || h.submit !== true) return { ok: false, why: 'not_handed_out_for_submit' };
    if (profile.applyMode && !AUTO_MODES.includes(profile.applyMode)) return { ok: false, why: 'not_auto_mode' };
    if (!referralListAnswered(profile)) return { ok: false, why: 'referral_list_unanswered' };
    { const held = referralHold(profile, job); if (held) return { ok: false, why: held }; }
    const cs = consentStatus(state, profile, overlay);
    if (!cs.ok) return { ok: false, why: cs.reason };
    if (!dryRunDone(state, profile, overlay)) return { ok: false, why: 'dry_run_not_confirmed' };
    const nw = (job.sheet.fields || []).filter((f) => f.tag === 'new_writing');
    if (profile.applyMode === 'auto_no_new' && nw.length) return { ok: false, why: 'new_answer_needs_yes' };
    if (nw.length && !writingConsentCurrent(state, writingRulesText) && (nw.some((f) => f.required) || state.consent.unattended.optionalWriting === 'wait')) return { ok: false, why: 'writing_needs_yes' };
    const limit = periodLimit(overlay, { profile, now });
    if (limit !== null) {
      const done = (state.handouts || []).filter((x) => x.counted && Date.parse(x.at) >= periodStart(now, frequencyOf(profile))).length;
      if (done > limit) return { ok: false, why: 'period_max' };
    }
    return { ok: true };
  }
  const a = state.approvals[key];
  if (!a || a.sheetHash !== sheetHash) return { ok: false, why: 'no_yes' };
  return { ok: true };
}
