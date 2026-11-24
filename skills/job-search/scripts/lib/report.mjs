import { notifyLine } from './work.mjs';

// The report is rendered from state and the overlay, never written by the model.
export function renderReport(state, overlay, { since = null, now = Date.now() } = {}) {
  const jobs = Object.values(state.jobs);
  const fresh = jobs.filter((j) => j.status === 'new' || j.status === 'reviewed').filter((j) => !since || Date.parse(j.firstSeen) >= Date.parse(since));
  fresh.sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1));
  const L = [];
  L.push(`# Job Search report, ${new Date(now).toISOString().slice(0, 10)}`);
  L.push('');
  L.push(`## New jobs (${fresh.length})`);
  for (const j of fresh.slice(0, 20)) L.push(`- ${j.fit ?? '?'} | ${j.title}, ${j.company}, ${[j.city, j.region].filter(Boolean).join(', ') || (j.remote ? 'remote' : '')}${j.fitLine ? ` | ${j.fitLine}` : ''}${(j.warnings || []).length ? ` | warnings: ${j.warnings.join('; ')}` : ''} | ${j.url}`);
  if (fresh.length > 20) L.push(`- and ${fresh.length - 20} more`);
  const readyJobs = jobs.filter((j) => j.status === 'new' || j.status === 'reviewed');
  if (readyJobs.length) L.push('', `(${readyJobs.length} new jobs above are ready to apply, each on its own board: ${[...new Set(readyJobs.map((j) => j.board))].join(', ')})`);
  const ay = state.applyYourself || [];
  L.push('', `## Apply yourself (${ay.length})`);
  for (const a of ay.slice(-20)) L.push(`- ${a.title}, ${a.employer}: ${a.links.map((l) => `${l.url}${l.publisher ? ` (${l.publisher})` : ''}`).join(' | ')}`);
  const held = state.held.filter((h) => h.reason === 'source_empty');
  L.push('', '## Sources held this run');
  if (held.length) for (const h of held) L.push(`- ${h.detail}`);
  else L.push('- none');
  const noTenjin = state.held.find((h) => h.reason === 'tenjin_missing');
  const skip = noTenjin ? `no Tenjin (${noTenjin.detail})` : state.routed && state.routed.skipReason;
  if (skip) L.push('', `## The routed search did not run`, `- ${skip}. The watched boards still ran.`);
  const w = state.watched;
  L.push('', `## Watched boards checked: ${w ? `${w.ok} of ${w.checked} answered` : 'none yet'}`);
  L.push('', `Cost the router reported: ${(state.routed && state.routed.lastCost) || 'none reported'}`);
  const newRules = (overlay.rules || []).filter((r) => !since || r.date >= since.slice(0, 10));
  if (newRules.length) {
    L.push('', '## Rules (your words)');
    for (const r of newRules) L.push(`- ${r.date}: "${r.words}" (${r.effect}${r.value !== null && r.value !== undefined ? ` ${r.value}` : ''}) id ${r.id}`);
  }
  const lessons = (overlay.lessons || []).filter((l) => Date.parse(l.expires) > now);
  if (lessons.length) {
    L.push('', '## Lessons the skill learned (they only make it more careful)');
    for (const l of lessons) L.push(`- ${l.text} Expires ${l.expires.slice(0, 10)}. id ${l.id}`);
  }
  if (state.updateLines && state.updateLines.length) {
    L.push('', '## Updates');
    for (const u of state.updateLines.slice(-3)) L.push(`- ${u}`);
  }
  const waiting = jobs.filter((j) => j.parked || (j.status === 'apply_ready' && !state.approvals[j.key]));
  if (waiting.length) {
    L.push('', '## Waiting on you');
    for (const j of waiting) L.push(`- ${j.company}, ${j.title}: ${j.parked ? j.parked.reasons.join(', ') : 'needs your yes'}`);
  }
  L.push('', 'Want contacts (a hiring manager, team lead or founder) for some of these? Say for how many jobs; 5 if you do not say. Messages are drafts; you send them.');
  return L.join('\n');
}

export { notifyLine };
