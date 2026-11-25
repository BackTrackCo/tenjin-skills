import { notifyLine, plannedJobs, stillLeft, tenjinHint } from './work.mjs';
import { dmLink, handleIn, mailto, pending as pendingEmails, emailState } from './email.mjs';

export const REASONS = {
  no_apply_link: 'no apply link in the posting',
  no_board: 'no board of the employer was found',
  no_match: 'the employer board has no matching job',
  unconfirmed_board: 'only a board that may not be the employer\'s was found',
  multiple_matches: 'more than one job on the board matches',
  no_careers_page: 'no careers page on the employer\'s own site lists the job',
  sign_in_wall: 'the careers page needs a sign-in',
  yc_platform_only: 'a Y Combinator job with no other posting; apply at the Work at a Startup link',
};

// An intro is a draft. An email to an address the poster published goes through the Gmail connector after the person's yes
// (J email); any other email shows a mailto link; an X DM is sent by the person: code gives the profile link and the text.
function introNote(intro, handle, email, published) {
  const text = intro.text.replace(/\n/g, ' ');
  if (handle) {
    const d = dmLink(handle, text);
    return `Intro to copy (x). Open ${d.profile}, press Message, paste, and send it yourself: ${text}`;
  }
  if (email) return `Intro (email${intro.subject ? `, subject: ${intro.subject}` : ''}) ${published ? 'to an address the poster published: it goes from your Gmail only with your yes' : 'you send yourself'}: ${text} ${mailto({ to: email, subject: intro.subject || '', text: intro.text })}`;
  return `Intro to copy (${intro.channel}${intro.subject ? `, subject: ${intro.subject}` : ''}), you send it yourself: ${text}`;
}

// A rule's value in words. The object form of period_max reads "100 now, then 10 a day".
export function ruleText(r) {
  const v = r.value;
  if (v === null || v === undefined) return r.effect;
  if (r.effect === 'period_max' && typeof v === 'object') {
    const day = v.perDay === 'none' || v.perDay === undefined || v.perDay === null ? 'no daily limit' : `${v.perDay} a day`;
    return `${r.effect}: ${Number.isInteger(v.catchUp) ? `${v.catchUp} now, then ${day}` : day}`;
  }
  return `${r.effect} ${typeof v === 'object' ? JSON.stringify(v) : v}`;
}
// What the wake log counts: items handled, in words ("13 new jobs"), apart from the number of wakes.
const REASON_WORDS = { new_job: 'new job', employer_page: 'employer page', search_due: 'search', post_review: 'post review', review_due: 'review', prepare_due: 'prepare', apply_ready: 'application', contacts_requested: 'contacts request', web_search_due: 'web search', need_due: 'search need', email_due: 'email batch' };
export const itemWords = (reason, n) => { const w = REASON_WORDS[reason] || reason.replace(/_due$/, '').replace(/_/g, ' '); return `${n} ${w}${n > 1 ? 's' : ''}`; };

export const CONTACTS_LINE = 'Contacts: I can find someone to write to for the jobs above (a hiring manager, team lead or founder); messages are drafts you send.';
export const ALL_LINE = 'That is the short report. `J report --all`, or ask for the full report, shows everything else.';
const placeOf = (j) => [j.city, j.region].filter(Boolean).join(', ') || (j.remote ? 'remote' : '');
const PERSON_HELD = ['chrome_disconnected', 'no_chrome_tools', 'update_waiting', 'update_failed', 'stopped'];

