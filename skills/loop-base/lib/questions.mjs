import { getApp } from './app.mjs';

// The question core, as data for Claude Code's question tool (AskUserQuestion). In an attended turn, every question that has choices goes
// through it, never as a list in prose: 1 to 4 questions per call, 2 to 4 options each, a short label and a one-line description, the
// default first and marked "(Recommended)". The tool adds its own free-text answer; no question or option text names it. A choice is only
// for a question whose options usually hold the answer: a typed answer is a plain question, `{plain}`. Never in an unattended turn.
//
// An app declares its exceptions: questions: { noMarker: [headers], markers: ['from your resume'], firstOptionOk: [/regex/] }.
export const q = (header, question, options, multiSelect = false) => ({ header, question, multiSelect, options });
export const plain = (text) => ({ plain: text });

// The question tool shows its own free-text option; no question or option text may name it ("type under Other"). A form's own
// option that happens to start with "Other" (for example "Other job boards") is fine.
export const NAMES_OTHER = /\b(under|through|via|in|use|choose|pick|select|type|write|enter)\s+(?:\w+\s+){0,3}["']?Other["']?\b|\bOther:|\bor\s+["']?Other["']?\s*[.?]|\bOther\s+(?:option|field)\b/i;

export function validateAsk(p) {
  const decl = getApp().questions || {};
  const noMarker = new Set(decl.noMarker || []);
  const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marked = new RegExp(`\\((Recommended${(decl.markers || []).map((m) => `|${escape(m)}`).join('')})\\)$`);
  const firstOk = decl.firstOptionOk || [];
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
      if (!x.multiSelect && !noMarker.has(x.header) && !marked.test(x.options[0].label) && !firstOk.some((re) => re.test(x.options[0].label))) bad.push(`${at}: the first option is the default and carries its marker`);
    }
  }
  return bad;
}
