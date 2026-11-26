import { normalizeQuestion } from './answers.mjs';
import { hasParts, matchParts, partsPhrase } from './parts.mjs';

// The missing facts of every job prepared in a moment, merged into questions code builds: the same profile fact, or the same
// normalized label, is one question that names every job asking it. The model never writes a fact question list by hand.
const LIVE = ['shortlisted', 'prepared', 'apply_ready'];
const MAX_PER_CALL = 4;
const NAMES_SHOWN = 3;

// The groups: [{id, label, factKey, jobs: [{key, company, title, label, type, options, required}]}], from the sheets as they are.
export function collectFacts(state) {
  const groups = new Map();
  for (const job of Object.values(state.jobs)) {
    if (!LIVE.includes(job.status) || !job.sheet) continue;
    for (const u of job.sheet.unanswered || []) {
      if (u.ack || u.eeo || /^draft failed/.test(u.why || '')) continue;
      const form = (job.questions || []).find((x) => x.label === u.label) || {};
      const options = (form.options || u.options || []).filter(Boolean);
      // A question with the form's own fixed options is a fact to ask, known or not; free writing is the writer's job.
      if (!u.factKey && !u.live && !options.length) continue;
      const id = u.factKey ? `fact:${u.factKey}` : `q:${normalizeQuestion(u.label)}`;
      const g = groups.get(id) || { id, label: u.label, factKey: u.factKey || null, jobs: [] };
      const parts = Array.isArray(form.parts) && form.parts.length ? form.parts : Array.isArray(u.parts) && u.parts.length ? u.parts : null;
      g.jobs.push({ key: job.key, company: job.company, title: job.title, label: u.label, type: form.type || u.type || 'input_text', options, required: form.required !== false, ...(parts ? { parts } : {}) });
      groups.set(id, g);
    }
  }
  return [...groups.values()];
}

const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const covers = (list, shown) => shown.every((o) => list.includes(o));

// Forms with different option lists for one question: one list is shown (the most common, else the one a required field uses), and a
// form whose options do not hold that list's answers is asked on its own, never guessed.
export function splitByOptions(group) {
  const withOpts = group.jobs.filter((j) => j.options.length);
  if (!withOpts.length) return [group];
  const counts = new Map();
  for (const j of withOpts) { const k = JSON.stringify([...j.options].sort()); counts.set(k, { n: (counts.get(k) ? counts.get(k).n : 0) + 1, job: counts.get(k) ? counts.get(k).job : j, req: (counts.get(k) ? counts.get(k).req : false) || j.required, list: j.options }); }
  const best = [...counts.values()].sort((a, b) => b.n - a.n || Number(b.req) - Number(a.req))[0];
  const shown = best.list;
  const fit = group.jobs.filter((j) => j.options.length && covers(j.options, shown));
  const rest = group.jobs.filter((j) => !fit.includes(j));
  const first = { ...group, shown, jobs: fit };
  if (!rest.length) return [first];
  const others = splitByOptions({ ...group, id: `${group.id}#${2}`, jobs: rest });
  return [first, ...others.map((g, i) => ({ ...g, id: `${group.id}#${i + 2}` }))];
}

