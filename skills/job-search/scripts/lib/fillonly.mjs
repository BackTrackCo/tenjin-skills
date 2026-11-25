import { companyTitleKey } from './store.mjs';
// Fill-only mode: fill the form, read it back, never submit, leave the tab open for the person.
// Kept as a small separate path, so it is easy to remove. The person chooses it per job (`fillonly <key> on`)
// or with a `fill_only` rule: value true for every job, or a company name.
export function isFillOnly(job, overlay, profile = {}) {
  if (job.fillOnly || profile.applyMode === 'fill_only') return true;
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
