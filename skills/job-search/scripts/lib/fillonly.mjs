import { companyTitleKey } from './store.mjs';
// Fill-only mode: fill the form, read it back, never submit, leave the tab open for the person.
// Kept as a small separate path, so it is easy to remove. The person chooses it per job (`fillonly <key> on`)
// or with a `fill_only` rule: value true for every job, or a company name.
// The fill_only rules in force, as one string: a rule added after "Submit it now" changes it and ends the lift.
export const fillRulesKey = (overlay) => JSON.stringify(((overlay && overlay.rules) || []).filter((r) => r.effect === 'fill_only').map((r) => r.value).sort());
export function isFillOnly(job, overlay, profile = {}) {
  // A per-job fill-only switch set after the yes always wins (`fillonly <key> on`).
  if (job.fillOnly) return true;
  // "Submit it now" on a filled form (an approval from J ask approval) lifts fill-only for that job, for that exact sheet hash and
  // the fill_only rules that stood when the person said it: a later rule still stops the submit.
  if (job.submitNow && job.sheet && job.submitNow.sheetHash === job.sheet.hash && job.submitNow.fillRules === fillRulesKey(overlay)) return false;
  if (profile.applyMode === 'fill_only') return true;
  for (const r of (overlay && overlay.rules) || []) {
    if (r.effect !== 'fill_only') continue;
    if (r.value === true || r.value === 'all') return true;
    if (typeof r.value === 'string' && job.company && String(job.company).toLowerCase().includes(r.value.toLowerCase())) return true;
  }
  return false;
}

export function markFillReady(state, key, now = Date.now()) {
  const j = state.jobs[key];
  if (!j) throw new Error(`unknown job: ${key}`);
  j.fillReady = { at: new Date(now).toISOString() };
  j.inFlight = null;
  return j.fillReady;
}

// "I submitted it": the job becomes applied.
export function markSubmitted(state, key, applyOp, now = Date.now()) {
  const j = state.jobs[key];
  if (!j || !(j.fillReady || j.openedAt)) throw new Error('the job is not filled and waiting, and its page was not opened for you');
  const at = new Date(now).toISOString();
  j.inFlight = null;
  if (j.fillReady) {
    applyOp(state, { op: 'transition', key, to: 'submitted', at });
    j.fillReady = null;
    return;
  }
  // A page the skill opened for the person: applied is recorded on their word, whatever the job's status was.
  j.status = 'submitted';
  j.statusAt = at;
  j.applied = { source: 'person', via: 'open', at };
  state.applications.push({ key: j.key, companyKey: companyTitleKey(j), at, source: 'person' });
}
