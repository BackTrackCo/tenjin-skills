// The questions, as data for Claude Code's question tool (AskUserQuestion). In an attended turn, every question that has
// choices goes through it, never as a list in prose: 1 to 4 questions per call, 2 to 4 options each, a short label and a
// one-line description, the default first and labelled "(Recommended)" (or "(from your resume)" for a resume guess).
// The tool adds its own free-text answer; no question or option text names it. A choice is only for a question whose options
// usually hold the answer: a typed answer (a place, a phone, pay, an address, a name) is a plain question, `{plain}`, with the
// guess in its text. Never in an unattended turn: nobody can answer there.
import { graph } from './graph.mjs';
import { fmt } from './prices.mjs';
const q = (header, question, options, multiSelect = false) => ({ header, question, multiSelect, options });

// Options that need Claude in Chrome get a note when it is off in this session (`J chrome set off`), and the question says so
// once. The pick is still recorded.
export const CHROME_NOTE = 'Needs Claude in Chrome, which is off in this session.';
export const CHROME_SENTENCE = 'Claude in Chrome is off in this session; options marked need it.';
const needing = (label, set) => set.some((p) => label.startsWith(p));
export function chromeQ(header, question, options, { chromeOff = false, needs = [], multiSelect = false } = {}) {
  const noted = chromeOff && options.some((o) => needing(o.label, needs));
  return q(header, noted ? `${question} ${CHROME_SENTENCE}` : question, options.map((o) => (chromeOff && needing(o.label, needs) ? { ...o, description: `${o.description} ${CHROME_NOTE}` } : o)), multiSelect);
}
const plain = (text) => ({ plain: text });

// The start, after the resume: one call, four questions. Remote Control is a reminder line, not a question.
const RC_FIRST = 'Type /rc to get these notifications on your phone and answer from the Claude app while this session keeps running here.';
const ACTIONS = '"Push when actions required"';
const DECIDES = '"Push when Claude decides"';
// The /config sentence names only the settings that are not known to be on (`on`: true, false or null for unknown).
export function configSentence({ input = null, agent = null } = {}) {
  const need = [input === true ? null : ACTIONS, agent === true ? null : DECIDES].filter(Boolean);
  if (!need.length) return null;
  const why = need.length === 2 ? 'questions and updates' : need[0] === ACTIONS ? 'questions' : 'updates';
  return `Then open /config and turn on ${need.join(' and ')}, so ${why} reach your phone.`;
}
// Built from what is known (the two push settings read from Claude Code's config by pushSettings(), Remote Control as the model
// recorded it, and whether a push was ever sent), never a question, at most once per start. The /rc sentence only while Remote
// Control is unknown and no push was sent; the /config sentence only for a setting that is off or unknown; none with both on and
// Remote Control on. A sent push proves Remote Control and "Push when Claude decides" are on, whatever the file says.
export function rcReminder({ rc = 'unknown', pushSent = false, settings = {} } = {}) {
  const known = { input: settings.input ?? null, agent: pushSent ? true : settings.agent ?? null };
  const first = rc !== 'on' && !pushSent ? RC_FIRST : null;
  const second = configSentence(known);
  return [first, second].filter(Boolean).join(' ') || null;
}
// What to say at a push that came back "not sent", once: off (the push setting is off) the /config sentence, from the file as
// the file as it stands, with "Push when Claude decides" named since the push says it is off; none (no transport) both sentences; present
// (the person is at the terminal) nothing.
export const rcAtPush = (reason, settings = {}) => (reason === 'off' ? configSentence({ input: settings.input ?? null, agent: false }) : reason === 'none' ? `${RC_FIRST} ${configSentence({ input: settings.input ?? null, agent: false })}` : null);

