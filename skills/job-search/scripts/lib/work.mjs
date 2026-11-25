import { graph } from './graph.mjs';
import { updateState, loadState } from './store.mjs';
import { loadOverlay, activeLessons, ruleValue } from './overlay.mjs';
import { readJson, stateDir } from './paths.mjs';
import { frequencyOf, periodStart, searchIsDue } from './schedule.mjs';
import { applyPathOf, periodLimit } from './apply.mjs';
import { openUrlOf } from './open.mjs';
import { employerName } from './employer.mjs';
import { sha } from './dedupe.mjs';
import { canonical } from './overlay.mjs';
import { cleanupStale, isActive, batchMode } from './batch.mjs';
import { postFacts } from './postinfo.mjs';
import { tenjinAsk as tenjinAskQuestion } from './questions.mjs';
import { emailConsentCurrent, pending as pendingEmails } from './email.mjs';
import path from 'node:path';

export const POST_BATCH = 25;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const GATES = {
  web_search_due: 'Free web searches for this round: `J search plan` prints the exact queries. One Haiku step runs them and returns the raw results; `J ingest` the file (code extracts and sorts the URLs), then `J search web-done`.',
  need_due: 'A routed need that code cannot run (no adapter for its supplier). One Haiku step: state it in plain words through `request` if the tool is there, write the ingest file for it (references/search.md, section 2), `J ingest`, then `J search done <kind>`. No Tenjin tool: `J leave need:<kind> --reason no_web_search`.',
  email_due: 'Intro emails to addresses the poster published. Attended: `J email batch`, `J ask email`, `J email approve <ids> --skip-rest`. Then `J email next` (add --unattended under the email consent) and send only what it hands out; `J email sent <id>` after each.',
  fill_ready: 'Filled and waiting. Do not submit. The person checks the open tab, presses submit and says so; then `J submitted <key>`.',
  employer_page: 'Passed review, no employer posting yet (or a re-verify: the item says so). Haiku: find and read the employer\'s own careers page; write {need:"careers_page", jobKey, careersUrl, status:"fulfilled", boardLinks, otherLinks, listings:[{title, url, city, remote}], signIn}; `J ingest <file>`. Code fetches nothing from the page.',
  search_due: 'Run this search round (references/search.md): free web searches first, then the router needs if Tenjin is there; one ingest file per need with query.round; then `J search next`.',
  post_review: 'A batch of up to 25 X or Hacker News hiring posts, one subagent, one ingest file with batch[] (every post link) and outcomes[] (one per post: job, lead, not_hiring or no_fit; an unreadable post is not_hiring with reason unreadable). Each post carries its board links, author handle and emails, found by code. A post with a posting goes in postings[]; a lead with the handle or email of its item needs no leads[] record. A file with a post that has no outcome is refused.',
  new_job: 'Review: does the work match the title. Warn, never drop except on a mismatch. Score 0 to 100.',
  review_due: 'The posting changed. Review again.',
  contacts_requested: 'Free ways only (the router\'s people search is `J contacts route`, in code). Find a contact with a source link, or `J leave contacts:<key> --reason none_found`.',
  prepare_due: 'The sheet needs new writing, or its questions need the browser first (Lever, Ashby). Round writer call: `J write-prompt --round`, then `J write-result --round`. Facts only from the profile.',
  linkedin_ready: 'The person applies on LinkedIn: `J linkedin show <key>` prints the job\'s own LinkedIn link and the prepared answers; show both in the reply. Never open, fetch or fill LinkedIn.',
  open_ready: 'Open the page for the person: `J open <key...>` (attended turns only) opens each job\'s page in their own browser; then show each job\'s sheet as text so they can copy the answers. Nothing is filled or submitted; the outcome is their word (`J submitted <key>`).',
  linkedin_applied: 'A LinkedIn link was shown: ask once, `J ask applied --key <key>`, then `J linkedin applied <key> yes|not_yet|skip`. Applied is recorded only on the person\'s word.',
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
// What the choice rested on, per reason: each hash holds only what bears on that reason, so saving a form fact or an answer
// revives no left job. `low_score` rests on the role, the place, the level rules, the resume and the score floor;
// `no_match` and `no_careers_page` on the job's data and the boards that could match it; `sign_in` on whether the person
// said they have an account at that host; `other_system` on the deny list. Form facts and saved answers are in none of them.
export function inputsHash(state, job, overlay, profile = {}, reason = null) {
  const co = employerName(job.company);
  const boards = (state.found || []).filter((b) => employerName(b.name) === co).map((b) => b.board).sort();
  const ep = job.employerPosting;
  const base = { hash: job.hash, closed: job.status === 'closed' };
  const search = profile.search || {};
  let parts;
  if (reason === 'low_score') {
    parts = { ...base, role: search.role || '', variants: search.variants || [], place: search.place || '', remote: search.remote === true, rules: rulesVersion(overlay), levels: (profile.unattended || {}).excludeLevels || [], floor: (profile.unattended || {}).minScore ?? null, resume: sha(String(profile.resumeText || '')).slice(0, 12) };
  } else if (reason === 'other_system') {
    parts = { ...base, host: signInHost(job), denied: sha(JSON.stringify([...graph().neverHosts].sort())).slice(0, 8) };
  } else if (reason === 'sign_in') {
    parts = { host: signInHost(job), account: hasAccount(profile, job) };
  } else if (reason === 'no_match' || reason === 'no_careers_page') {
    parts = { ...base, alsoAt: job.alsoAt || [], links: job.applyLinks || [], ep: ep ? [ep.url, ep.confidence] : null, boards };
  } else {
    parts = { ...base, alsoAt: job.alsoAt || [] };
  }
  return sha(canonical(parts)).slice(0, 16);
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
// Work already handed to the model is claimed in code, with a time, so it never wakes the model again: `J work --commit`
// claims the items it prints. The watcher's wake set leaves claimed items out. A claim ends when the item's result is
// ingested, when it is left, when the item is no longer due, or at the time limit. The limit is 20 minutes: a little longer
// than the slowest claimed step, one browser application (a few minutes, up to about a quarter of an hour with slow pages),
// so a step that is still running keeps its claim, while an agent that died holds its item for at most 20 minutes. An item
// still open when its claim times out gets a version change, so it wakes the model once. An apply loop refreshes its claims.
export const CLAIM_MS = 20 * 60000;
const ckey = (i) => `${i.key}|${i.reason}`;
export const claimActive = (state, item, now = Date.now()) => {
  const c = (state.claims || {})[ckey(item)];
  return Boolean(c && now - Date.parse(c.at) < CLAIM_MS);
};
export function claimItems(state, items, now = Date.now()) {
  for (const i of items) if (!i.waitsForPerson) (state.claims ||= {})[ckey(i)] = { at: new Date(now).toISOString() };
}
// Drop claims for items that are no longer due, and end claims past the limit: an item still due then wakes once.
export function settleClaims(state, items, now = Date.now()) {
  const due = new Set(items.map(ckey));
  for (const [k, c] of Object.entries(state.claims || {})) {
    if (!due.has(k)) delete state.claims[k];
    else if (now - Date.parse(c.at) >= CLAIM_MS) {
      delete state.claims[k];
      (state.claimEpochs ||= {})[k] = (state.claimEpochs[k] || 0) + 1;
    }
  }
}
export function releaseClaims(state, match) {
  for (const k of Object.keys(state.claims || {})) if (match(k.split('|')[0], k.split('|')[1])) delete state.claims[k];
}
export function refreshClaims(state, reason, now = Date.now()) {
  for (const [k, c] of Object.entries(state.claims || {})) if (k.endsWith(`|${reason}`)) c.at = new Date(now).toISOString();
}
// The due items the model could act on now that nobody has been handed.
export const unclaimedDue = (state, items, now = Date.now()) => items.filter((i) => !i.waitsForPerson && !claimActive(state, i, now));

// Every write to an item raises its state version: the version is a hash of the job's own record, apart from the clocks
// that a re-verify touches without any news.
export function itemVersion(job) {
  const { lastSeen, verifiedAt, firstSeen, statusAt, linkedinShownAt, linkedinAskedV, broughtAt, inFlight, openedAt, ...rest } = job;
  return sha(canonical(rest)).slice(0, 10);
}
// What waits for the person never wakes the model: a sheet that needs their yes (unless they gave it, or the mode is auto),
// a filled form waiting for their submit, a follow-up that asks them. Each keeps its one notification.
export function waitsForPerson(state, profile, item, overlay = { rules: [] }) {
  if (item.reason === 'fill_ready' || item.reason === 'follow_up_due' || item.reason === 'linkedin_applied' || item.reason === 'open_ready') return true;
  if (item.reason === 'email_due') return !emailConsentCurrent(state, profile, overlay);
  if (item.reason === 'apply_ready') return !(String(profile.applyMode || '').startsWith('auto') || profile.applyMode === 'fill_only' || (state.jobs[item.key] || {}).fillOnly || state.approvals[item.key]);
  return false;
}

// Work on a job's employer posting is worth doing only for the jobs this period can use: ranked best fit first within the
// positions rule (all of them when there is no limit), and above the person's score floor when they set one.
export function inPeriodSet(state, job, profile, overlay, now = Date.now()) {
  const floor = (profile.unattended || {}).minScore;
  if (typeof floor === 'number' && !(typeof job.fit === 'number' && job.fit >= floor)) return false;
  const limit = periodLimit(overlay, { profile, now });
  if (limit === null) return true;
  const ranked = Object.values(state.jobs).filter((x) => x.status === 'reviewed' && !x.employerPosting && (typeof floor !== 'number' || (typeof x.fit === 'number' && x.fit >= floor))).sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1)).slice(0, limit);
  return ranked.some((x) => x.key === job.key);
}

