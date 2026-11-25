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
  [/citizen/, 'us_citizen'], [/clearance/, 'security_clearance'],
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

export const TAGS = ['fact', 'upload', 'answer', 'record', 'new_writing'];

// Every field carries one source tag:
//   fact: a profile value (the EEO choice and a select option chosen from a fact included)
//   upload: the resume file
//   answer: an earlier answer that matches by the code-only rule (answers.mjs)
//   record: a value from the skill's own records about this job (where it was found), mapped to the form's own option by code
//   new_writing: drafted text the person has not approved for this exact question
// ---- answers from the skill's own records ----------------------------------------------------------------
// "Where did you hear about this role?" is answered from the source the search recorded for the job, mapped by code to one of
// the form's own options, word for word, with a fixed word list per source. A saved answer for the same question comes first
// (earlier answers are matched before this), and a free-text field gets a short phrase of the source, not new writing. With no
// matching option the question stays a normal new question. "Referral" only on the person's word; an AI-assistant option is
// never the default.
const HEARD = /\b(hear|heard|find out|found out|learn|learned|come across|discover)\b.*\b(role|position|job|us|opportunity|company|vacancy)\b|\bhow did you (hear|find|learn)\b|\bsource\b.*\b(applicant|application)\b|\breferral source\b/i;
const WORDS = {
  employer: [['company website', 'careers page', 'company careers', 'career page', 'careers site', 'company site', 'corporate website', 'job board', 'job boards', 'other job boards', 'other']],
  posting: [['job board', 'job boards', 'other job boards', 'online job board', 'other']],
  linkedin: [['linkedin']],
  x: [['x', 'twitter', 'x (twitter)', 'social media']],
  hn: [['hacker news', 'developer communities', 'developer community', 'online community', 'online communities', 'community']],
};
const PHRASE = { linkedin: 'LinkedIn', x: 'X', hn: 'Hacker News', posting: 'Job board' };
export function recordedSource(job) {
  const from = String(job.fromPost || job.sourceUrl || '');
  if (/(^|\/\/)(www\.)?(x|twitter)\.com\//i.test(from)) return 'x';
  if (job.via === 'hn' || /ycombinator\.com|hacker-?news/i.test(from)) return 'hn';
  if (/linkedin\.com/i.test(from)) return 'linkedin';
  if (job.via === 'routed' || job.via === 'web') return 'posting';
  return 'employer';
}
const lc = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();
export function recordAnswer(job, q) {
  if (!HEARD.test(q.label)) return null;
  const src = recordedSource(job);
  const options = (q.options || []).filter(Boolean);
  if (!options.length) {
    if (q.type && !/text/.test(q.type)) return null;
    const ep = job.employerPosting;
    return src === 'employer' ? (ep && ep.system ? `${ep.system[0].toUpperCase()}${ep.system.slice(1).replace(/_/g, ' ')} job board` : 'Company careers page') : PHRASE[src];
  }
  for (const list of WORDS[src]) {
    for (const w of list) {
      const hit = options.find((o) => lc(o) === w);
      if (hit) return hit;
    }
    // a looser word: an option that contains it as a whole word (never the AI-assistant options, never Referral)
    for (const w of list.filter((x) => x.length > 3)) {
      const hit = options.find((o) => new RegExp(`\\b${w}\\b`).test(lc(o)) && !/referral|\bai\b|llm|assistant/.test(lc(o)));
      if (hit) return hit;
    }
  }
  return null;
}

export function buildSheet({ job, questions, profile, answers = [], drafts = {} }) {
  const facts = profile.facts || {};
  const fields = [];
  const unanswered = [];
  const forbidden = [];
  let eeoMissing = false;
  const eeoFields = [];
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
      // A per-field answer is reused only for the same option text; a field with no answer, or an answer the form no longer
      // offers, is asked (the form's own options, one field at a time).
      const mine = e && e !== 'decline_all' ? (e.answers || {})[nl] : null;
      const offered = !q.options || !q.options.length || q.options.includes(mine);
      if (!e) eeoMissing = true;
      else if (e === 'decline_all') {
        value = 'Decline to self-identify';
        tag = 'fact';
      } else if (mine && offered) {
        value = mine;
        tag = 'fact';
      } else {
        eeoMissing = true;
        eeoFields.push({ label: q.label, options: q.options || [] });
      }
    } else {
      const earlier = matchAnswer(q, answers);
      const hit = FACTS.find(([re]) => re.test(nl));
      if (earlier) {
        value = earlier.answer;
        tag = 'answer';
      } else if (recordAnswer(job, q)) {
        value = recordAnswer(job, q);
        tag = 'record';
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
  const sheet = { job: job.key, fields, unanswered, forbidden, eeoMissing, eeoFields };
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
