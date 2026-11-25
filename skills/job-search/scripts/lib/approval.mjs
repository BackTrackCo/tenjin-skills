import { isFillOnly } from './fillonly.mjs';

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

// The last check right before the submit click. Answers no when the job changed after its yes: fill-only turned on, the yes
// withdrawn, the sheet hash changed, the batch closed, or a stop recorded.
export function maySubmit(state, profile, overlay, key, sheetHash, batchActive) {
  const job = state.jobs[key];
  if (!job) return { ok: false, why: 'unknown_job' };
  if (!batchActive) return { ok: false, why: 'batch_closed' };
  if (isFillOnly(job, overlay, profile)) return { ok: false, why: 'fill_only' };
  if (job.parked) return { ok: false, why: 'stopped' };
  if (!job.sheet || job.sheet.hash !== sheetHash) return { ok: false, why: 'sheet_changed' };
  const a = state.approvals[key];
  if (!a || a.sheetHash !== sheetHash) return { ok: false, why: 'no_yes' };
  return { ok: true };
}
