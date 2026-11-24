import { canonical } from './overlay.mjs';
import { sha } from './dedupe.mjs';
import { normLabel } from './store.mjs';
import { matchAnswer } from './answers.mjs';

// Labels that always stop a job: the profile has no field for these.
const FORBIDDEN = /\b(ssn|social security|national id|government id|passport|driver'?s? licen[cs]e|date of birth|birth ?date|birthday|\bdob\b|bank|routing number|account number|iban|password|tax id)\b|\bid number\b|\bid card\b/i;
const EEO = /\b(gender|race|ethnic|hispanic|latino|veteran|disability|sexual orientation|pronoun|transgender)\b/i;
const FACTS = [
  [/first name|given name/, 'first_name'], [/last name|surname|family name/, 'last_name'], [/^(full )?name$|your name/, 'full_name'],
  [/e-?mail/, 'email'], [/phone|mobile/, 'phone'], [/linkedin/, 'linkedin'], [/github/, 'github'], [/website|portfolio/, 'website'],
  [/current company|current employer/, 'current_company'], [/city|location|where are you based/, 'location'],
  [/sponsorship|visa/, 'requires_sponsorship'], [/authori[sz]ed to work|work authori[sz]ation|legally authori/, 'authorized_to_work'],
  [/salary|compensation expectation/, 'salary_expectation'],
];
const PLACEHOLDER = /\[[^\]]*(path|insert|your|company|name|todo)[^\]]*\]|\bTODO\b|lorem ipsum|\{\{|<insert|\bXXX+\b|\[PATH TO/i;

export const factKeyFor = (label) => { const hit = FACTS.find(([re]) => re.test(normLabel(label))); return hit ? hit[1] : null; };
export const isForbiddenLabel = (label) => FORBIDDEN.test(label);
export const isEeoLabel = (label) => EEO.test(label);

// Greenhouse's questions=true shape: questions, location_questions, compliance, demographic_questions.
export function parseGreenhouseQuestions(json) {
  const out = [];
  const take = (q, group) => {
    if (!q || !q.label) return;
    const f = (q.fields && q.fields[0]) || {};
    out.push({ label: q.label, required: q.required === true, type: f.type || q.type || 'input_text', group, options: (f.values || []).map((v) => v.label), maxLength: q.max_length || null });
  };
  for (const q of json.questions || []) take(q, 'application');
  for (const q of json.location_questions || []) take(q, 'location');
  for (const c of json.compliance || []) for (const q of c.questions || []) take(q, 'eeo');
  for (const q of (json.demographic_questions && json.demographic_questions.questions) || []) take({ ...q, label: q.label || q.question }, 'eeo');
  return out;
}

export function checkDraft(text, { limit = null, profile = {} } = {}) {
  const problems = [];
  const t = String(text || '');
  if (!t.trim()) problems.push('empty');
  if (limit && t.length > limit) problems.push(`over the ${limit} character limit`);
  if (/https?:\/\/|www\./i.test(t)) problems.push('contains a link');
  const f = profile.facts || {};
  for (const m of t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []) if (m.toLowerCase() !== String(f.email || '').toLowerCase()) problems.push('email not in the profile');
  for (const m of t.match(/\+?\d[\d\s().-]{7,}\d/g) || []) if (m.replace(/\D/g, '') !== String(f.phone || '').replace(/\D/g, '')) problems.push('phone not in the profile');
  if (PLACEHOLDER.test(t)) problems.push('placeholder text');
  return problems;
}

export const TAGS = ['fact', 'upload', 'answer', 'new_writing'];

// Every field carries one source tag:
//   fact: a profile value (the EEO choice and a select option chosen from a fact included)
//   upload: the resume file
//   answer: an earlier answer that matches by the code-only rule (answers.mjs)
//   new_writing: drafted text the person has not approved for this exact question
export function buildSheet({ job, questions, profile, answers = [], drafts = {} }) {
  const facts = profile.facts || {};
  const fields = [];
  const unanswered = [];
  const forbidden = [];
  let eeoMissing = false;
  for (const q of questions) {
    if (FORBIDDEN.test(q.label)) {
      forbidden.push(q.label);
      continue;
    }
    const nl = normLabel(q.label);
    let value;
    let tag;
    if (q.type === 'input_file' && /resume|cv/.test(nl)) {
      value = '<resume>';
      tag = 'upload';
    } else if (EEO.test(q.label)) {
      const e = profile.eeo;
      if (!e) eeoMissing = true;
      else {
        value = e === 'decline_all' ? 'Decline to self-identify' : (e.answers || {})[nl] || 'Decline to self-identify';
        tag = 'fact';
      }
    } else {
      const earlier = matchAnswer(q, answers);
      const hit = FACTS.find(([re]) => re.test(nl));
      if (earlier) {
        value = earlier.answer;
        tag = 'answer';
      } else if (hit && facts[hit[1]] !== undefined && facts[hit[1]] !== '') {
        value = String(facts[hit[1]]);
        tag = 'fact';
      } else if (drafts[q.label] !== undefined) {
        const problems = checkDraft(drafts[q.label], { limit: q.maxLength, profile });
        if (!problems.length) {
          value = drafts[q.label];
          tag = 'new_writing';
        } else if (q.required) {
          unanswered.push({ label: q.label, why: `draft failed: ${problems.join(', ')}` });
          continue;
        }
      }
    }
    if (value === undefined) {
      if (q.required && !(EEO.test(q.label) && eeoMissing)) unanswered.push({ label: q.label, why: 'no fact, earlier answer or checked draft', factKey: factKeyFor(q.label) });
      continue;
    }
    fields.push({ label: q.label, value, tag, required: q.required });
  }
  const sheet = { job: job.key, fields, unanswered, forbidden, eeoMissing };
  sheet.hash = sha(canonical({ job: job.key, fields: fields.map((f) => [f.label, f.value]) })).slice(0, 16);
  return sheet;
}

// sheet check: the sheet itself, then the live form against the sheet.
export function checkSheet(sheet, live = null) {
  const problems = [];
  if (sheet.forbidden.length) problems.push(`form asks for something the profile never holds: ${sheet.forbidden.join(', ')}`);
  if (sheet.unanswered.length) problems.push(`unanswered required fields: ${sheet.unanswered.map((u) => u.label).join(', ')}`);
  if (sheet.eeoMissing) problems.push('the EEO choice is not made');
  if (sheet.fields.some((f) => !TAGS.includes(f.tag))) problems.push('a field has no source tag');
  if (live) {
    const known = new Set(sheet.fields.map((f) => normLabel(f.label)));
    for (const f of live) {
      if (FORBIDDEN.test(f.label)) problems.push(`live form asks for ${f.label}`);
      else if (!known.has(normLabel(f.label)) && f.required) problems.push(`live form has a required field the sheet lacks: ${f.label}`);
      else if (!known.has(normLabel(f.label))) problems.push(`live form has a field the sheet lacks: ${f.label}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// Before submit: the values read back from the page must equal the sheet.
export function checkReadBack(sheet, read) {
  const problems = [];
  const by = new Map(read.map((r) => [normLabel(r.label), String(r.value ?? '').trim()]));
  for (const f of sheet.fields) {
    if (f.value === '<resume>') continue;
    if (by.get(normLabel(f.label)) !== String(f.value).trim()) problems.push(`read-back differs: ${f.label}`);
  }
  return { ok: problems.length === 0, problems };
}