export function startQuestions({ chromeOff = false, rc = 'unknown', pushSent = false, settings = {} } = {}) {
  return {
    questions: [
      chromeQ('Apply mode', 'How should applications go out?', [
        { label: 'Ask me each time (Recommended)', description: 'I prepare each application, show it, and submit only after your yes.' },
        { label: 'Auto apply', description: 'I submit without asking, from your resume and answers you gave or approved before; the next question says how new answers are handled.' },
        { label: 'Fill only, I submit', description: 'I fill each application form and stop before submit; you check it and press submit.' },
        { label: 'Just open the pages', description: 'I prepare each application and open its page in your browser; you fill and submit it.' },
      ], { chromeOff, needs: ['Ask me each time', 'Auto apply', 'Fill only'] }),
      q('Search', 'How often should I search for jobs?', [
        { label: 'Every day (Recommended)', description: 'One search round a day. With Tenjin a round runs in code at the router\'s price, with no Claude usage for the searches; without it, a round is one Haiku run (usage not measured yet).' },
        { label: 'Twice a day', description: 'Two search rounds a day, about twice the router price (with Tenjin) or Haiku usage (without) of a daily search.' },
        { label: 'Once a week', description: 'One search round a week, about a seventh of the daily router price or Haiku usage.' },
      ]),
      q('Positions', 'How many positions should I make ready to apply to?', [
        { label: '50 now, 10 daily (Recommended)', description: 'Up to fifty jobs from the last two weeks on the first run, then up to ten a day.' },
        { label: '100 now, 20 daily', description: 'A big push: up to a hundred jobs from the last two weeks on the first run, then up to twenty a day.' },
        { label: '20 now, 5 daily', description: 'A light search: up to twenty jobs on the first run, then up to five a day.' },
        { label: 'No limit', description: 'Every job that fits, on the first run and after, with no number set.' },
      ]),
      q('Where', 'Where do you prefer to apply?', [
        { label: 'Employer\'s site (Recommended)', description: 'I apply on the employer\'s own application page where I can, in the mode you chose.' },
        { label: 'A job site, I apply', description: 'For a job on LinkedIn, Indeed, YC or another job site, I open the job\'s page there in your browser and give you the answers; you apply there. I do nothing on that site.' },
        { label: 'Ask me each job', description: 'For a job that is on a job site and on an employer site, I ask which one with the application.' },
      ]),
    ],
    reminder: rcReminder({ rc, pushSent, settings }),
  };
}

// After "Auto apply": how new answers are handled. Asked in the auto follow-up call, with the rules and consents.
export function autoModeQuestion({ chromeOff = false } = {}) {
  return { questions: [chromeQ('Auto mode', 'How should new answers be handled in auto apply?', [
    { label: 'Auto apply, approve new answers', description: 'Uses your resume and answers you gave or approved before. When a form has a new question, the answer is drafted and that job waits for your yes.' },
    { label: 'Fully auto apply', description: 'Also submits the answers drafted for new questions, without showing them to you first.' },
  ], { chromeOff, needs: ['Auto apply', 'Fully auto'] })] };
}

// The role, place or remote, only when the resume really leaves it open: the guess first, the next best second.
export function resumeChoiceQuestion({ header, question, guess, next, source = 'resume' }) {
  const from = source === 'LinkedIn' ? 'LinkedIn' : 'resume';
  return { questions: [q(header, question, [{ label: `${guess} (from your ${from})`, description: `The best reading of your ${from === 'LinkedIn' ? 'LinkedIn profile, which has no job titles' : 'resume'}. No answer means this one.` }, { label: next, description: 'The next best reading.' }])] };
}

export function tenjinAsk({ line, status }) {
  const funded = status === 'unfunded';
  // The offer text itself asks "Set up Tenjin?"; the funded-but-empty variant keeps its own question.
  return { questions: [q('Tenjin', funded ? `${line} Add funds to Tenjin?` : line, [
    { label: `${funded ? 'Add funds' : 'Set up Tenjin'} (Recommended)`, description: funded ? 'Runs Tenjin\'s own funding step; you pick the amount there.' : 'Follows the install flow at tenjin.sh, which asks its own spending questions and funding step.' },
    { label: 'Not now', description: 'Everything free keeps working. I will mention it again but ask at most once per session.' },
  ])] };
}

// Asked the first time the person asks for contacts. No answer means 5; the answer is kept as the contact_count rule.
export function contactsCountQuestion() {
  const cost = `The free ways are a Haiku step; the router\'s people search runs in code at the router\'s price for each job the free ways left without a contact, plus a company lookup (about ${fmt(graph().prices.needs.company_lookup.estimateCents)}) for a job whose website is not known.`;
  return { questions: [q('Contacts', 'For how many jobs should I find someone to write to?', [
    { label: '5 jobs (Recommended)', description: `The 5 best-fitting jobs. ${cost}` },
    { label: '10 jobs', description: `The 10 best-fitting jobs, about twice the work and router price. ${cost}` },
    { label: 'Every job that passed review', description: `One round of contacts per job that passed review, the most work. ${cost}` },
  ])] };
}