// The jobs the skill plans to apply to: an exact or confirmed employer posting, above the score floor if set, best fit first,
// within this period's most (jobs already prepared or waiting for a yes count first; the rest of the room goes to reviewed
// jobs by rank). No limit means every one that fits. These are prepared with no question and no shortlist step.
const PLAN_STATES = ['reviewed', 'shortlisted', 'prepared', 'apply_ready'];
export function plannedJobs(state, profile, overlay, now = Date.now()) {
  const floor = (profile.unattended || {}).minScore;
  // A job the person applies to on LinkedIn is planned too: its link is shown with the prepared answers.
  const ok = (j) => ((j.employerPosting && ['exact', 'confirmed'].includes(j.employerPosting.confidence) && j.openConfirmed === true) || (j.linkedinUrl && applyPathOf(j, profile) === 'linkedin')) && !j.left && !(typeof floor === 'number' && !(typeof j.fit === 'number' && j.fit >= floor));
  const all = Object.values(state.jobs).filter((j) => PLAN_STATES.includes(j.status) && ok(j)).sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1));
  const limit = periodLimit(overlay, { profile, now });
  if (limit === null) return all;
  const began = (j) => j.status !== 'reviewed' || Boolean(j.linkedinShownAt);
  const started = all.filter(began);
  return [...started, ...all.filter((j) => !began(j)).slice(0, Math.max(0, limit - started.length))];
}