// The short report (the default): one count line, the jobs the skill plans to apply to, and only the questions and approvals
// that need the person now. Everything else is behind `J report --all`.
function renderShort(state, overlay, { since, now, profile }) {
  const jobs = Object.values(state.jobs);
  const L = [`# Job Search report, ${new Date(now).toISOString().slice(0, 10)}`, ''];
  if (profile.search && profile.search.role) {
    const sr = profile.search;
    L.push(`Searched for ${sr.role}${sr.place ? ` in ${sr.place}${sr.remote ? ' and remote' : ''}` : sr.remote ? ', remote' : ''}.`, '');
  }
  const fresh = jobs.filter((j) => j.status === 'new' || j.status === 'reviewed').filter((j) => !since || Date.parse(j.firstSeen) >= Date.parse(since));
  const planned = plannedJobs(state, profile, overlay, now);
  const done = jobs.filter((j) => ['submitted', 'confirmed', 'interview', 'offer'].includes(j.status));
  const mine = jobs.filter((j) => !j.employerPosting && j.unresolved && !['skipped', 'closed'].includes(j.status));
  const best = [...new Set(mine.filter((j) => typeof j.fit === 'number').sort((a, b) => b.fit - a.fit).map((j) => j.company))].slice(0, 3);
  const leads = (state.leads || []).filter((l) => l.status === 'new' && !l.joinedJob).length;
  L.push(`${fresh.length} new job${fresh.length === 1 ? '' : 's'}; ${planned.length} planned to apply to${done.length ? `, ${done.length} submitted` : ''}; ${mine.length} for you to apply to yourself${best.length ? ` (best you can apply to yourself: ${best.join(', ')})` : ''}${leads ? `; ${leads} ${leads === 1 ? 'person' : 'people'} hiring` : ''}.`);
  const stateOf = (j) => (j.status === 'apply_ready' ? (state.approvals[j.key] ? 'approved, applying next' : 'waiting for your yes') : j.status === 'prepared' ? (j.awaitingApproval ? 'prepared, needs your answers' : 'prepared') : 'being prepared');
  if (planned.length || done.length) {
    L.push('', `## Planned to apply to (${planned.length + done.length})`);
    for (const j of planned) L.push(`- ${j.fit ?? '?'} | ${j.title}, ${j.company}${placeOf(j) ? `, ${placeOf(j)}` : ''}${j.salary ? ` | pay: ${j.salary}` : ''}${(j.warnings || []).length ? ` | warnings: ${j.warnings.join('; ')}` : ''} | ${stateOf(j)}`);
    for (const j of done) L.push(`- ${j.fit ?? '?'} | ${j.title}, ${j.company} | ${j.status}`);
  }
  const readyYes = jobs.filter((j) => ((j.status === 'apply_ready' && j.sheet) || (j.status === 'prepared' && j.awaitingApproval)) && j.employerPosting && !state.approvals[j.key]).sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1));
  if (readyYes.length) {
    L.push('', `## Need your yes (${readyYes.length})`);
    for (const j of readyYes) {
      L.push(`- ${j.company}, ${j.title}${j.awaitingApproval ? `: also needs ${(j.missingFacts || []).map((f) => f.replace(/_/g, ' ')).join(', ')}` : ''}`);
      for (const f of ((j.sheet && j.sheet.fields) || []).filter((x) => x.tag === 'new_writing')) L.push(`  - new answer, "${f.label}": ${String(f.value).replace(/\n/g, ' ')}`);
    }
  }
  const filled = jobs.filter((j) => j.fillReady);
  if (filled.length) { L.push('', `## Filled, waiting for your submit (${filled.length})`); for (const j of filled) L.push(`- ${j.title}, ${j.company}: the form is filled in an open tab. Check it, press submit, and tell me.`); }
  const stuck = jobs.filter((j) => j.parked);
  if (stuck.length) {
    L.push('', '## Waiting on you');
    for (const j of stuck) {
      L.push(`- ${j.company}, ${j.title}: ${j.parked.reasons.join(', ')}`);
      if (j.parked.reasons.includes('writing_needs_yes')) for (const f of ((j.sheet && j.sheet.fields) || []).filter((x) => x.tag === 'new_writing')) L.push(`  - draft for "${f.label}": ${String(f.value).replace(/\n/g, ' ')}`);
    }
  }
  const held = state.held.filter((h) => PERSON_HELD.includes(h.reason));
  if (held.length) { L.push('', '## Needs you'); for (const h of held) L.push(`- ${h.reason.replace(/_/g, ' ')}${h.detail ? `: ${h.detail}` : ''}`); }
  const mail = pendingEmails(state);
  if (mail.length) L.push('', `${mail.length} intro email draft${mail.length > 1 ? 's' : ''} wait${mail.length > 1 ? '' : 's'} for your yes (addresses the posters published; none goes without it).`);
  const consent = (state.consentLog || []).filter((c) => !c.acked);
  if (consent.length) { L.push('', '## Consent changes (check that each one was yours)'); for (const c of consent) L.push(`- ${c.at.slice(0, 16).replace('T', ' ')}: ${c.what}.`); }
  if (planned.length) L.push('', CONTACTS_LINE);
  L.push('', ALL_LINE);
  return L.join('\n');
}

