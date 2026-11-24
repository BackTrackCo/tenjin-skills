import { graph } from './graph.mjs';
import { updateState, loadState } from './store.mjs';
import { loadOverlay, activeLessons, ruleValue } from './overlay.mjs';
import { readJson, stateDir } from './paths.mjs';
import { frequencyOf, periodStart, searchIsDue } from './schedule.mjs';
import { periodLimit } from './apply.mjs';
import { cleanupStale, isActive, batchMode } from './batch.mjs';
import path from 'node:path';

export const POST_BATCH = 25;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const GATES = {
  fill_ready: 'Filled and waiting. Do not submit. The person checks the open tab, presses submit and says so; then `J submitted <key>`.',
  employer_page: 'Passed review, no employer posting yet. Haiku: find and read the employer\'s careers page; write {need:"careers_page", jobKey, careersUrl, status, fullResultPath, boardLinks, otherLinks, signIn}; `J ingest <file>`. Code fetches nothing from the page.',
  search_due: 'Run this search round (references/search.md): free web searches first, then the router needs if Tenjin is there; one ingest file per need with query.round; then `J search next`.',
  post_review: 'A batch of up to 25 X or Hacker News hiring posts, one subagent, one ingest file with batch[] (every post link) and outcomes[] (one per post: job, lead, not_hiring or no_fit). A post with a posting goes in postings[]; a post with no posting but a person to write to goes in leads[]. A file with a post that has no outcome is refused.',
  new_job: 'Review: does the work match the title. Warn, never drop except on a mismatch. Score 0 to 100.',
  review_due: 'The posting changed. Review again.',
  reverify_due: 'Verify the job is still open before it goes further.',
  contacts_requested: 'Find a contact with a source link, or say none was found.',
  prepare_due: 'Build the sheet, then have the writer draft the prose. Facts only from the profile.',
  apply_ready: 'Attended: show the sheet, wait for a yes. Never submit without it.',
  follow_up_due: 'Ask the person for the status. Do not contact the employer.',
};
const PERSON_HELD = ['chrome_disconnected', 'no_chrome_tools', 'update_waiting', 'update_failed', 'stopped'];

export function park(job, reasons) {
  const key = `${job.key}@${job.hash}`;
  const sorted = [...reasons].sort();
  if (job.parked && job.parked.key === key && JSON.stringify(job.parked.reasons) === JSON.stringify(sorted)) return false;
  job.parked = { key, reasons: sorted };
  return true;
}
export function unpark(job) {
  job.parked = null;
}

// The guard denies every MCP tool in an unattended batch, the request tool included, so the search waits.
export function unattendedBatchOpen() {
  return isActive() && batchMode() === 'unattended';
}

// The daily search is rounds: one query per need for one role-word variant (round 0 is the role itself, round N is
// search.variants[N-1]). Code stops when a round adds no new job that passes dedupe, date, place and role words,
// or when the variants run out. No cap on results.
export function variantFor(profile, round) {
  return round === 0 ? null : ((profile.search || {}).variants || [])[round - 1] || null;
}
export function searchRound(state, profile, now) {
  if (!profile.search || !profile.search.role) return null;
  if (state.search && state.search.session && !state.search.session.finished) return state.search.session.round;
  const last = state.routed && state.routed.lastSearchAt ? Date.parse(state.routed.lastSearchAt) : null;
  return searchIsDue({ lastAt: last, now, frequency: frequencyOf(profile), hour: profile.sweepHour ?? graph().sweep.defaultHour }) ? 0 : null;
}
export function searchDue(state, profile, now, { unattendedOpen = false } = {}) {
  return !unattendedOpen && searchRound(state, profile, now) !== null;
}
// `search next`: judge the round that just ended and move on, or finish.
export function advanceSearch(state, profile) {
  const sess = state.search.session;
  if (!sess || sess.finished) return { done: true, reason: 'no search in progress' };
  const last = (profile.search.variants || []).length;
  if (sess.roundAdded === 0) {
    sess.finished = true;
    return { done: true, reason: 'the last round added no new job' };
  }
  if (sess.round >= last) {
    sess.finished = true;
    return { done: true, reason: 'the variants ran out' };
  }
  sess.round += 1;
  sess.roundAdded = 0;
  return { done: false, round: sess.round, variant: variantFor(profile, sess.round) };
}

// Where Tenjin would do better, and what it adds there. Code decides when; the model never does.
export const HINT_LINES = {
  daily_search: 'With Tenjin I can also run the router\'s job-posting search and a live X search, on top of the free searches.',
  employer_posting: 'With Tenjin I can look up this employer\'s careers page through the router.',
  contacts: 'With Tenjin I can run the router\'s people search for jobs where the free ways found nobody.',
  outdated: 'Tenjin is out of date; after the update the CLI names, the routed search runs again.',
};
export function tenjinHint(state, moment) {
  const t = state.tenjin || {};
  if (!t.status || t.status === 'ready') return null;
  const line = t.status === 'outdated' && moment === 'daily_search' ? HINT_LINES.outdated : HINT_LINES[moment];
  return line ? { moment, status: t.status, line } : null;
}
// At most one ask per session, and none after a recorded no in this session. An unattended run only mentions.
export function tenjinAsk(state, { unattended = false } = {}) {
  const t = state.tenjin || {};
  if (!t.status || t.status === 'ready' || unattended) return false;
  const holder = state.lease ? state.lease.holder : 'none';
  return t.askedHolder !== holder;
}

