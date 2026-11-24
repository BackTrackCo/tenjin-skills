// The questions, as data for Claude Code's question tool (AskUserQuestion). In an attended turn, every question that has
// choices goes through it, never as a list in prose: 1 to 4 questions per call, 2 to 4 options each, a short label and a
// one-line description, the default first and labelled "(Recommended)" (or "(from your resume)" for a resume guess).
// The tool adds its own "Other" free-text answer. Never in an unattended turn: nobody can answer there.
const q = (header, question, options) => ({ header, question, multiSelect: false, options });

export const START_RESUME_QUESTION = 'Which file is your resume? Give its path. (A plain question: I read only that file and never search your files.)';

// The start, after the resume path: one call, four questions.
export function startQuestions() {
  return {
    questions: [
      q('Apply mode', 'How should applications go out?', [
        { label: 'Ask me before each application (Recommended)', description: 'You see each filled sheet and say yes before anything is submitted.' },
        { label: 'Auto apply only when there are no new questions', description: 'Uploads your resume and uses only answers you gave or approved before; a job with a new question waits for you.' },
        { label: 'Auto apply, and also write new answers', description: 'As above, and new free-text answers are written for you without asking.' },
      ]),
      q('Search', 'How often should I search for jobs?', [
        { label: 'Every day (Recommended)', description: 'One search round a day. A round is one Haiku run with free web searches (usage not measured yet); router calls cost the router price within your Tenjin limits.' },
        { label: 'Twice a day', description: 'Two search rounds a day, so about twice the usage and router calls of a daily search.' },
        { label: 'Once a week', description: 'One search round a week, about a seventh of the daily usage and router calls.' },
      ]),
      q('Positions', 'How many positions should I make ready to apply to in each search period?', [
        { label: 'Up to 10 (Recommended)', description: 'Attended: 10 sheets brought for your yes. Auto: 10 applications. The rest stay ranked for the next period; none is dropped.' },
        { label: 'Up to 5', description: 'A smaller batch each period; the rest wait for the next one.' },
        { label: 'Up to 20', description: 'A larger batch each period; the rest wait for the next one.' },
      ]),
      q('Remote', 'Remote Control sends notifications to your phone and lets you answer from there while this session keeps running. Turn it on?', [
        { label: 'I will turn it on now (Recommended)', description: 'Type /remote-control, or turn on "Enable Remote Control for all sessions" in /config. You also need the Claude app and its push toggles.' },
        { label: 'Not now', description: 'Notifications stay in this terminal. You can turn it on any time.' },
      ]),
    ],
  };
}

// The role, place or remote, only when the resume really leaves it open: the guess first, the next best second.
export function resumeChoiceQuestion({ header, question, guess, next }) {
  return { questions: [q(header, question, [{ label: `${guess} (from your resume)`, description: 'The best reading of your resume. No answer means this one.' }, { label: next, description: 'The next best reading.' }])] };
}

export function tenjinAsk({ line, status }) {
  const funded = status === 'unfunded';
  return { questions: [q('Tenjin', `${line} ${funded ? 'Add funds to Tenjin?' : 'Install Tenjin and add funds?'}`, [
    { label: `${funded ? 'Add funds' : 'Install Tenjin'} (Recommended)`, description: funded ? 'Runs Tenjin\'s own funding step; you pick the amount there.' : 'Follows the install flow at tenjin.sh, which asks its own spending questions and funding step.' },
    { label: 'Not now', description: 'Everything free keeps working. I will mention it again but ask at most once per session.' },
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
      if (!/\((Recommended|from your resume)\)$/.test(x.options[0].label) && !/^(Skip them|Yes|Install)/.test(x.options[0].label)) bad.push(`${at}: the first option is the default and carries its marker`);
    }
  }
  return bad;
}
