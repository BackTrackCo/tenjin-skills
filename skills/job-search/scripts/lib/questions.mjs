// The questions, as data for Claude Code's question tool (AskUserQuestion). In an attended turn, every question that has
// choices goes through it, never as a list in prose: 1 to 4 questions per call, 2 to 4 options each, a short label and a
// one-line description, the default first and labelled "(Recommended)" (or "(from your resume)" for a resume guess).
// The tool adds its own "Other" free-text answer. Never in an unattended turn: nobody can answer there.
const q = (header, question, options, multiSelect = false) => ({ header, question, multiSelect, options });

export const START_RESUME_QUESTION = 'Which file is your resume? Give its path. (A plain question: I read only that file and never search your files.)';

// The start, after the resume: one call, three questions. Remote Control is a reminder line, not a question.
export const RC_REMINDER = 'Type /rc to get these notifications on your phone and answer from the Claude app while this session keeps running here.';
export function startQuestions() {
  return {
    questions: [
      q('Apply mode', 'How should applications go out?', [
        { label: 'Ask me each time (Recommended)', description: 'I show each application and submit only after your yes.' },
        { label: 'Auto apply, approve new answers', description: 'Uses your resume and answers you gave or approved before. When a form has a new question, the answer is drafted and that job waits for your yes.' },
        { label: 'Fully auto apply', description: 'Also submits the answers drafted for new questions, without showing them to you first.' },
      ]),
      q('Search', 'How often should I search for jobs?', [
        { label: 'Every day (Recommended)', description: 'One search round a day. With Tenjin a round runs in code at the router\'s price, with no Claude usage for the searches; without it, a round is one Haiku run (usage not measured yet).' },
        { label: 'Twice a day', description: 'Two search rounds a day, about twice the router price (with Tenjin) or Haiku usage (without) of a daily search.' },
        { label: 'Once a week', description: 'One search round a week, about a seventh of the daily router price or Haiku usage.' },
      ]),
      q('Positions', 'How many positions should I make ready to apply to? Other: your own numbers.', [
        { label: '50 now, 10 daily (Recommended)', description: 'Up to fifty jobs from the last two weeks on the first run, then up to ten a day.' },
        { label: '100 now, 20 daily', description: 'A big push: up to a hundred jobs from the last two weeks on the first run, then up to twenty a day.' },
        { label: '20 now, 5 daily', description: 'A light search: up to twenty jobs on the first run, then up to five a day.' },
        { label: 'No limit', description: 'Every job that fits, on the first run and after, with no number set.' },
      ]),
    ],
    reminder: RC_REMINDER,
  };
}

// The role, place or remote, only when the resume really leaves it open: the guess first, the next best second.
export function resumeChoiceQuestion({ header, question, guess, next, source = 'resume' }) {
  const from = source === 'LinkedIn' ? 'LinkedIn' : 'resume';
  return { questions: [q(header, question, [{ label: `${guess} (from your ${from})`, description: `The best reading of your ${from === 'LinkedIn' ? 'LinkedIn profile, which has no job titles' : 'resume'}. No answer means this one.` }, { label: next, description: 'The next best reading.' }])] };
}

export function tenjinAsk({ line, status }) {
  const funded = status === 'unfunded';
  return { questions: [q('Tenjin', `${line} ${funded ? 'Add funds to Tenjin?' : 'Install Tenjin and add funds?'}`, [
    { label: `${funded ? 'Add funds' : 'Install Tenjin'} (Recommended)`, description: funded ? 'Runs Tenjin\'s own funding step; you pick the amount there.' : 'Follows the install flow at tenjin.sh, which asks its own spending questions and funding step.' },
    { label: 'Not now', description: 'Everything free keeps working. I will mention it again but ask at most once per session.' },
  ])] };
}

// Asked the first time the person asks for contacts. No answer means 5; the answer is kept as the contact_count rule.
export function contactsCountQuestion() {
  const cost = 'The free ways are a Haiku step; the router\'s people search runs in code at the router\'s price for each job the free ways left without a contact.';
  return { questions: [q('Contacts', 'For how many jobs should I find someone to write to?', [
    { label: '5 jobs (Recommended)', description: `The 5 best-fitting jobs. ${cost}` },
    { label: '10 jobs', description: `The 10 best-fitting jobs, about twice the work and router price. ${cost}` },
    { label: 'Every job that passed review', description: `One round of contacts per job that passed review, the most work. ${cost}` },
  ])] };
}

// A follow-up that is due: what happened with an application. Asked in an attended turn, never a wake.
export function followUpQuestion({ company, title }) {
  return { questions: [q('Follow-up', `What happened with ${title} at ${company}?`, [
    { label: 'No reply yet (Recommended)', description: 'Keep waiting; I will ask again in 14 days.' },
    { label: 'They replied', description: 'Record a reply; tell me more through Other if you want it noted.' },
    { label: 'Interview', description: 'Record an interview.' },
    { label: 'Rejected', description: 'Record a rejection and stop following up.' },
  ])] };
}