// A follow-up that is due: what happened with an application. Asked in an attended turn, never a wake. After "They replied",
// one optional plain question asks what they said (`followUpDetail`).
export function followUpQuestion({ company, title }) {
  return { questions: [q('Follow-up', `Did you hear back about ${title} at ${company}?`, [
    { label: 'No reply yet (Recommended)', description: 'Keep waiting; I will ask again in 14 days.' },
    { label: 'They replied', description: 'Record a reply; I then ask what they said.' },
    { label: 'Interview', description: 'Record an interview.' },
    { label: 'Rejected', description: 'Record a rejection and stop following up.' },
  ])] };
}
export const followUpDetail = ({ company }) => plain(`What did ${company} say? You can answer in a sentence, or skip it.`);

// The voluntary demographic fields (gender, race or ethnicity, veteran status, disability) are never a choice question: the answers
// are the person's own text. At the first form that has them the skill asks this one plain question, built here, naming the fields
// this form asks. The answer is saved as text (`J eeo set`); on later forms the browser step matches it to the form's own options,
// and a field the text does not answer is asked again, plainly, with only that field (`fields` of one). An optional field is marked optional and can be skipped; a skip is saved, so a later form does not ask about it again.
export function eeoPlainQuestion({ fields = [], company = '' } = {}) {
  const names = fields.map((f) => (typeof f === 'string' ? f : `${f.label}${f.required === false ? ' (optional)' : ''}`)).filter(Boolean);
  const optional = fields.some((f) => typeof f !== 'string' && f.required === false);
  const skip = optional ? ' A field marked optional can also be skipped: say skip.' : '';
  if (!names.length) return plain(`The form asks some voluntary demographic questions. Answer each in your own words, or say decline.${skip}`);
  return plain(`${company ? `The ${company} form` : 'The form'} asks these voluntary demographic questions: ${names.join('; ')}. Answer each one in your own words, or say decline.${skip} I keep your words and match them to each form's own options.`);
}

export function optionalWritingQuestion() {
  return { questions: [q('Optional', 'For optional free-text fields (such as an optional cover letter), what should an unattended run do?', [
    { label: 'Skip them', description: 'Leave optional free-text fields empty and go on.' },
    { label: 'Wait for me', description: 'Hold the job in your queue until you have written or approved the text.' },
  ])] };
}

// A missing fact with fixed answers (for example work authorization): a choice only with the form's own options, word for
// word, when they fit (at most 3, plus "Skip this job"); otherwise a plain question that lists them. One without fixed answers
// (a phone number, pay) is always a plain question.
export function factQuestion({ label, options = [] }) {
  const opts = options.filter(Boolean);
  if (opts.length >= 2 && opts.length <= 3) return { questions: [q('Missing fact', `A form asks: ${label}`, [...opts.map((o) => ({ label: o, description: `Answer "${o}" for "${label}", and reuse it for the same question.` })), { label: 'Skip this job', description: 'Do not apply to this job.' }])] };
  return plain(`A form asks: ${label}${opts.length ? ` Its options are: ${opts.join('; ')}.` : ''} What should I answer? Or say skip to leave the job.`);
}

// A place the resume does not give, or a role with no clear guess: a plain question with the guess in its text.
export function placeQuestion({ guess = '', remote = false } = {}) {
  return plain(guess ? `From your resume I would search ${guess}${remote ? ' and remote' : ''}. Where should I search?` : 'Where should I search for jobs? A city, or remote.');
}
export function roleQuestion({ guess = '' } = {}) {
  return plain(guess ? `From your resume I would search for ${guess}. Which role should I search for?` : 'Which role should I search for?');
}

