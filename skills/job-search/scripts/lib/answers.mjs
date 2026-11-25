import path from 'node:path';
import { checkDraft } from './sheet.mjs';
import { readJson, stateDir, writeJsonAtomic } from './paths.mjs';
import { withLock } from './store.mjs';

export const answersFile = () => path.join(stateDir(), 'answers.json');
const HOW = ['typed', 'approved'];

// Code only, no model judgment: NFKC, lower case, white space collapsed, required marks removed, end punctuation stripped.
export function normalizeQuestion(s) {
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\((required|optional)\)/g, ' ')
    .replace(/\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s?!.:;,]+$/g, '')
    .trim();
}

export function loadAnswers() {
  return readJson(answersFile(), { entries: [] });
}

// An entry: the normalized question, the answer, how it was given, the date and the source application.
export function addAnswer({ question, answer, how, source = null, type = 'input_text', options = null, now = Date.now() }) {
  if (!HOW.includes(how)) throw new Error('an answer is typed or approved');
  if (!String(answer).trim()) throw new Error('an empty answer is not saved');
  return withLock(() => {
    const store = loadAnswers();
    const q = normalizeQuestion(question);
    store.entries = store.entries.filter((e) => !(e.q === q && e.type === type));
    const entry = { q, answer: String(answer), how, date: new Date(now).toISOString().slice(0, 10), source, type, options };
    store.entries.push(entry);
    writeJsonAtomic(answersFile(), store);
    return entry;
  });
}

// The match rule: equal normalized text, the same field type, a select answer still among the form's options,
// and text that fits the length limit. Anything else is new writing.
export function matchAnswer(field, entries) {
  const q = normalizeQuestion(field.label);
  const e = entries.find((x) => x.q === q && x.type === (field.type || 'input_text'));
  if (!e) return null;
  if (Array.isArray(field.options) && field.options.length && !field.options.includes(e.answer)) return null;
  if (field.maxLength && e.answer.length > field.maxLength) return null;
  return e;
}

// The person approved the drafts, as they are or edited: each new-writing field becomes an earlier answer.
export function approveWriting(job, profile, edits = {}, now = Date.now()) {
  const approved = [];
  for (const f of job.sheet.fields.filter((x) => x.tag === 'new_writing')) {
    const text = edits[f.label] !== undefined ? edits[f.label] : f.value;
    const q = (job.questions || []).find((x) => x.label === f.label) || {};
    const problems = checkDraft(text, { limit: q.maxLength, profile });
    if (problems.length) throw new Error(`${f.label}: ${problems.join(', ')}`);
    approved.push(addAnswer({ question: f.label, answer: text, how: 'approved', source: job.key, type: q.type || 'input_text', options: q.options && q.options.length ? q.options : null, now }));
  }
  return approved;
}
