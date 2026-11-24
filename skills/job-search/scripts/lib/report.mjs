import { notifyLine, stillLeft, tenjinHint } from './work.mjs';

export const REASONS = {
  no_apply_link: 'no apply link in the posting',
  no_board: 'no board of the employer was found',
  no_match: 'the employer board has no matching job',
  unconfirmed_board: 'only a board that may not be the employer\'s was found',
  multiple_matches: 'more than one job on the board matches',
  no_careers_page: 'no careers page with a known board was found',
  sign_in_wall: 'the careers page needs a sign-in',
  yc_platform_only: 'a Y Combinator job with no other posting; apply at the Work at a Startup link',
};

// The report is rendered from state and the overlay, never written by the model.
export function renderReport(state, overlay, { since = null, now = Date.now(), profile = null } = {}) {
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
  const found = jobs.filter((j) => j.employerPosting && j.employerPosting.source !== 'apply_link');
  L.push('', `## Found on the employer's site (${found.length})`);
  for (const j of found) L.push(`- ${j.title}, ${j.company}: ${j.employerPosting.url} (${j.employerPosting.source}, ${j.employerPosting.confidence})`);
  const unresolved = jobs.filter((j) => !j.employerPosting && j.unresolved && !['skipped', 'closed'].includes(j.status));
  const onSite = unresolved.filter((j) => j.otherSystem);
  L.push('', `## Apply on the employer's site (${onSite.length})`);
  for (const j of onSite) L.push(`- ${j.title}, ${j.company}: ${j.otherSystem.url} (${j.otherSystem.system}; this skill does not fill that system)`);
  const ay = unresolved.filter((j) => !j.otherSystem);
  L.push('', `## Apply yourself (${ay.length})`);
  for (const j of ay.slice(-20)) {
    const links = j.workAtStartupUrl ? [j.workAtStartupUrl] : (j.applyLinks || [j.url]).filter((u) => typeof u === 'string');
    L.push(`- ${j.title}, ${j.company}: ${REASONS[j.unresolved] || j.unresolved}. ${links.join(' | ')}`);
  }
  const filled = jobs.filter((j) => j.fillReady);
  L.push('', `## Filled, waiting for your submit (${filled.length})`);
  for (const j of filled) L.push(`- ${j.title}, ${j.company}: the form is filled in an open tab. Check it, press submit, and tell me.`);
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
  const stuck = jobs.filter((j) => j.parked || (j.status === 'apply_ready' && !state.approvals[j.key]));
  if (stuck.length) {
    L.push('', '## Waiting on you');
    for (const j of stuck) L.push(`- ${j.company}, ${j.title}: ${j.parked ? j.parked.reasons.join(', ') : 'needs your yes'}`);
  }
  const leads = (state.leads || []).filter((l) => l.status === 'new' && !l.joinedJob);
  if (leads.length) {
    L.push('', `## People hiring (${leads.length})`);
    for (const l of leads) L.push(`- ${l.author || l.handle || l.email}${l.employer ? `, ${l.employer}` : ''}${l.role ? `, ${l.role}` : ''}: ${l.url}${l.intro ? `. Intro to copy (${l.intro.channel}${l.intro.subject ? `, subject: ${l.intro.subject}` : ''}), you send it yourself: ${l.intro.text.replace(/\n/g, ' ')}` : ''}`);
  }
  const oc = state.postOutcomes || {};
  const skipped = ['not_hiring', 'no_fit'].filter((k) => oc[k]);
  if (skipped.length) L.push('', `Hiring posts set aside: ${skipped.map((k) => `${oc[k]} ${k.replace('_', ' ')}`).join(', ')}.`);
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
        if (c.intro) L.push(`    Example intro via ${c.intro.channel}${c.intro.subject ? ` (subject: ${c.intro.subject})` : ''}, a draft you send yourself: ${c.intro.text.replace(/\n/g, ' ')}`);
      }
    }
  }
  if ((state.found || []).length && !state.watchTipShown) L.push('', 'Tip: you can paste a company\'s careers link and I will watch it directly.');
  L.push('', 'Want contacts (a hiring manager, team lead or founder) for some of these? Say for how many jobs; 5 if you do not say. Messages are drafts; you send them.');
  return L.join('\n');
}

export { notifyLine };