// A form's own legal acknowledgement (a privacy notice, terms to accept): its own question, with the form's text and link,
// because accepting terms needs the person's own yes. Never part of an approval.
export function acknowledgeQuestion({ company, text, link = null }) {
  return { questions: [q('Terms', `The ${company} form asks you to accept: ${String(text).slice(0, 300)}${link ? ` (${link})` : ''}`, [
    { label: 'Yes, I accept', description: 'Records your own yes to that text for this form; I never accept terms for you.' },
    { label: 'Skip this job', description: 'Do not apply to this job.' },
  ])] };
}

export function sheetYesQuestion({ company, title }) {
  return { questions: [q('Apply', `Apply to ${title} at ${company} with the sheet shown above?`, [
    { label: 'Yes, apply (Recommended)', description: 'Records your yes for this job and this exact sheet.' },
    { label: 'Not this one', description: 'Skip this job.' },
  ])] };
}

// The round's email drafts, shown after they are ready: multi-select questions of up to 4 options each (the tool's limits, 16
// drafts at most), each option a recipient and a subject. More than 16: send all, none, or the numbers through Other.
export function emailBatchQuestion(all, group = null) {
  const drafts = group === null ? all : all.slice(group * 16, group * 16 + 16);
  if (drafts.length > 16) {
    return { questions: [q('Emails', `${drafts.length} email drafts are ready, each to an address the poster published. Which should go?`, [
      { label: `Yes, send all ${drafts.length}`, description: 'Every draft goes from your Gmail, once per address.' },
      { label: 'Pick in groups of 16', description: 'Tick the drafts to send, 16 at a time.' },
      { label: 'None', description: 'Send nothing; the drafts stay for the report.' },
    ])] };
  }
  const chunks = [];
  for (let i = 0; i < drafts.length; i += 4) chunks.push(drafts.slice(i, i + 4));
  return { questions: chunks.map((c, i) => q(`Emails ${i + 1}`, 'Tick the drafts to send from your Gmail; the rest are not sent.', [...c.map((d) => ({ label: String(d.to).slice(0, 60), description: String(d.subject || d.employer || 'no subject').replace(/\n/g, ' ').slice(0, 90) })), ...(c.length < 2 ? [{ label: 'None of these', description: 'Tick this, or nothing, to send none of the drafts above.' }] : [])], true)), ids: drafts.map((d) => d.id) };
}
// Asked once, when the first email batch is ready.
export function emailModeQuestion() {
  return { questions: [q('Email', 'How should intro emails to published addresses go out?', [
    { label: 'Ask me each batch (Recommended)', description: 'You see each batch of drafts and tick the ones to send.' },
    { label: 'Send without asking, within my rules', description: 'Sends in the round with no yes, only to published addresses, once per address; revoke any time.' },
  ])] };
}

