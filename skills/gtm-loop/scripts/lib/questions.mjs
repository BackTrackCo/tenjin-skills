// The questions, as data for Claude Code's question tool (AskUserQuestion). In an attended turn, every question that has
// choices goes through it, never as a list in prose: 1 to 4 questions per call, 2 to 4 options each, a short label and a
// one-line description, the default first and labelled "(Recommended)". The tool adds its own free-text answer; no question or
// option text names it. A typed answer (an address, a name) is a plain question, `{plain}`. Never in an unattended turn: nobody
// can answer there.
export const q = (header, question, options, multiSelect = false) => ({ header, question, multiSelect, options });
export const plain = (text) => ({ plain: text });

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

export function tenjinAsk({ line, status }) {
  const funded = status === 'unfunded';
  return { questions: [q('Tenjin', funded ? `${line} Add funds to Tenjin?` : line, [
    { label: `${funded ? 'Add funds' : 'Set up Tenjin'} (Recommended)`, description: funded ? 'Runs Tenjin\'s own funding step; you pick the amount there.' : 'Follows the install flow at tenjin.sh, which asks its own spending questions and funding step.' },
    { label: 'Not now', description: 'Everything free keeps working. I will mention it again but ask at most once per session.' },
  ])] };
}

// A payload is valid when it fits the question tool: 1 to 4 questions, 2 to 4 options each, labels and descriptions present, the
// first option marked as the default. The tool shows its own free-text option; no text may name it ("type under Other").
const NAMES_OTHER = /\b(under|through|via|in|use|choose|pick|select|type|write|enter)\s+(?:\w+\s+){0,3}["']?Other["']?\b|\bOther:|\bor\s+["']?Other["']?\s*[.?]|\bOther\s+(?:option|field)\b/i;
const NO_MARKER = new Set(['Picks']);
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
      if (!x.multiSelect && !NO_MARKER.has(x.header) && !/\(Recommended\)$/.test(x.options[0].label) && !/^(Yes|Install)/.test(x.options[0].label)) bad.push(`${at}: the first option is the default and carries its marker`);
    }
  }
  return bad;
}

// ---- GTM Loop questions ----------------------------------------------------------------------------------------------
export const EMAIL_MODE_OF = { 'Ask me for each email (Recommended)': 'ask', 'Make Gmail drafts, I press Send': 'drafts', 'Show me the text': 'show' };
export const SOURCES_OF = { 'Every source (Recommended)': ['x', 'reddit', 'linkedin', 'hn', 'web'], 'X, Reddit and LinkedIn only': ['x', 'reddit', 'linkedin'], 'Hacker News and the web only': ['hn', 'web'] };

// The start, after the person said what they sell and edited the phrases: one call, three questions.
export function startQuestions({ rc = 'unknown', pushSent = false, settings = {}, searchOptions = null } = {}) {
  return {
    questions: [
      q('Email', 'How should emails go out?', [
        { label: 'Ask me for each email (Recommended)', description: 'I show each email with its address and footer and send it from your Gmail only after your yes.' },
        { label: 'Make Gmail drafts, I press Send', description: 'I make a draft in your Gmail for each email you approve; you press Send.' },
        { label: 'Show me the text', description: 'I show each email with a mailto link; you send it from any mail app.' },
      ]),
      q('Search', 'How often should I search for leads?', [
        { label: 'Every day (Recommended)', description: 'One search round a day. With Tenjin it runs in code at the router\'s price; without it, one Haiku web-search run.' },
        { label: 'Twice a day', description: 'Two search rounds a day, about twice the router price or Haiku usage.' },
        { label: 'Once a week', description: 'One search round a week, about a seventh of the daily price or usage.' },
      ]),
      q('Sources', 'Where should I look for leads?', [
        { label: 'Every source (Recommended)', description: 'Posts on X, Reddit and LinkedIn, Hacker News and the web.' },
        { label: 'X, Reddit and LinkedIn only', description: 'Social posts only; Hacker News and the web are left out.' },
        { label: 'Hacker News and the web only', description: 'The free sources only: Hacker News search and one web-search step.' },
      ]),
      ...(searchOptions ? [q('Searches', 'How many searches should each round run?', searchOptions)] : []),
    ],
    reminder: rcReminder({ rc, pushSent, settings }),
  };
}

// One yes for one exact email: the address, the subject, the text with its footer, and where the person is, said in the question.
export function emailQuestion({ cand, via }) {
  const where = cand.country ? `They appear to be in ${cand.country}.` : 'Their country is not known, so the footer says where the details came from and how to object.';
  const how = via === 'send' ? 'It is sent from your Gmail.' : via === 'drafts' ? 'It becomes a draft in your Gmail; you press Send.' : 'You get the text with a mailto link; you send it.';
  const found = cand.source === 'lookup' ? ' The address was found by a lookup and checked as valid.' : ' The address is the one they published.';
  const draftNote = cand.mustDraft ? ' A found address in this country is only ever a draft.' : '';
  return {
    questions: [q('Email', `Email ${cand.to}? ${where}${found}${draftNote} ${how} Subject: ${cand.subject}. Text: ${cand.text}`, [
      { label: via === 'send' ? 'Yes, send it (Recommended)' : via === 'drafts' ? 'Yes, make the draft (Recommended)' : 'Yes, show me the text (Recommended)', description: 'Records your yes for exactly this address and this text.' },
      { label: 'No, not this one', description: 'Nothing is sent and the lead stays as it is.' },
    ])],
  };
}