// Where Tenjin would do better, and what it adds there. Code decides when; the model never does.
export const HINT_LINES = {
  daily_search: 'With Tenjin I can also run the router\'s job-posting search and a live X search, on top of the free searches.',
  employer_posting: 'With Tenjin I can look up this employer\'s careers page through the router.',
  contacts: 'With Tenjin I can run the router\'s people search for jobs where the free ways found nobody.',
  linkedin_resume: 'With Tenjin I can read a LinkedIn profile link; until then a PDF export of the profile or the text works.',
  outdated: 'Tenjin is out of date; after the update the CLI names, the routed search runs again.',
};
// The once-per-session ask lists everything Tenjin adds: this moment's line first, then every other line, then the cost line.
// Lines are named by what they do, never by seller. A hint stays one line about its moment (HINT_LINES). There is no writing
// line until the Neon switch.
export const OFFER_LINES = {
  sources: 'more job sources: postings gathered from job boards across the web, and hiring posts on X',
  boards: 'the employer board search in code, in place of a model web search each round',
  posting: 'the employer\'s own application page for a job seen elsewhere',
  contacts: 'a hiring manager or team lead where the free ways found nobody, with the company looked up first when its website is not known, so the skill can draft an intro for them',
  linkedin: 'a LinkedIn link as the resume',
  background: 'these searches and lookups run in the background in code, so they use none of your Claude usage and do not wake the session',
};
export const OFFER_COST = 'Pay per use from a funded wallet, within your spending limits: an estimated few cents a day at the default pace.';
// Every routed need in graph.json has a line here, so a new need cannot be left out (a test checks it).
export const NEED_LINES = { job_postings: 'sources', x_hiring_posts: 'sources', web_search: 'boards', careers_page: 'posting', people_search: 'contacts', company_lookup: 'contacts', linkedin_profile: 'linkedin' };
const MOMENT_LINE = { daily_search: 'sources', employer_posting: 'posting', contacts: 'contacts', linkedin_resume: 'linkedin' };
export function tenjinOffer(moment, state = {}) {
  const t = state.tenjin || {};
  const order = Object.keys(OFFER_LINES).filter((k) => k !== 'background');
  const first = MOMENT_LINE[moment];
  const lines = [...(first ? [first] : []), ...order.filter((k) => k !== first), 'background'].map((k) => OFFER_LINES[k]);
  const update = t.status === 'outdated' ? `${t.version ? `Tenjin ${t.version}` : 'Tenjin'} is out of date; the update the CLI names adds back what the routed searches did.\n` : '';
  return `${update}Tenjin adds:\n${lines.map((l) => `- ${l}`).join('\n')}\n${OFFER_COST}`;
}
export function tenjinHint(state, moment) {
  const t = state.tenjin || {};
  if (!t.status || t.status === 'ready') return null;
  // An outdated Tenjin gets the same hint at every moment, naming the update.
  const line = t.status === 'outdated' ? `${t.version ? `Tenjin ${t.version}` : 'Tenjin'} is out of date; ${HINT_LINES.outdated.replace(/^Tenjin is out of date; /, '')}` : HINT_LINES[moment];
  return line ? { moment, status: t.status, line } : null;
}
// The shared `askDue` state: Tenjin not ready, an attended turn, and the session's one ask not yet answered. Every command
// that hands out a free path calls askFirst before it, so the ask comes right before the session's first payable moment and
// never after the free path ran. `J tenjin ask-done yes|no` clears it for the session. An unattended turn never asks: its
// free path runs and the hint goes in the report.
export const askDue = (state, { unattended = false } = {}) => tenjinAsk(state, { unattended });
export function askFirst(state, moment, { unattended = false } = {}) {
  if (!askDue(state, { unattended })) return null;
  const hint = tenjinHint(state, moment);
  if (!hint) return null;
  return { ask: 'tenjin', moment, hint, question: tenjinAskQuestion({ line: tenjinOffer(moment, state), status: state.tenjin.status }), next: 'ask it with the question tool, then J tenjin ask-done yes|no' };
}
// On a yes the moment holds as `tenjin_setup` for this period, until `J tenjin` says ready; then it runs through the router.
export const setupActive = (state, profile, now = Date.now()) => {
  const r = state.tenjinSetup;
  return Boolean(r && (state.tenjin || {}).status !== 'ready' && r.period === periodStart(now, frequencyOf(profile)));
};

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
  const holdSetup = setupActive(state, profile, now);
  if (searchDue(state, profile, now, opts) && !holdSetup && !itemStillLeft(state, 'search', profile, now)) {
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
    // A page the skill opens for the person: "Just open the pages", and the fallback in every stronger mode for a job it must not
    // or cannot fill (a deny-listed host, a login, a bot check). Pages open only in an attended turn.
    const openUrl = openUrlOf(j, profile);
    if (openUrl && !j.openedAt && ['reviewed', 'shortlisted', 'prepared', 'apply_ready'].includes(j.status)) {
      items.push({ key: j.key, reason: 'open_ready', title: j.title, company: j.company, url: openUrl, gate: GATES.open_ready });
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
    if (!holdSetup && j.status === 'reviewed' && !j.employerPosting && !j.careersChecked && ['no_board', 'unconfirmed_board', 'no_match', 'no_apply_link', 'yc_platform_only'].includes(j.unresolved) && inPeriodSet(state, j, profile, overlay, now)) {
      items.push({ key: j.key, reason: 'employer_page', title: j.title, company: j.company, website: j.employerWebsite || null, careersUrl: j.careersUrl || null, gate: GATES.employer_page });
      continue;
    }
    // A job confirmed from the employer's careers page (a system with no board API) is open while that page lists it: the
    // re-verify reads the page again once the last check is a day old.
    if (!holdSetup && ['reviewed', 'shortlisted', 'prepared', 'apply_ready'].includes(j.status) && j.employerPosting && !j.employerPosting.token && j.employerPosting.source === 'careers_page' && (!j.verifiedAt || now - Date.parse(j.verifiedAt) > graph().unattendedWindow.verifiedHours * HOUR)) {
      items.push({ key: j.key, reason: 'employer_page', title: j.title, company: j.company, website: j.employerWebsite || null, reverify: true, careersUrl: j.employerPosting.url, gate: GATES.employer_page });
      continue;
    }
    // A job the person applies to on LinkedIn: show its link and the prepared answers, then ask once whether they applied.
    if (j.linkedinUrl && applyPathOf(j, profile) === 'linkedin' && ['reviewed', 'shortlisted', 'prepared', 'apply_ready', 'submitted'].includes(j.status)) {
      if (j.status === 'submitted') { /* applied: nothing more */ }
      else if (!j.linkedinShownAt && (j.sheet || !j.employerPosting)) { add(j, 'linkedin_ready'); continue; }
      else if (j.linkedinShownAt && j.linkedinAskedV !== itemVersion(j)) { add(j, 'linkedin_applied'); continue; }
      else if (j.linkedinShownAt) continue;
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
  const mail = pendingEmails(state);
  if (mail.length) items.push({ key: 'email', reason: 'email_due', title: `${mail.length} intro email${mail.length > 1 ? 's' : ''} to published addresses`, company: '', gate: GATES.email_due, count: mail.length });
  for (const key of state.contactsRequested || []) {
    const cj = state.jobs[key];
    if (!cj || (state.contacts[key] || []).length || itemStillLeft(state, `contacts:${key}`, profile, now)) continue;
    items.push({ key, leaveKey: `contacts:${key}`, reason: 'contacts_requested', title: cj.title, company: cj.company, gate: GATES.contacts_requested });
  }
  for (const i of items) {
    const job = state.jobs[i.key];
    i.v = i.reason === 'email_due' ? sha(canonical(pendingEmails(state).map((c) => c.id))).slice(0, 10) : i.reason === 'web_search_due' ? `${state.search.webPending.round}:${state.search.webPending.at}` : i.reason === 'need_due' ? (() => { const n = state.search.needPending.find((x) => `need:${x.kind}` === i.key); return `${n.round}:${n.at}`; })() : job ? itemVersion(job) : i.reason === 'search_due' ? `${(state.search.session || {}).round ?? 'new'}:${state.routed.lastSearchAt}` : String(i.posts ? i.posts.length : 0);
    { const ep = (state.claimEpochs || {})[ckey(i)]; if (ep) i.v = `${i.v}~${ep}`; } // a timed-out claim on a still-open item: one more wake
    i.waitsForPerson = waitsForPerson(state, profile, i, overlay);
  }
  for (const i of items) {
    if (i.reason === 'employer_page') {
      i.hint = tenjinHint(state, 'employer_posting');
      // the ask comes in place of the free path's task text (attended, Tenjin not ready, the session's ask unanswered)
      const a = askFirst(state, 'employer_posting', { unattended: opts.unattended === true || unattendedBatchOpen() });
      if (a) { i.ask = { ask: a.ask, moment: a.moment, hint: a.hint }; delete i.gate; }
    }
    if (i.reason === 'contacts_requested') i.hint = tenjinHint(state, 'contacts');
  }
  // Positions per period (attended): the sheets brought for the person's yes. A sheet already brought stays; new ones
  // come best fit first until the period's count is reached. The rest stay ranked for the next period, none dropped.
  const limit = periodLimit(overlay, { profile, now });
  const bring = [];
  let heldForPeriod = 0;
  if (limit !== null) {
    const start = periodStart(now, frequencyOf(profile));
    const brought = Object.values(state.jobs).filter((j) => j.broughtAt && Date.parse(j.broughtAt) >= start).length;
    let room = Math.max(0, limit - brought);
    const fresh = items.filter((i) => (i.reason === 'apply_ready' || i.reason === 'linkedin_ready' || i.reason === 'open_ready') && !state.jobs[i.key].broughtAt).sort((a, b) => (state.jobs[b.key].fit ?? -1) - (state.jobs[a.key].fit ?? -1));
    const allowed = new Set(fresh.slice(0, room).map((i) => i.key));
    for (const i of fresh) if (!allowed.has(i.key)) heldForPeriod++;
    for (let k = items.length - 1; k >= 0; k--) if ((items[k].reason === 'apply_ready' || items[k].reason === 'linkedin_ready' || items[k].reason === 'open_ready') && !state.jobs[items[k].key].broughtAt && !allowed.has(items[k].key)) items.splice(k, 1);
    bring.push(...allowed);
  } else bring.push(...items.filter((i) => (i.reason === 'apply_ready' || i.reason === 'linkedin_ready' || i.reason === 'open_ready') && !state.jobs[i.key].broughtAt).map((i) => i.key));
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
// An item shown to the person in an attended turn (the report, an approval question, a reply) is marked with its signature,
// and leaves the notify set until the item changes: a push never repeats what the person was just shown.
export function waitingSet(state) {
  const raw = waitingSetRaw(state);
  const w = {};
  for (const [k, v] of Object.entries(raw)) if ((state.shown || {})[k] !== v) w[k] = v;
  return w;
}
export function markShown(state, keys = null) {
  const raw = waitingSetRaw(state);
  const next = {};
  for (const [k, v] of Object.entries(state.shown || {})) if (raw[k] === v) next[k] = v; // a changed or gone item is not shown any more
  for (const [k, v] of Object.entries(raw)) if (!keys || keys.some((x) => k === x || k.endsWith(`:${x}`))) next[k] = v;
  state.shown = next;
  return Object.keys(next).length;
}
export function waitingSetRaw(state) {
  const w = {};
  const mode = readJson(path.join(stateDir(), 'profile.json'), {}).applyMode; // a fill needs no yes, and nothing is submitted in fill_only or open_only
  for (const j of Object.values(state.jobs)) {
    if (graph().terminal.includes(j.status)) continue;
    if (j.fillReady) w[`fill:${j.key}`] = `${j.fillReady.at}|${j.company}`;
    else if (j.parked) w[`park:${j.key}`] = `${j.parked.key}|${j.parked.reasons.join(',')}|${j.company}`;
    else if (j.status === 'apply_ready' && !state.approvals[j.key] && j.employerPosting && !j.fillOnly && !['fill_only', 'open_only'].includes(mode)) w[`yes:${j.key}`] = `${j.hash}|${j.company}`;
  }
  const mail = pendingEmails(state);
  if (mail.length) w[`email:${mail.length}`] = sha(canonical(mail.map((c) => c.id))).slice(0, 10);
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
  const mails = fresh.filter((k) => k.startsWith('email:'));
  const stops = fresh.filter((k) => k.startsWith('park:'));
  const held = fresh.filter((k) => k.startsWith('held:')).map((k) => k.split(':')[1]);
  const consents = fresh.filter((k) => k.startsWith('consent:'));
  const updates = fresh.filter((k) => k.startsWith('update:'));
  const parts = [];
  if (filled) parts.push(`${filled} filled, waiting for your submit (fill ready)`);
  if (yes) parts.push(`${yes} application${yes > 1 ? 's' : ''} wait for your yes`);
  if (mails.length) parts.push(`${mails[0].slice(6)} intro email draft${mails[0].slice(6) === '1' ? '' : 's'} to ${emailConsentCurrent(state, {}, overlay) ? 'send' : 'approve'}`);
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
      claimItems(state, wl.items, now); // handed to the model: in flight, so the watcher does not wake it for them
    }
    return wl;
  };
  res = commit ? updateState(compute) : compute(loadState());
  res.empty = res.items.length === 0;
  if (staleBatchClosed) res.staleBatchClosed = true;
  return res;
}