// One prepared application, attended: the first question about a job is its approval, with the prepared application shown
// (the fields, any new answer in full, the warnings). A fact the form needs that the profile lacks is asked in the same call,
// with its fixed answers and "Skip this job"; one with no fixed answers comes back as a plain question. The answer is saved as
// a fact (`J approve <key> --facts`), the sheet is completed, and the yes covers the completed sheet.
// `path` is 'ask' when the job is on a job site and on an employer site and the person chose "Ask me each job": the choice joins
// the approval call, and a job-site pick means the person applies there (the skill opens the page and does nothing on it).
export function approvalQuestions(job, path = 'employer', { chromeOff = false, referral = null } = {}) {
  // A filled form waiting for the person (`fill_ready`): the person may be on the phone, so the notice offers "Submit it now",
  // checked by `J may-submit` on the unchanged sheet hash, next to "I'll submit in Chrome" and "Not this one".
  if (job.fillReady) {
    return { application: (job.sheet.fields || []).map((f) => `${f.label}: ${f.tag === 'upload' ? 'your resume' : f.value} (${f.tag.replace('_', ' ')})`), questions: [chromeQ('Submit', `${job.title} at ${job.company} is filled and waiting. Submit it now?`, [
      { label: 'Submit it now (Recommended)', description: 'Records your yes for this exact sheet; the form is checked once more and then submitted, filled again first if the tab was closed.' },
      { label: 'I\'ll submit in Chrome', description: 'Nothing is submitted; you press submit in the open tab and tell me.' },
      { label: 'Not this one', description: 'Skip this job.' },
    ], { chromeOff, needs: ['Submit it now'] })], plain: [], next: 'record with J approve <key> --submit-now; say the state line it prints as given' };
  }
  const sheet = job.sheet || { fields: [], unanswered: [] };
  const application = [
    ...(sheet.fields || []).map((f) => `${f.label}: ${f.tag === 'upload' ? 'your resume' : f.value} (${f.tag.replace('_', ' ')})`),
    ...(job.warnings || []).map((w) => `warning: ${w}`),
    ...(referral && referral.status === 'pending' ? [`referral pending at ${job.company}${referral.referrer ? `: ${referral.referrer}` : ''}`] : []),
  ];
  const needs = ['Yes, apply', 'Fill it', 'Employer\'s site'];
  const fill = { label: 'Fill it, I submit', description: 'I fill the form and stop before submit; you check it and press submit.' };
  const asks = [path === 'ask'
    ? chromeQ('Apply', `Where should ${job.title} at ${job.company} go, with the application shown above?`, [
      { label: 'Employer\'s site (I apply)', description: 'Records your yes for this exact application, then I fill it and submit it on the employer\'s page.' },
      fill,
      { label: `${siteName(job)} (you apply)`, description: `I open the job\'s page on ${siteName(job)} in your browser and give you the answers; you apply there. I do nothing on that site.` },
      { label: 'Skip this job', description: 'Do not apply to this job.' },
    ], { chromeOff, needs })
    : chromeQ('Apply', `Apply to ${job.title} at ${job.company} with the application shown above?`, [
      { label: 'Yes, apply (Recommended)', description: 'Records your yes for this exact application, then fills it and submits it in one pass.' },
      fill,
      ...(referral && referral.status === 'pending' ? [{ label: 'Wait for the referral', description: `Your referral at ${job.company} is pending${referral.referrer ? ` (${referral.referrer})` : ''}: nothing is applied now, and I ask again when it is due.` }] : []),
      { label: 'Not this one', description: 'Skip this job.' },
    ], { chromeOff, needs })];
  // A fact the form needs: its own options word for word (at most 3, plus Skip) in a choice, else a plain question listing them.
  // A fact question never shares a call with the approval that follows it: the sheet the approval shows must be complete.
  const facts = [];
  const plainFacts = [];
  for (const u of (sheet.unanswered || []).filter((x) => x.factKey || x.ack || x.live)) {
    const form = (job.questions || []).find((x) => x.label === u.label) || {};
    const options = (form.options || u.options || []).filter(Boolean);
    // A legal acknowledgment (and the fill-only attestation) is its own yes, asked here with the job's other questions, before the fill.
    const fq = u.ack ? acknowledgeQuestion({ company: job.company, text: u.label }) : factQuestion({ label: u.label, options });
    if (fq.questions) facts.push({ ...fq.questions[0], fact: u.factKey || null, ack: u.ack ? u.label : undefined });
    else plainFacts.push({ label: u.label, fact: u.factKey || null, plain: fq.plain });
  }
  if (facts.length || plainFacts.length) {
    return { application, step: 'facts first', questions: facts.slice(0, 4), plain: plainFacts, then: 'J ask approval --key <job> again once every fact is saved (J approve <key> --facts <json> saves choices; J fact set <name> <value> saves a plain answer; J agree <key> <label> records a yes to an acknowledgment)', next: 'show the application, ask the fact questions in their own call; the approval comes after, with the completed sheet' };
  }
  return { application, questions: asks, plain: [], next: 'show the application, then ask this one call; record with J approve <key> [--fill-only|--via employer|site]; say the state line it prints as given' };
}

// The job site a job was found on first, by name.
export const siteName = (job) => ((job.siteLinks || [])[0] || {}).site || 'the job site';

// After a job-site page was opened: did the person apply there? Asked once per version of the job, in an attended turn.
export function appliedQuestion(job) {
  const { company, title } = job;
  return { questions: [q('Applied', `Did you apply to ${title} at ${company} on ${siteName(job)}?`, [
    { label: 'Yes', description: 'Record it as applied, on your word.' },
    { label: 'Not yet', description: 'Keep it shown; I ask again only if the job changes.' },
    { label: 'Skip this job', description: 'Do not apply to this job.' },
  ])] };
}

