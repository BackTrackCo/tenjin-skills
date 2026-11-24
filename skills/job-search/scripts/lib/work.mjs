import { graph } from './graph.mjs';
import { updateState, loadState } from './store.mjs';
import { loadOverlay, activeLessons, ruleValue } from './overlay.mjs';
import { readJson, stateDir } from './paths.mjs';
import { frequencyOf, periodStart, searchIsDue } from './schedule.mjs';
import { periodLimit } from './apply.mjs';
import { employerName } from './employer.mjs';
import { sha } from './dedupe.mjs';
import { canonical } from './overlay.mjs';
import { cleanupStale, isActive, batchMode } from './batch.mjs';
import { postFacts } from './postinfo.mjs';
import path from 'node:path';

export const POST_BATCH = 25;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const GATES = {
  web_search_due: 'Free web searches for this round: `J search plan` prints the exact queries. One Haiku step runs them and returns the raw results; `J ingest` the file (code extracts and sorts the URLs), then `J search web-done`.',
  need_due: 'A routed need that code cannot run (no adapter for its supplier). One Haiku step: state it in plain words through `request` if the tool is there, write the ingest file for it (references/search.md, section 2), `J ingest`, then `J search done <kind>`. No Tenjin tool: `J leave need:<kind> --reason no_web_search`.',
  fill_ready: 'Filled and waiting. Do not submit. The person checks the open tab, presses submit and says so; then `J submitted <key>`.',
  employer_page: 'Passed review, no employer posting yet. Haiku: find and read the employer\'s careers page; write {need:"careers_page", jobKey, careersUrl, status, fullResultPath, boardLinks, otherLinks, signIn}; `J ingest <file>`. Code fetches nothing from the page.',
  search_due: 'Run this search round (references/search.md): free web searches first, then the router needs if Tenjin is there; one ingest file per need with query.round; then `J search next`.',
  post_review: 'A batch of up to 25 X or Hacker News hiring posts, one subagent, one ingest file with batch[] (every post link) and outcomes[] (one per post: job, lead, not_hiring or no_fit; an unreadable post is not_hiring with reason unreadable). Each post carries its board links, author handle and emails, found by code. A post with a posting goes in postings[]; a lead with the handle or email of its item needs no leads[] record. A file with a post that has no outcome is refused.',
  new_job: 'Review: does the work match the title. Warn, never drop except on a mismatch. Score 0 to 100.',
  review_due: 'The posting changed. Review again.',
  contacts_requested: 'Free ways only (the router\'s people search is `J contacts route`, in code). Find a contact with a source link, or `J leave contacts:<key> --reason none_found`.',
  prepare_due: 'The sheet needs new writing, or its questions need the browser first (Lever, Ashby). Round writer call: `J write-prompt --round`, then `J write-result --round`. Facts only from the profile.',
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

// "Leave it": the model decided to leave a job as it is, with a reason from a closed list. The record is
// `left: {reason, at, inputs}`, where `inputs` is a hash of what the choice rested on. A left item is inventory, not due
// work, until that hash changes: new data (another source merged, a new apply link), a board that could match it
// joins the watch list, its content or open state changes, the person answers, or a rule that affects it changes. Never on a timer.
export const LEAVE_REASONS = ['low_score', 'no_match', 'no_careers_page', 'sign_in', 'other_system', 'not_a_job', 'duplicate'];
// The other work-list keys take their own reasons. A search item (the round, the free web search, a need code could not
// run) comes back at the next period; a contacts item comes back on news about its job. A post batch is never left.
export const ITEM_LEAVE_REASONS = { search: ['no_web_search'], contacts: ['none_found'] };
export const itemKind = (key) => (key === 'search' || key === 'web' || String(key).startsWith('need:') ? 'search' : String(key).startsWith('contacts:') ? 'contacts' : String(key).startsWith('posts:') ? 'posts' : 'job');
const RULE_EFFECTS = ['exclude_company', 'exclude_term', 'require_term', 'min_pay', 'place', 'remote', 'employment_type'];
export const rulesVersion = (overlay) => (overlay.rules || []).filter((r) => RULE_EFFECTS.includes(r.effect)).map((r) => `${r.effect}=${r.value}`).sort().join('|');
const hostOf = (u) => { try { return new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
// The host a sign-in wall sits on: the other system's page, else the employer's site, else the posting.
export const signInHost = (job) => hostOf((job.otherSystem && job.otherSystem.url) || job.employerWebsite || (job.employerPosting && job.employerPosting.url) || (job.applyLinks || [])[0] || '');
export const hasAccount = (profile, job) => {
  const host = signInHost(job);
  return Boolean(host) && String((profile.facts || {}).account || '').split(/[\s,]+/).filter(Boolean).map(hostOf).some((a) => a === host || host.endsWith(`.${a}`) || a.endsWith(`.${host}`));
};
// What the choice rested on. `other_system` also rests on the release's list of supported hiring systems (graph.json), so a
// release that adds the system brings the job back; `sign_in` rests on whether the person said they have an account there.
export function inputsHash(state, job, overlay, profile = {}, reason = null) {
  const co = employerName(job.company);
  const boards = (state.found || []).filter((b) => employerName(b.name) === co).map((b) => b.board).sort();
  const ep = job.employerPosting;
  const extra = reason === 'other_system' ? { systems: sha(JSON.stringify([...graph().hosts].sort())).slice(0, 8) } : reason === 'sign_in' ? { account: hasAccount(profile, job) } : null;
  return sha(canonical({ hash: job.hash, closed: job.status === 'closed', alsoAt: job.alsoAt || [], links: job.applyLinks || [], ep: ep ? [ep.url, ep.confidence] : null, boards, answers: state.answerV || 0, rules: rulesVersion(overlay), floor: (profile.unattended || {}).minScore ?? null, search: [(profile.search || {}).place || '', (profile.search || {}).remote === true], ...(extra ? { extra } : {}) })).slice(0, 16);
}
export function leaveRecord(state, job, overlay, reason, profile = {}) {
  if (!LEAVE_REASONS.includes(reason)) throw new Error(`the reason is one of ${LEAVE_REASONS.join(', ')}`);
  return { reason, at: new Date().toISOString(), inputs: inputsHash(state, job, overlay, profile, reason) };
}
export const stillLeft = (state, job, overlay, profile = {}) => Boolean(job.left && job.left.inputs === inputsHash(state, job, overlay, profile, job.left.reason));

// Items that are not a job. A search item comes back at the next period (its own trigger); a contacts item comes back when
// its job changes or the person answers.
export const itemInputs = (state, key, profile, now) => {
  if (itemKind(key) === 'contacts') {
    const job = state.jobs[key.slice(9)];
    return sha(canonical({ v: job ? itemVersion(job) : null, answers: state.answerV || 0 })).slice(0, 16);
  }
  return String(periodStart(now, frequencyOf(profile)));
};
export function leaveItem(state, key, reason, profile, now = Date.now()) {
  const kind = itemKind(key);
  if (kind === 'posts') throw new Error('a whole batch of posts is never left: give each post its outcome (an unreadable post is not_hiring with reason unreadable)');
  if (kind === 'contacts' && !state.jobs[key.slice(9)]) throw new Error(`unknown job: ${key.slice(9)}`);
  if (!(ITEM_LEAVE_REASONS[kind] || []).includes(reason)) throw new Error(`the reason for ${key} is one of ${(ITEM_LEAVE_REASONS[kind] || []).join(', ')}`);
  (state.leftItems ||= {})[key] = { reason, at: new Date(now).toISOString(), inputs: itemInputs(state, key, profile, now) };
}
export const itemStillLeft = (state, key, profile, now) => Boolean(state.leftItems && state.leftItems[key] && state.leftItems[key].inputs === itemInputs(state, key, profile, now));
// Every write to an item raises its state version: the version is a hash of the job's own record, apart from the clocks
// that a re-verify touches without any news.
export function itemVersion(job) {
  const { lastSeen, verifiedAt, firstSeen, statusAt, ...rest } = job;
  return sha(canonical(rest)).slice(0, 10);
}
// What waits for the person never wakes the model: a sheet that needs their yes (unless they gave it, or the mode is auto),
// a filled form waiting for their submit, a follow-up that asks them. Each keeps its one notification.
export function waitsForPerson(state, profile, item) {
  if (item.reason === 'fill_ready' || item.reason === 'follow_up_due') return true;
  if (item.reason === 'apply_ready') return !(String(profile.applyMode || '').startsWith('auto') || state.approvals[item.key]);
  return false;
}

// Work on a job's employer posting is worth doing only for the jobs this period can use: ranked best fit first within the
// positions rule (all of them when there is no limit), and above the person's score floor when they set one.
export function inPeriodSet(state, job, profile, overlay) {
  const floor = (profile.unattended || {}).minScore;
  if (typeof floor === 'number' && !(typeof job.fit === 'number' && job.fit >= floor)) return false;
  const limit = periodLimit(overlay);
  if (limit === null) return true;
  const ranked = Object.values(state.jobs).filter((x) => x.status === 'reviewed' && !x.employerPosting && (typeof floor !== 'number' || (typeof x.fit === 'number' && x.fit >= floor))).sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1)).slice(0, limit);
  return ranked.some((x) => x.key === job.key);
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
  const inventory = [];
  if (searchDue(state, profile, now, opts) && !itemStillLeft(state, 'search', profile, now)) {
    const round = searchRound(state, profile, now);
    const last = state.routed.lastSearchAt;
    const since = last ? new Date(Math.max(Date.parse(last) - 86400000, now - 14 * 86400000)) : new Date(now - 14 * 86400000);
    items.push({ key: 'search', reason: 'search_due', title: 'Daily routed search', company: '', gate: GATES.search_due, hint: tenjinHint(state, 'daily_search'), askTenjin: tenjinAsk(state, { unattended: opts.unattended === true }), query: { role: profile.search.role, place: profile.search.place || '', remote: profile.search.remote === true, since: since.toISOString().slice(0, 10), variant: variantFor(profile, round), round }, routed: !state.held.some((h) => h.reason === 'tenjin_missing') && !['missing', 'outdated', 'unfunded'].includes((state.tenjin || {}).status) });
  }
  // The web search stays a model step with Tenjin (the router answers native): one item per round, until recorded as done.
  if (state.search.webPending && !itemStillLeft(state, 'web', profile, now)) items.push({ key: 'web', reason: 'web_search_due', title: 'Free web searches', company: '', gate: GATES.web_search_due, query: { role: profile.search && profile.search.role, place: profile.search && profile.search.place, round: state.search.webPending.round } });
  // A routed need that code could not run (no adapter, an unknown supplier) is one Haiku item in the round's wake.
  for (const n of state.search.needPending || []) if (!itemStillLeft(state, `need:${n.kind}`, profile, now)) items.push({ key: `need:${n.kind}`, reason: 'need_due', title: `Search: ${n.kind.replace(/_/g, ' ')}`, company: '', gate: GATES.need_due, query: { ...n.query, kind: n.kind, text: n.text, round: n.round } });
  // One Haiku subagent takes a batch of hiring posts and writes one ingest file. 25 posts is about 6,000 tokens of
  // input, the size of one review round, and keeps one bad batch from costing the rest.
  const fresh = (state.posts || []).filter((p) => p.status === 'new');
  for (let i = 0; i < fresh.length; i += POST_BATCH) {
    const batch = fresh.slice(i, i + POST_BATCH);
    items.push({ key: `posts:${batch[0].url}`, reason: 'post_review', title: `${batch.length} hiring posts`, company: '', posts: batch.map(postFacts), gate: GATES.post_review });
  }
  const add = (j, reason) => items.push({ key: j.key, reason, title: j.title, company: j.company, gate: GATES[reason] });
  for (const j of Object.values(state.jobs)) {
    if (graph().terminal.includes(j.status)) continue;
    if (stillLeft(state, j, overlay, profile)) {
      inventory.push({ key: j.key, title: j.title, company: j.company, left: j.left.reason });
      continue;
    }
    if (j.parked) {
      inventory.push({ key: j.key, title: j.title, company: j.company, parked: j.parked.reasons });
      continue;
    }
    if (j.fillReady) {
      add(j, 'fill_ready');
      continue;
    }
    if (j.status === 'reviewed' && !j.employerPosting && !j.careersChecked && ['no_board', 'unconfirmed_board', 'no_match', 'no_apply_link', 'yc_platform_only'].includes(j.unresolved) && inPeriodSet(state, j, profile, overlay)) {
      items.push({ key: j.key, reason: 'employer_page', title: j.title, company: j.company, website: j.employerWebsite || null, gate: GATES.employer_page });
      continue;
    }
    if (j.status === 'new') {
      if (!(j.reviewedHash && j.reviewedHash === j.hash)) add(j, j.reviewedHash ? 'review_due' : 'new_job');
    }
    else if (j.status === 'shortlisted') {
      // Model work only when the sheet has new writing, or its questions need the browser first (Lever, Ashby, a failed fetch).
      if (j.needsWriting || (!j.questions && (j.questionsTried || j.ats !== 'greenhouse'))) add(j, 'prepare_due');
    }
    else if (j.status === 'apply_ready') add(j, 'apply_ready');
    else if (j.status === 'submitted' && !j.followUpAsked && now - Date.parse(j.statusAt) > graph().followUpDays * DAY) add(j, 'follow_up_due');
  }
  for (const key of state.contactsRequested || []) {
    const cj = state.jobs[key];
    if (!cj || (state.contacts[key] || []).length || itemStillLeft(state, `contacts:${key}`, profile, now)) continue;
    items.push({ key, leaveKey: `contacts:${key}`, reason: 'contacts_requested', title: cj.title, company: cj.company, gate: GATES.contacts_requested });
  }
  for (const i of items) {
    const job = state.jobs[i.key];
    i.v = i.reason === 'web_search_due' ? `${state.search.webPending.round}:${state.search.webPending.at}` : i.reason === 'need_due' ? (() => { const n = state.search.needPending.find((x) => `need:${x.kind}` === i.key); return `${n.round}:${n.at}`; })() : job ? itemVersion(job) : i.reason === 'search_due' ? `${(state.search.session || {}).round ?? 'new'}:${state.routed.lastSearchAt}` : String(i.posts ? i.posts.length : 0);
    i.waitsForPerson = waitsForPerson(state, profile, i);
  }
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
  // An update line goes to the report and the notify set, never a wake of its own.
  (state.updateLines || []).forEach((l, i) => { w[`update:${i}:${l}`] = l; });
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
  const updates = fresh.filter((k) => k.startsWith('update:'));
  const parts = [];
  if (filled) parts.push(`${filled} filled, waiting for your submit (fill ready)`);
  if (yes) parts.push(`${yes} application${yes > 1 ? 's' : ''} wait for your yes`);
  if (stops.length) {
    const j = state.jobs[stops[0].slice(5)];
    parts.push(`${stops.length} stop${stops.length > 1 ? 's' : ''} need you${stops.length === 1 && j ? ` at ${j.company}` : ''} (${j && j.parked ? (j.parked.reasons[0] === 'needs_facts' && (j.missingFacts || []).length ? `needs facts: ${j.missingFacts.map((f) => f.replace(/_/g, ' ')).join(', ')}` : j.parked.reasons[0].replace(/_/g, ' ')) : 'parked'})`);
  }
  if (updates.length) parts.push(`${updates.length} update${updates.length > 1 ? 's' : ''} for the report`);
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
      for (const j of Object.values(state.jobs)) if (j.left && !stillLeft(state, j, overlay, readJson(path.join(stateDir(), 'profile.json'), {}))) j.left = null; // news came: due again
      for (const k of Object.keys(state.leftItems || {})) if (!itemStillLeft(state, k, readJson(path.join(stateDir(), 'profile.json'), {}), now)) delete state.leftItems[k];
      for (const k of wl.bring) state.jobs[k].broughtAt = new Date(now).toISOString(); // brought for the person's yes
    }
    return wl;
  };
  res = commit ? updateState(compute) : compute(loadState());
  res.exit = res.items.length ? 0 : 3;
  if (staleBatchClosed) res.staleBatchClosed = true;
  return res;
}
