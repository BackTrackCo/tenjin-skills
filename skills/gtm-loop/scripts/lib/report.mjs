import { liveHeld } from './offers.mjs';
import { REFUSED_BY_CODE as REFUSED } from './codeid.mjs';
import { fmt, hintLines, pricesCheckedAt } from './prices.mjs';

// The short report: what is new, what waits for the person, what went out, what came back, what it cost. Built from state, never
// from model text.
const DAY = 86400000;
const count = (state, status) => Object.values(state.leads).filter((l) => l.status === status).length;

export function report(state, profile = {}, now = Date.now()) {
  const since = now - DAY;
  const newLeads = Object.values(state.leads).filter((l) => Date.parse(l.firstSeen) >= since && l.status !== 'suppressed');
  const spend = (state.spend || []).filter((s) => now - Date.parse(s.at) < 7 * DAY);
  const cents = spend.reduce((n, s) => n + (s.cents || 0), 0);
  const leadsFound = spend.reduce((n, s) => n + (s.leads || 0), 0);
  const optOuts = Object.values(state.suppress.ids).filter((x) => /opt_out|stop/.test(x.reason)).length;
  const lines = [
    `New leads in the last day: ${newLeads.length}. Waiting for review: ${count(state, 'new')}. Reviewed: ${count(state, 'reviewed')}.`,
    `Drafts waiting for your pick: ${count(state, 'drafted')}. Picked: ${count(state, 'picked')}. Approved emails: ${count(state, 'approved')}.`,
    `Sent: ${count(state, 'contacted')}. Replies: ${count(state, 'replied')}. Opt-outs and bounces: ${optOuts}. Suppressed: ${Object.keys(state.suppress.ids).length} identities, ${Object.keys(state.suppress.domains).length} domains.`,
  ];
  if (spend.length) lines.push(`Router spend, last 7 days: ${fmt(Math.round(cents * 10) / 10)}${leadsFound ? `, about ${fmt(Math.round((cents / leadsFound) * 10) / 10)} per new lead` : ''} (prices checked ${pricesCheckedAt()}).`);
  const yieldLines = Object.entries(state.phraseYield || {}).map(([phrase, by]) => `"${phrase}": ${Object.entries(by).map(([s, n]) => `${n} from ${s}`).join(', ') || 'none yet'}`);
  if (yieldLines.length) lines.push(`New leads per phrase and source, all time: ${yieldLines.join('; ')}.`);
  const drops = Object.entries(state.dropTally || {}).map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`);
  if (drops.length) lines.push(`Dropped before review by code filters, all time: ${drops.join(', ')}.`);
  const skipped = Object.values(state.leads).filter((l) => l.status === 'skipped');
  if (skipped.length) {
    const why = {};
    for (const l of skipped) why[l.skipReason || 'left'] = (why[l.skipReason || 'left'] || 0) + 1;
    lines.push(`Skipped: ${skipped.length} (${Object.entries(why).map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`).join(', ')}).`);
  }
  for (const h of liveHeld(state.held, profile)) lines.push(REFUSED.includes(h.status) ? `Held: ${h.detail || h.reason}. The skill's own request was refused: that is a defect in the skill to report, not something you fill in.` : `Held: ${h.detail || h.reason}.`);
  for (const l of state.updateLines || []) lines.push(l);
  const t = state.tenjin || {};
  if (t.status && t.status !== 'ready') lines.push(hintLines(profile).search);
  return { lines, text: lines.join('\n') };
}