export function eeoQuestion() {
  return { questions: [q('EEO', 'This form asks voluntary demographic questions. How should I answer them from now on?', [
    { label: 'Decline to answer all (Recommended)', description: 'Chooses "decline to self-identify" wherever a form offers it.' },
    { label: 'Let me answer each question', description: 'I will ask you the questions when a form has them.' },
  ])] };
}

export function optionalWritingQuestion() {
  return { questions: [q('Optional', 'For optional free-text fields (such as an optional cover letter), what should an unattended run do?', [
    { label: 'Skip them', description: 'Leave optional free-text fields empty and go on.' },
    { label: 'Wait for me', description: 'Hold the job in your queue until you have written or approved the text.' },
  ])] };
}

// A missing fact with fixed answers (for example work authorization). One without fixed answers (a phone number, pay)
// is a plain question, or this one with "Skip this job" and the answer through "Other".
export function factQuestion({ label, options }) {
  const opts = options.map((o, i) => ({ label: i === 0 ? `${o} (Recommended)` : o, description: `Answer "${o}" for "${label}", and reuse it for the same question.` }));
  return { questions: [q('Missing fact', `A form asks: ${label}`, [...opts.slice(0, 3), { label: 'Skip this job', description: 'Do not apply to this job.' }].slice(0, 4))] };
}

export function sheetYesQuestion({ company, title }) {
  return { questions: [q('Apply', `Apply to ${title} at ${company} with the sheet shown above?`, [
    { label: 'Yes, apply (Recommended)', description: 'Records your yes for this job and this exact sheet.' },
    { label: 'Not this one', description: 'Skip this job.' },
  ])] };
}

// The round's email drafts, shown after they are ready: multi-select questions of up to 4 options each (the tool's limits, 16
// drafts at most), each option a recipient and a subject. More than 16: send all, none, or the numbers through Other.
export function emailBatchQuestion(drafts) {
  if (drafts.length > 16) {
    return { questions: [q('Emails', `${drafts.length} email drafts are ready, each to an address the poster published. Which should go?`, [
      { label: `Yes, send all ${drafts.length}`, description: 'Every draft goes from your Gmail, once per address.' },
      { label: 'None', description: 'Send nothing; the drafts stay for the report.' },
    ])], note: 'The numbers to send come through Other.' };
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

// Attended, many sheets at once: the report lists every ready sheet in rank order, then one question asks how to approve them.
export function approveListQuestion(n) {
  return { questions: [q('Approve', `${n} application sheets are listed in the report. How should I approve them?`, [
    { label: `Approve all ${n} listed (Recommended)`, description: 'Records your yes for each listed sheet as it is shown; nothing is submitted without it.' },
    { label: 'Pick in groups of 16', description: 'Tick the sheets to approve, 16 at a time.' },
    { label: 'Only those with no new answers', description: 'Approves the sheets that use only facts, your resume and answers you gave before.' },
    { label: 'Not now', description: 'Approve nothing yet; the sheets stay listed.' },
  ])] };
}
export function approvePickQuestions(sheets) {
  const groups = [];
  for (let i = 0; i < sheets.length; i += 16) {
    const g = sheets.slice(i, i + 16);
    const chunks = [];
    for (let k = 0; k < g.length; k += 4) chunks.push(g.slice(k, k + 4));
    groups.push({ questions: chunks.map((c, n) => q(`Sheets ${i / 4 + n + 1}`, 'Tick the applications to approve.', [...c.map((x) => ({ label: `${x.company}`.slice(0, 40), description: `${x.title}${x.fitLine ? `: ${x.fitLine}` : ''}`.replace(/\n/g, ' ').slice(0, 90) })), ...(c.length < 2 ? [{ label: 'None of these', description: 'Tick this, or nothing, to approve none of the above.' }] : [])], true)), keys: g.map((x) => x.key) });
  }
  return groups;
}

// A payload is valid when it fits the question tool: 1 to 4 questions, 2 to 4 options each, labels and descriptions
// present, the first option marked as the default.
export function validateAsk(p) {
  const bad = [];
  if (!p || !Array.isArray(p.questions) || p.questions.length < 1 || p.questions.length > 4) return ['1 to 4 questions per call'];
  for (const [i, x] of p.questions.entries()) {
    const at = `question ${i}`;
    if (!x.header || x.header.length > 12) bad.push(`${at}: a short header (12 characters at most)`);
    if (!x.question) bad.push(`${at}: no question text`);
    if (!Array.isArray(x.options) || x.options.length < 2 || x.options.length > 4) bad.push(`${at}: 2 to 4 options`);
    else {
      for (const o of x.options) if (!o.label || !o.description || o.description.includes('\n')) bad.push(`${at}: each option needs a label and a one-line description`);
      if (!x.multiSelect && !/\((Recommended|from your resume|from your LinkedIn)\)$/.test(x.options[0].label) && !/^(Skip them|Yes|Install)/.test(x.options[0].label)) bad.push(`${at}: the first option is the default and carries its marker`);
    }
  }
  return bad;
}