export function buildWorkList(state, overlay, now = Date.now(), profile = {}, opts = {}) {
  const items = [];
  if (searchDue(state, profile, now, opts)) {
    const round = searchRound(state, profile, now);
    const last = state.routed.lastSearchAt;
    const since = last ? new Date(Math.max(Date.parse(last) - 86400000, now - 14 * 86400000)) : new Date(now - 14 * 86400000);
    items.push({ key: 'search', reason: 'search_due', title: 'Daily routed search', company: '', gate: GATES.search_due, hint: tenjinHint(state, 'daily_search'), askTenjin: tenjinAsk(state, { unattended: opts.unattended === true }), query: { role: profile.search.role, place: profile.search.place || '', remote: profile.search.remote === true, since: since.toISOString().slice(0, 10), variant: variantFor(profile, round), round }, routed: !state.held.some((h) => h.reason === 'tenjin_missing') && !['missing', 'outdated', 'unfunded'].includes((state.tenjin || {}).status) });
  }
  // One Haiku subagent takes a batch of hiring posts and writes one ingest file. 25 posts is about 6,000 tokens of
  // input, the size of one review round, and keeps one bad batch from costing the rest.
  const fresh = (state.posts || []).filter((p) => p.status === 'new');
  for (let i = 0; i < fresh.length; i += POST_BATCH) {
    const batch = fresh.slice(i, i + POST_BATCH);
    items.push({ key: `posts:${batch[0].url}`, reason: 'post_review', title: `${batch.length} hiring posts`, company: '', posts: batch.map((p) => ({ url: p.url, author: p.author, text: p.text })), gate: GATES.post_review });
  }
  const inventory = [];
  const add = (j, reason) => items.push({ key: j.key, reason, title: j.title, company: j.company, gate: GATES[reason] });
  for (const j of Object.values(state.jobs)) {
    if (graph().terminal.includes(j.status)) continue;
    if (j.parked) {
      inventory.push({ key: j.key, title: j.title, company: j.company, parked: j.parked.reasons });
      continue;
    }
    if (j.fillReady) {
      add(j, 'fill_ready');
      continue;
    }
    if (j.status === 'reviewed' && !j.employerPosting && !j.careersChecked && ['no_board', 'unconfirmed_board', 'no_match', 'no_apply_link', 'yc_platform_only'].includes(j.unresolved)) {
      items.push({ key: j.key, reason: 'employer_page', title: j.title, company: j.company, website: j.employerWebsite || null, gate: GATES.employer_page });
      continue;
    }
    if (j.status === 'new') {
      if (!(j.reviewedHash && j.reviewedHash === j.hash)) add(j, j.reviewedHash ? 'review_due' : 'new_job');
    }
    else if (j.status === 'shortlisted') add(j, 'prepare_due');
    else if (j.status === 'apply_ready') add(j, 'apply_ready');
    else if (j.status === 'submitted' && !j.followUpAsked && now - Date.parse(j.statusAt) > graph().followUpDays * DAY) add(j, 'follow_up_due');
    if (['reviewed', 'shortlisted', 'prepared', 'apply_ready'].includes(j.status) && now - Date.parse(j.verifiedAt) > graph().unattendedWindow.verifiedHours * HOUR) add(j, 'reverify_due');
  }
  for (const key of state.contactsRequested || []) if (state.jobs[key] && !(state.contacts[key] || []).length) add(state.jobs[key], 'contacts_requested');
  for (const i of items) {
    if (i.reason === 'employer_page') i.hint = tenjinHint(state, 'employer_posting');
    if (i.reason === 'contacts_requested') i.hint = tenjinHint(state, 'contacts');
  }
  // Positions per period (attended): the sheets brought for the person's yes. A sheet already brought stays; new ones
  // come best fit first until the period's count is reached. The rest stay ranked for the next period, none dropped.
  const limit = periodLimit(overlay);
  const bring = [];
  let heldForPeriod = 0;
  if (limit !== null) {
    const start = periodStart(now, frequencyOf(profile));
    const brought = Object.values(state.jobs).filter((j) => j.broughtAt && Date.parse(j.broughtAt) >= start).length;
    let room = Math.max(0, limit - brought);
    const fresh = items.filter((i) => i.reason === 'apply_ready' && !state.jobs[i.key].broughtAt).sort((a, b) => (state.jobs[b.key].fit ?? -1) - (state.jobs[a.key].fit ?? -1));
    const allowed = new Set(fresh.slice(0, room).map((i) => i.key));
    for (const i of fresh) if (!allowed.has(i.key)) heldForPeriod++;
    for (let k = items.length - 1; k >= 0; k--) if (items[k].reason === 'apply_ready' && !state.jobs[items[k].key].broughtAt && !allowed.has(items[k].key)) items.splice(k, 1);
    bring.push(...allowed);
  } else bring.push(...items.filter((i) => i.reason === 'apply_ready' && !state.jobs[i.key].broughtAt).map((i) => i.key));
  return {
    bring,
    heldForPeriod,
    items,
    held: state.held,
    inventory,
    rules: (overlay.rules || []).map((r) => ({ id: r.id, effect: r.effect, value: r.value, words: r.words, date: r.date })),
    lessons: activeLessons(overlay, now).map((l) => ({ id: l.id, text: l.text, expires: l.expires })),
  };
}

