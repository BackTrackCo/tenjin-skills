// Fill-only mode: fill the form, read it back, never submit, leave the tab open for the person.
// Kept as a small separate path, so it is easy to remove. The person chooses it per job (`fillonly <key> on`)
// or with a `fill_only` rule: value true for every job, or a company name.
export function isFillOnly(job, overlay) {
  if (job.fillOnly) return true;
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
  return j.fillReady;
}

// "I submitted it": the job becomes applied.
export function markSubmitted(state, key, applyOp, now = Date.now()) {
  const j = state.jobs[key];
  if (!j || !j.fillReady) throw new Error('the job is not filled and waiting');
  applyOp(state, { op: 'transition', key, to: 'submitted', at: new Date(now).toISOString() });
  j.fillReady = null;
}
