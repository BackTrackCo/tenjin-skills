// Learned signals: counts only, at most 15 observations, each citing its counts.
export const MAX_OBSERVATIONS = 15;
export const SKIP_REASONS = ['too_senior', 'too_junior', 'place', 'pay', 'company', 'stack', 'other'];

export function observations(state) {
  const c = state.signals.counts;
  const obs = [];
  for (const r of SKIP_REASONS) {
    const n = c[`skip:${r}`] || 0;
    if (n >= 3) obs.push({ text: `You skipped ${n} jobs as ${r.replace('_', ' ')}.`, counts: { [`skip:${r}`]: n } });
  }
  const approve = c.approve || 0;
  const reply = c.reply || 0;
  if (approve >= 3) obs.push({ text: `${reply} replies from ${approve} approved applications.`, counts: { approve, reply } });
  return [...obs, ...(state.signals.observations || [])].slice(0, MAX_OBSERVATIONS);
}