// The options the question tool shows (at most 4 and its own free-text field, which a typed answer uses): 2 or 3 as they are, 4 as they
// are, 5 or more the first 3 in the form's order plus the form's decline option when it has one, else the 4th. A form option named
// "Other" is never one of them.
const norm = (o) => normalizeQuestion(o);
const DECLINE = /^(prefer not to (say|answer|disclose|state)|decline( to (answer|state|say|self.?identify|disclose))?|i (do not|don'?t) wish to (answer|disclose|state|say)|i choose not to .*)$/;
export const isDecline = (o) => DECLINE.test(norm(o));
export function toolOptions(opts) {
  const list = opts.filter((o) => norm(o) !== 'other');
  if (list.length <= 4) return list;
  const decline = list.find(isDecline);
  const first = list.filter((o) => o !== decline).slice(0, decline ? 3 : 4);
  return decline ? [...first, decline] : first;
}

const namesOf = (jobs) => {
  const names = [...new Set(jobs.map((j) => `${j.company}`))];
  return names.length <= NAMES_SHOWN ? names.join(', ') : `${names.slice(0, NAMES_SHOWN).join(', ')} and ${names.length - NAMES_SHOWN} more`;
};
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 3)}...` : String(s));

// The questions: those with 2 or 3 fixed options go through the question tool, at most 4 per call, in order; the rest (dates,
// names, free text, a long option list) come in one plain message.
export function buildFactQuestions(groups) {
  const split = groups.flatMap(splitByOptions);
  const choice = [];
  const plain = [];
  for (const g of split) {
    const opts = g.shown || [];
    const forWho = `For: ${namesOf(g.jobs)}`;
    // A date, or a field made of several controls, is typed in one plain message; its parts are asked for by name, never as a choice.
    const dated = g.jobs.find((j) => hasParts(j));
    if (dated) {
      const named = g.jobs.find((j) => j.parts);
      plain.push({ id: g.id, label: g.label, jobs: g.jobs.map((j) => j.key), text: `${g.label} (${forWho}) Give ${named ? partsPhrase(named.parts) : 'a date'}.` });
    } else if (opts.length >= 2) {
      const shownOpts = toolOptions(opts);
      const skip = shownOpts.length <= 3 ? [{ label: 'Skip these jobs', description: `Do not apply to ${g.jobs.length > 1 ? 'these jobs' : 'this job'}.` }] : [];
      choice.push({ id: g.id, label: g.label, jobs: g.jobs.map((j) => j.key), question: { header: 'Missing fact', question: clip(`${g.label} ${forWho}`, 280), multiSelect: false, options: [...shownOpts.map((o) => ({ label: clip(o, 60), description: `Answer "${clip(o, 60)}" for ${g.jobs.length} job${g.jobs.length > 1 ? 's' : ''} and reuse it for the same question.` })), ...skip] } });
    } else {
      plain.push({ id: g.id, label: g.label, jobs: g.jobs.map((j) => j.key), text: `${g.label} (${forWho})${opts.length ? ` Options: ${opts.join('; ')}.` : ''}` });
    }
  }
  const calls = [];
  for (let i = 0; i < choice.length; i += MAX_PER_CALL) {
    const part = choice.slice(i, i + MAX_PER_CALL);
    calls.push({ questions: part.map((c) => c.question), ids: part.map((c) => c.id) });
  }
  return {
    calls,
    plain: plain.length ? { message: `I need a few answers for the forms:\n${plain.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}\nAnswer each in your own words, or say skip.`, ids: plain.map((p) => p.id) } : null,
    plan: Object.fromEntries(split.map((g) => [g.id, { label: g.label, factKey: g.factKey, jobs: g.jobs }])),
    count: split.length,
  };
}

// How many questions wait, for the push: no mutation, the sheets as they are.
export const waitingFactCount = (state) => collectFacts(state).flatMap(splitByOptions).length;

// Records one answer for the merged question: the profile fact (when it is one) and each job's own question as an earlier answer, then
// the sheets are rebuilt. A form whose own options do not hold the answer is named: its browser step maps it, it is never guessed.
export function applyFactAnswer(state, profile, plan, id, value, addAnswer) {
  const g = plan[id];
  if (!g) throw new Error(`no such question: ${id}; run J ask facts again`);
  const needsMapping = [];
  for (const j of g.jobs) {
    // A typed answer is matched to the form's full list by the exact normalization; one that matches no option is never guessed.
    if (j.parts) {
      // A field made of several controls: each part is matched to its own options and recorded as the form spells it; a part code cannot
      // match sends the job to its form's own mapping, never a guess.
      const pv = matchParts(j.parts, value);
      if (!pv) { needsMapping.push(j.key); continue; }
      addAnswer({ question: j.label, answer: pv.map((p) => p.value).join(' '), how: 'typed', source: j.key, type: j.type, options: null, parts: pv });
      continue;
    }
    const mine = j.options.length ? j.options.find((o) => o === value) || j.options.find((o) => norm(o) === norm(value)) : value;
    if (!mine) { needsMapping.push(j.key); continue; }
    addAnswer({ question: j.label, answer: mine, how: 'typed', source: j.key, type: j.type, options: j.options.length ? j.options : null });
  }
  return { jobs: g.jobs.map((j) => j.key), needsMapping, factKey: g.factKey };
}