// What waits on the person, as key -> signature. A parked item that did not change keeps the same signature.
export function waitingSet(state) {
  const w = {};
  for (const j of Object.values(state.jobs)) {
    if (graph().terminal.includes(j.status)) continue;
    if (j.fillReady) w[`fill:${j.key}`] = `${j.fillReady.at}|${j.company}`;
    else if (j.parked) w[`park:${j.key}`] = `${j.parked.key}|${j.parked.reasons.join(',')}|${j.company}`;
    else if (j.status === 'apply_ready' && !state.approvals[j.key] && j.employerPosting) w[`yes:${j.key}`] = `${j.hash}|${j.company}`;
  }
  for (const h of state.held) if (PERSON_HELD.includes(h.reason)) w[`held:${h.reason}:${h.detail || ''}`] = h.reason;
  // Every consent change and writing approval is visible: one notification, and a line in the next report.
  for (const c of state.consentLog || []) if (!c.acked) w[`consent:${c.at}`] = c.what;
  return w;
}

export function notifyLine(state, overlay, now = Date.now(), { unattended = false } = {}) {
  const w = waitingSet(state);
  const fresh = Object.keys(w).filter((k) => state.notified[k] !== w[k]);
  if (!fresh.length) return { line: null, next: w };
  if (ruleValue(overlay, 'notify_off') !== undefined) return { line: null, next: w };
  const q = ruleValue(overlay, 'notify_quiet_hours');
  if (typeof q === 'string' && /^\d{1,2}-\d{1,2}$/.test(q)) {
    const [a, b] = q.split('-').map(Number);
    const h = new Date(now).getHours();
    const inQuiet = a <= b ? h >= a && h < b : h >= a || h < b;
    if (inQuiet) return { line: null, next: state.notified }; // keep unnotified, so it pushes after quiet hours
  }
  const yes = fresh.filter((k) => k.startsWith('yes:')).length;
  const filled = fresh.filter((k) => k.startsWith('fill:')).length;
  const stops = fresh.filter((k) => k.startsWith('park:'));
  const held = fresh.filter((k) => k.startsWith('held:')).map((k) => k.split(':')[1]);
  const consents = fresh.filter((k) => k.startsWith('consent:'));
  const parts = [];
  if (filled) parts.push(`${filled} filled, waiting for your submit (fill ready)`);
  if (yes) parts.push(`${yes} application${yes > 1 ? 's' : ''} wait for your yes`);
  if (stops.length) {
    const j = state.jobs[stops[0].slice(5)];
    parts.push(`${stops.length} stop${stops.length > 1 ? 's' : ''} need you${stops.length === 1 && j ? ` at ${j.company}` : ''} (${j && j.parked ? (j.parked.reasons[0] === 'needs_facts' && (j.missingFacts || []).length ? `needs facts: ${j.missingFacts.map((f) => f.replace(/_/g, ' ')).join(', ')}` : j.parked.reasons[0].replace(/_/g, ' ')) : 'parked'})`);
  }
  if (consents.length) parts.push(`consent changed: ${[...new Set(consents.map((k) => w[k]))].join('; ')}`);
  if (held.length) parts.push(`needs you: ${[...new Set(held)].join(', ').replace(/_/g, ' ')}`);
  let line = parts.join(', ').replace(/[*_`#\[\]]/g, '');
  if (line.length > 190) line = line.slice(0, 187) + '...';
  // In an unattended run nobody can answer the ask, so the Tenjin hint rides on the notification when it fits.
  const hint = unattended ? tenjinHint(state, 'daily_search') : null;
  if (hint && line.length + 3 + hint.line.length < 200) line += ` | ${hint.line}`;
  return { line, next: w };
}

// The work-list command. With commit, the notify line is marked as sent (at most once).
export function workList({ now = Date.now(), commit = false, unattended = false } = {}) {
  const staleBatchClosed = cleanupStale(now);
  const overlay = loadOverlay();
  let res;
  const compute = (state) => {
    const wl = buildWorkList(state, overlay, now, readJson(path.join(stateDir(), 'profile.json'), {}), { unattendedOpen: unattendedBatchOpen(), unattended });
    const n = notifyLine(state, overlay, now, { unattended });
    wl.notify = n.line;
    if (commit) {
      state.notified = n.next;
      for (const k of wl.bring) state.jobs[k].broughtAt = new Date(now).toISOString(); // brought for the person's yes
    }
    return wl;
  };
  res = commit ? updateState(compute) : compute(loadState());
  res.exit = res.items.length ? 0 : 3;
  if (staleBatchClosed) res.staleBatchClosed = true;
  return res;
}