// The first application on a host shows once in the full report, so a maintainer can look at a new site's terms. Never a check
// that blocks anything: the default is to apply.
export function firstApplicationHosts(state) {
  const seen = new Set(state.hostsReported || []);
  const out = [];
  for (const a of state.applications || []) {
    const j = state.jobs[a.key];
    let host = null;
    try { host = j && j.employerPosting ? new URL(j.employerPosting.url).hostname.toLowerCase() : null; } catch {}
    if (host && !seen.has(host) && !out.some((o) => o.host === host)) out.push({ host, title: j.title, company: j.company });
  }
  return out;
}

// The report is rendered from state and the overlay, never written by the model.
export function renderReport(state, overlay, { since = null, now = Date.now(), profile = null, short = false } = {}) {
  if (short) return renderShort(state, overlay, { since, now, profile: profile || {} });
  const jobs = Object.values(state.jobs);
  const fresh = jobs.filter((j) => j.status === 'new' || j.status === 'reviewed').filter((j) => !since || Date.parse(j.firstSeen) >= Date.parse(since));
  fresh.sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1));
  const L = [];
  L.push(`# Job Search report, ${new Date(now).toISOString().slice(0, 10)}`);
  L.push('');
  // What was searched, and where it came from, so a wrong reading of the resume is seen at once.
  if (profile && profile.search && profile.search.role) {
    const sr = profile.search;
    const src = (k) => (sr.sources && sr.sources[k]) || 'person';
    const words = (sr.roleWords || []).length ? ` (${sr.roleWords.join(', ')})` : '';
    const place = sr.place ? ` in ${sr.place}${sr.remote ? ' and remote' : ''}` : sr.remote ? ', remote' : '';
    L.push(`Searched for ${sr.role}${words}${place}, from ${src('role') === 'resume' ? 'your resume' : 'what you told me'}; tell me to change it.`, '');
  }
  L.push(`## New jobs (${fresh.length})`);
  for (const j of fresh.slice(0, 20)) L.push(`- ${j.fit ?? '?'} | ${j.title}, ${j.company}, ${[j.city, j.region].filter(Boolean).join(', ') || (j.remote ? 'remote' : '')}${j.salary ? ` | pay: ${j.salary}` : ''}${j.fitLine ? ` | ${j.fitLine}` : ''}${(j.warnings || []).length ? ` | warnings: ${j.warnings.join('; ')}` : ''} | ${j.url}`);
  if (fresh.length > 20) L.push(`- and ${fresh.length - 20} more`);
  const okEp = (j) => j.employerPosting && ['exact', 'confirmed'].includes(j.employerPosting.confidence);
  const ready = jobs.filter((j) => ['reviewed', 'shortlisted', 'prepared', 'apply_ready'].includes(j.status) && okEp(j));
  const waiting = jobs.filter((j) => j.status === 'new' && !j.unresolved);
  L.push('', `${ready.length} reviewed jobs have an employer posting ready to apply on (${[...new Set(ready.map((j) => j.board).filter(Boolean))].join(', ') || 'no board yet'}); ${waiting.length} new jobs still wait for review.`);
  const dc = (state.lastSweep && state.lastSweep.dropCounts) || {};
  if (Object.keys(dc).length) L.push(`Dropped by code in the last sweep: ${Object.entries(dc).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')}.`);
  const dropped = jobs.filter((j) => j.status === 'skipped' && j.skipReason && (!since || Date.parse(j.statusAt || 0) >= Date.parse(since)));
  if (dropped.length) {
    L.push('', `## Dropped in review (${dropped.length})`);
    for (const j of dropped) L.push(`- ${j.title}, ${j.company}: ${j.skipReason}`);
  }
  const leftAlone = jobs.filter((j) => j.left && stillLeft(state, j, overlay, profile || {}) && !['skipped', 'closed'].includes(j.status));
  if (leftAlone.length) {
    L.push('', `## Left alone (${leftAlone.length}): not due work until there is news about the job, an answer from you, or a rule that affects it`);
    for (const j of leftAlone.slice(-40)) L.push(`- ${j.title}, ${j.company}: ${j.left.reason}`);
  }
  const leftItems = Object.entries(state.leftItems || {});
  if (leftItems.length) L.push('', `Left until the next period or news (${leftItems.length}): ${leftItems.map(([k, v]) => `${k} (${v.reason})`).join(', ')}`);
  const found = jobs.filter((j) => j.employerPosting && j.employerPosting.source !== 'apply_link');
  L.push('', `## Found on the employer's site (${found.length})`);
  for (const j of found) L.push(`- ${j.title}, ${j.company}: ${j.employerPosting.url} (${j.employerPosting.source}, ${j.employerPosting.confidence})`);
  const unresolved = jobs.filter((j) => !j.employerPosting && j.unresolved && !['skipped', 'closed'].includes(j.status));
  const onSite = unresolved.filter((j) => j.otherSystem);
  L.push('', `## Apply on the employer's site (${onSite.length})`);
  for (const j of onSite) L.push(`- ${j.title}, ${j.company}: ${j.otherSystem.url} (${j.otherSystem.system}; that site's terms ban automated use)`);
  const ay = unresolved.filter((j) => !j.otherSystem);
  L.push('', `## Apply yourself (${ay.length})`);
  for (const j of ay.slice(-20)) {
    const links = j.workAtStartupUrl ? [j.workAtStartupUrl] : (j.applyLinks || [j.url]).filter((u) => typeof u === 'string');
    L.push(`- ${j.title}, ${j.company}: ${REASONS[j.unresolved] || j.unresolved}. ${links.join(' | ')}`);
  }
  const firstHosts = firstApplicationHosts(state);
  if (firstHosts.length) {
    L.push('', `## First application on a new site (${firstHosts.length})`);
    for (const h of firstHosts) L.push(`- first application on ${h.host}: ${h.title}, ${h.company}`);
  }
  const readyYes = jobs.filter((j) => j.status === 'apply_ready' && j.sheet && j.employerPosting && !state.approvals[j.key]).sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1));
  if (readyYes.length) {
    L.push('', `## Ready for your yes (${readyYes.length})`);
    for (const j of readyYes) {
      L.push(`- ${j.fit ?? '?'} | ${j.company}, ${j.title}${j.fitLine ? ` | ${j.fitLine}` : ''}`);
      for (const f of (j.sheet.fields || []).filter((x) => x.tag === 'new_writing')) L.push(`  - new answer, "${f.label}": ${String(f.value).replace(/\n/g, ' ')}`);
    }
  }
  const filled = jobs.filter((j) => j.fillReady);
  L.push('', `## Filled, waiting for your submit (${filled.length})`);
  for (const j of filled) L.push(`- ${j.title}, ${j.company}: the form is filled in an open tab. Check it, press submit, and tell me.`);
  const held = state.held.filter((h) => h.reason === 'source_empty');
  L.push('', '## Sources held this run');
  if (held.length) for (const h of held) L.push(`- ${h.detail}`);
  else L.push('- none');
  if (state.held.some((h) => h.reason === 'tenjin_setup')) L.push('', '## Waiting for Tenjin', '- The round runs through the router once Tenjin is ready; until then it is held for this period.');
  const noTenjin = state.held.find((h) => h.reason === 'tenjin_missing');
  const skip = noTenjin ? `no Tenjin (${noTenjin.detail})` : state.routed && state.routed.skipReason;
  if (skip) L.push('', `## The routed search did not run`, `- ${skip}. The watched boards still ran.`);
  const w = state.watched;
  L.push('', `## Watched boards checked: ${w ? `${w.ok} of ${w.checked} answered` : 'none yet'}`);
  L.push('', `Cost the router reported: ${(state.routed && state.routed.lastCost) || 'none reported'}`);
  const newRules = (overlay.rules || []).filter((r) => !since || r.date >= since.slice(0, 10));
  if (newRules.length) {
    L.push('', '## Rules (your words)');
    for (const r of newRules) L.push(`- ${r.date}: "${r.words}" (${ruleText(r)}) id ${r.id}`);
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
  const stuck = jobs.filter((j) => j.parked || (j.status === 'apply_ready' && !state.approvals[j.key]));
  if (stuck.length) {
    L.push('', '## Waiting on you');
    for (const j of stuck) {
      L.push(`- ${j.company}, ${j.title}: ${j.parked ? j.parked.reasons.join(', ') : 'needs your yes'}`);
      // a draft held for the person's yes is shown in full: only the submit waits, the answer is already written
      if (j.parked && j.parked.reasons.includes('writing_needs_yes')) for (const f of ((j.sheet && j.sheet.fields) || []).filter((x) => x.tag === 'new_writing')) L.push(`  - draft for "${f.label}": ${String(f.value).replace(/\n/g, ' ')}`);
    }
  }
  const leads = (state.leads || []).filter((l) => l.status === 'new' && !l.joinedJob);
  if (leads.length) {
    L.push('', `## People hiring (${leads.length})`);
    for (const l of leads) L.push(`- ${l.author || l.handle || l.email}${l.employer ? `, ${l.employer}` : ''}${l.role ? `, ${l.role}` : ''}: ${l.url}${l.intro ? `. ${introNote(l.intro, l.channel === 'x' ? l.handle : null, l.channel === 'email' ? l.email : null, l.emailFromPost)}${l.channel === 'email' && l.source === 'x' && l.handle ? ` DM link, if you prefer to write there: ${dmLink(l.handle, '').profile}` : ''}` : ''}`);
  }
  const mail = pendingEmails(state);
  if (mail.length) L.push('', `${mail.length} intro email draft${mail.length > 1 ? 's' : ''} wait${mail.length > 1 ? '' : 's'} for your yes (addresses the posters published; none goes without it).`);
  const sentMail = (emailState(state).log || []).filter((m) => now - Date.parse(m.at) < 86400000);
  if (sentMail.length) L.push('', `Emails in the last day: ${sentMail.map((m) => `${m.how} to ${m.to}`).join('; ')}.`);
  const oc = state.postOutcomes || {};
  const skipped = ['not_hiring', 'no_fit'].filter((k) => oc[k]);
  if (skipped.length) L.push('', `Hiring posts set aside: ${skipped.map((k) => `${oc[k]} ${k.replace('_', ' ')}${k === 'not_hiring' && (state.postReasons || {}).unreadable ? ` (${state.postReasons.unreadable} unreadable)` : ''}`).join(', ')}.`);
  const today = (state.wakes || []).filter((w) => now - Date.parse(w.at) < 86400000);
  if (today.length) {
    const sum = {};
    for (const w of today) for (const [k, n] of Object.entries(w.counts)) sum[k] = (sum[k] || 0) + n;
    L.push('', `Model wakes in the last day: ${today.length}${Object.keys(sum).length ? ` (items handled: ${Object.entries(sum).map(([k, n]) => itemWords(k, n)).join(', ')})` : ''}.`);
  }
  const ran = (state.runs || []).filter((r) => now - Date.parse(r.at) < 86400000);
  if (ran.length) {
    const by = {};
    for (const r of ran) by[r.kind] = (by[r.kind] || 0) + 1;
    L.push('', `Subagent runs in the last day: ${ran.length} (${Object.entries(by).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')}).`);
  }
  const consent = (state.consentLog || []).filter((c) => !c.acked);
  if (consent.length) {
    L.push('', '## Consent changes (check that each one was yours)');
    for (const c of consent) L.push(`- ${c.at.slice(0, 16).replace('T', ' ')}: ${c.what}. Say so if this was not you; \`consent revoke\` undoes it.`);
  }
  if ((state.dropLines || []).length) L.push('', ...state.dropLines.map((d) => d));
  const hints = ['employer_posting'].map((m) => tenjinHint(state, m)).filter(Boolean);
  const stuckNoPosting = jobs.filter((j) => !j.employerPosting && j.unresolved && !['skipped', 'closed'].includes(j.status)).length;
  if (hints.length && stuckNoPosting) L.push('', hints[0].line);
  const withContacts = jobs.filter((j) => (state.contacts[j.key] || []).length);
  if (withContacts.length) {
    L.push('', '## Contacts');
    for (const j of withContacts) {
      L.push(`- ${j.title}, ${j.company}`);
      for (const c of state.contacts[j.key]) {
        L.push(`  - ${c.name}${c.title ? `, ${c.title}` : ''}${c.notConfirmed ? ' (not confirmed)' : ''}: ${c.how}. Cares about: ${c.cares}. ${c.sourceUrl}`);
        if (c.intro) L.push(`    ${introNote(c.intro, c.channel === 'x' ? handleIn(c.how) : null, c.channel === 'email' ? c.email || c.how : null, c.emailFromPost)}`);
      }
    }
  }
  if ((state.found || []).length && !state.watchTipShown) L.push('', 'Tip: you can paste a company\'s careers link and I will watch it directly.');
  if (plannedJobs(state, profile || {}, overlay, now).length) L.push('', CONTACTS_LINE);
  return L.join('\n');
}

export { notifyLine };
