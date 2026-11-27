import { liveHeld, offersOf } from './offers.mjs';
import { draftsDir, parked, approvedReplies } from './drafts.mjs';
import { querySetOf, outcomeOf, labelOf } from './queryset.mjs';
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
  if (parked(state).length) lines.push(`${parked(state).length} draft${parked(state).length === 1 ? '' : 's'} in ${draftsDir(profile)}. Nothing waits on them.`);
  if (approvedReplies(state).length) lines.push(`${approvedReplies(state).length} approved repl${approvedReplies(state).length === 1 ? 'y' : 'ies'} to open: say open them.`);
  if (spend.length) lines.push(`Router spend, last 7 days: ${fmt(Math.round(cents * 10) / 10)}${leadsFound ? `, about ${fmt(Math.round((cents / leadsFound) * 10) / 10)} per new lead` : ''} (prices checked ${pricesCheckedAt()}).`);
  const per = {};
  for (const s of spend.filter((x) => x.search)) { const e = (per[s.kind] ||= { n: 0, cents: 0 }); e.n++; e.cents += s.cents || 0; }
  const perLines = Object.entries(per).map(([k, e]) => `${k.replace(/_/g, ' ')} ${e.n} search${e.n === 1 ? '' : 'es'}, ${fmt(Math.round(e.cents * 10) / 10)}, ${fmt(Math.round((e.cents / e.n) * 10) / 10)} each`);
  if (perLines.length) lines.push(`Cost per source, last 7 days: ${perLines.join('; ')}.`);
  const web = state.webTally || {};
  if (web.tooOld || web.undated) lines.push(`Web pages, all time: ${web.tooOld || 0} dropped as older than the window, ${web.undated || 0} kept undated.`);
  const yieldLines = Object.entries(state.phraseYield || {}).map(([phrase, by]) => `"${phrase}": ${Object.entries(by).map(([s, n]) => `${n} from ${s}`).join(', ') || 'none yet'}`);
  if (yieldLines.length) lines.push(`New leads per phrase and source, all time: ${yieldLines.join('; ')}.`);
  // The funnel of the last round, per source: what came back, what each code filter dropped, what went to review, what was kept.
  const fun = (state.funnel || {}).sources || {};
  const KEPT = ['reviewed', 'drafted', 'picked', 'approved', 'contacted', 'replied'];
  for (const [src, f] of Object.entries(fun)) {
    const kept = Object.values(state.leads).filter((l) => l.source === src && KEPT.includes(l.status) && state.funnel.at && Date.parse(l.firstSeen) >= Date.parse(state.funnel.at)).length;
    const dr = ['link_only', 'not_an_ask', 'not_discussion', 'outside_subreddits', 'too_old', 'duplicate'].filter((k) => f[k]).map((k) => `${k.replace(/_/g, ' ')} ${f[k]}`);
    lines.push(`Last round, ${src}: ${f.searches} search${f.searches === 1 ? '' : 'es'}, ${f.returned} returned${dr.length ? `, dropped: ${dr.join(', ')}` : ''}; ${f.toReview} sent to review, ${kept} kept.`);
  }
  // The Queries section, per source: the best queries by leads kept, the variants added this round and the retired ones. Nothing here waits
  // for the person: the model adds variants itself where no query kept a lead, and code retires a model query that kept nothing for two rounds.
  const set = querySetOf(profile, state);
  const bySource = {};
  for (const q of set) (bySource[q.source] ||= []).push(q);
  for (const [src, qs] of Object.entries(bySource)) {
    const stat = (q) => { const y = (state.queryYield || {})[labelOf(q.id)] || {}; const o = outcomeOf(state, labelOf(q.id)); return { q, results: y.found || 0, kept: o.kept, toReview: o.toReview }; };
    const best = qs.filter((q) => q.status === 'active').map(stat).sort((a, b) => b.kept - a.kept || b.results - a.results).slice(0, 3);
    const added = qs.filter((q) => !q.fromProfile && q.author === 'model' && q.addedRound === (state.rounds || []).length && q.status === 'active');
    const retired = qs.filter((q) => q.status === 'retired');
    const parts = [];
    if (best.length) parts.push(`best: ${best.map((b) => `${b.q.id} kept ${b.kept} of ${b.results} results`).join(', ')}`);
    if (added.length) parts.push(`added this round: ${added.map((q) => q.id).join(', ')}`);
    if (retired.length) parts.push(`retired: ${retired.map((q) => `${q.id} (${q.retiredWhy || 'retired'})`).join(', ')}`);
    lines.push(`Queries, ${src}: ${parts.join('; ')}.`);
  }
  const yq = Object.values(state.queryYield || {}).filter((y) => !y.stored);
  if (yq.length) lines.push(`Built queries (found, to review): ${yq.map((y) => `${y.offerId} ${y.source} "${String(y.label).slice(0, 30)}" ${y.found}, ${y.kept}`).join('; ')}.`);
  // The queries code builds when none is stored are loose on purpose and have never been tried live.
  const fallback = [];
  for (const o of offersOf(profile)) for (const src of ['x', 'reddit', 'linkedin', 'web', 'hn']) if (o.phrases.length && !o.queries[src] && (!profile.sources || profile.sources.includes(src))) fallback.push(`${o.id} ${src}`);
  if (fallback.length) lines.push(`Untested live: these use the queries code builds, not a query the model wrote and tested: ${fallback.join(', ')}.`);
  const drops = Object.entries(state.dropTally || {}).map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`);
  if (drops.length) lines.push(`Dropped before review by code filters, all time: ${drops.join(', ')}.`);
  const skipped = Object.values(state.leads).filter((l) => l.status === 'skipped');
  if (skipped.length) {
    const why = {};
    for (const l of skipped) why[l.skipReason || 'left'] = (why[l.skipReason || 'left'] || 0) + 1;
    lines.push(`Skipped: ${skipped.length} (${Object.entries(why).map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`).join(', ')}).`);
  }
  for (const h of liveHeld(state.held, profile)) lines.push(`${REFUSED.includes(h.status) ? `Held: ${h.detail || h.reason}. The skill's own request was refused: that is a defect in the skill to report, not something you fill in.` : `Held: ${h.detail || h.reason}.`}${h.reason === 'need_held' && h.key && !h.key.startsWith('need:query:') && h.status !== 'no_subreddits' ? ` Retry only this search: G search route --need "${h.key}".` : ''}`);
  for (const l of state.updateLines || []) lines.push(l);
  const t = state.tenjin || {};
  if (t.status && t.status !== 'ready') lines.push(hintLines(profile).search);
  return { lines, text: lines.join('\n') };
}