// Attended, many sheets at once: the report lists every ready sheet in rank order, then one question asks how to approve them.
export function approveListQuestion(n, { chromeOff = false } = {}) {
  return { questions: [chromeQ('Approve', `${n} application sheets are listed in the report. How should I approve them?`, [
    { label: `Approve all ${n} listed (Recommended)`, description: 'Records your yes for each listed sheet as it is shown; nothing is submitted without it.' },
    { label: `Fill all ${n}, I submit`, description: 'I fill each form and stop before submit; you check each one and press submit.' },
    { label: 'Pick in groups of 12', description: 'Tick the sheets to approve, 12 at a time.' },
    { label: 'Not now', description: 'Approve nothing yet; the sheets stay listed.' },
  ], { chromeOff, needs: ['Approve all', 'Fill all'] })] };
}
// Groups of 12: three multi-select questions of 4 options each, plus one question for how to go on (the tool's limit of 4).
export function approvePickQuestions(sheets, { chromeOff = false } = {}) {
  const groups = [];
  for (let i = 0; i < sheets.length; i += 12) {
    const g = sheets.slice(i, i + 12);
    const chunks = [];
    for (let k = 0; k < g.length; k += 4) chunks.push(g.slice(k, k + 4));
    const picks = chunks.map((c, n) => q(`Sheets ${i / 4 + n + 1}`, 'Tick the applications to approve.', [...c.map((x) => ({ label: `${x.company}`.slice(0, 40), description: `${x.title}${x.fitLine ? `: ${x.fitLine}` : ''}`.replace(/\n/g, ' ').slice(0, 90) })), ...(c.length < 2 ? [{ label: 'None of these', description: 'Tick this, or nothing, to approve none of the above.' }] : [])], true));
    const how = chromeQ('How', 'Apply the ones you picked, or fill them for you to submit?', [
      { label: 'Apply them (Recommended)', description: 'Records your yes for each ticked sheet, then fills and submits it.' },
      { label: 'Fill them, I submit', description: 'I fill each ticked form and stop before submit; you press submit.' },
    ], { chromeOff, needs: ['Apply them', 'Fill them'] });
    groups.push({ questions: [...picks, how], keys: g.map((x) => x.key) });
  }
  return groups;
}

// A payload is valid when it fits the question tool: 1 to 4 questions, 2 to 4 options each, labels and descriptions
// present, the first option marked as the default.
// The question tool shows its own free-text option; no question or option text may name it ("type under Other"). A form's own
// option that happens to start with "Other" (for example "Other job boards") is fine.
const NAMES_OTHER = /\b(under|through|via|in|use|choose|pick|select|type|write|enter)\s+(?:\w+\s+){0,3}["']?Other["']?\b|\bOther:|\bor\s+["']?Other["']?\s*[.?]|\bOther\s+(?:option|field)\b/i;
const NO_MARKER = new Set(['Missing fact', 'Terms', 'Referral']);
export function validateAsk(p) {
  const bad = [];
  if (!p || !Array.isArray(p.questions) || p.questions.length < 1 || p.questions.length > 4) return ['1 to 4 questions per call'];
  for (const [i, x] of p.questions.entries()) {
    const at = `question ${i}`;
    if (!x.header || x.header.length > 12) bad.push(`${at}: a short header (12 characters at most)`);
    if (!x.question) bad.push(`${at}: no question text`);
    if (NAMES_OTHER.test(String(x.question || ''))) bad.push(`${at}: the question text names the free-text option`);
    if (!Array.isArray(x.options) || x.options.length < 2 || x.options.length > 4) bad.push(`${at}: 2 to 4 options`);
    else {
      for (const o of x.options) {
        if (!o.label || !o.description || o.description.includes('\n')) bad.push(`${at}: each option needs a label and a one-line description`);
        if (NAMES_OTHER.test(`${o.label} ${o.description}`)) bad.push(`${at}: an option names the free-text option`);
      }
      if (!x.multiSelect && !NO_MARKER.has(x.header) && !/\((Recommended|from your resume|from your LinkedIn)\)$/.test(x.options[0].label) && !/^(Skip them|Yes|Install|Employer's site \(I apply\))/.test(x.options[0].label)) bad.push(`${at}: the first option is the default and carries its marker`);
    }
  }
  return bad;
}
