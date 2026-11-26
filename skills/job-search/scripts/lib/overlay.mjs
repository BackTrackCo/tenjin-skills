import crypto from 'node:crypto';
import path from 'node:path';
import { graph } from '../../../loop-base/lib/graph.mjs';
import { readJson, stateDir, writeJsonAtomic } from './paths.mjs';
import { withLock } from './store.mjs';

const DAY = 86400000;
export const rulesFile = () => path.join(stateDir(), 'rules.json');

export function loadOverlay() {
  return readJson(rulesFile(), { rules: [], lessons: [] });
}
function mutate(fn) {
  return withLock(() => {
    const o = loadOverlay();
    const out = fn(o);
    writeJsonAtomic(rulesFile(), o);
    return out;
  });
}

// The person's rules: their words verbatim, the date, and an effect from the vocabulary.
export function addRule({ effect, value = null, words, date }) {
  if (!graph().ruleEffects.includes(effect)) throw new Error(`rule effect not in the vocabulary: ${effect}`);
  if (!words || !String(words).trim()) throw new Error('a rule keeps the words the person said');
  if (effect === 'contact_count' && !(value === 'all' || (Number.isInteger(Number(value)) && Number(value) > 0))) throw new Error('contact_count is a whole number of jobs, or "all"');
  if (effect === 'period_max') {
    const whole = (n) => Number.isInteger(Number(n)) && Number(n) > 0;
    const ok = value === 'none' || whole(value) || (value && typeof value === 'object' && (value.catchUp === undefined || value.catchUp === null || whole(value.catchUp)) && (value.perDay === 'none' || whole(value.perDay)));
    if (!ok) throw new Error('period_max is a whole number of positions, "none" for no limit, or {catchUp, perDay}');
  }
  return mutate((o) => {
    const rule = { id: `r${Date.now().toString(36)}${o.rules.length}`, effect, value, words: String(words), date: date || new Date().toISOString().slice(0, 10) };
    o.rules.push(rule);
    return rule;
  });
}
export function removeRule(id) {
  return mutate((o) => {
    const n = o.rules.length;
    o.rules = o.rules.filter((r) => r.id !== id);
    o.lessons = o.lessons.filter((l) => l.id !== id);
    return n - o.rules.length;
  });
}

const TEMPLATES = {
  host_attended: (l) => `Two bot checks stopped applications on ${l.subject} within 7 days, so jobs there wait for the person. Evidence: ${l.evidence.join(', ')}.`,
  host_last: (l) => `Jobs on ${l.subject} go last. Evidence: ${l.evidence.join(', ')}.`,
  company_attended: (l) => `A form at ${l.subject} broke the fill, so its jobs wait for the person. Evidence: ${l.evidence.join(', ')}.`,
  drop_query: (l) => `The query "${l.subject}" found no new job in 5 sweeps and is paused. Evidence: ${l.evidence.join(', ')}.`,
  fewer_queries: (l) => `A step ran over its time, so the next run uses fewer queries. Evidence: ${l.evidence.join(', ')}.`,
};

// Lessons only tighten. Text comes from a template over evidence ids, never from page text.
export function addLesson({ effect, subject, evidence = [], now = Date.now() }) {
  if (!graph().lessonEffects.includes(effect)) throw new Error(`lesson effect refused (not tighten-only): ${effect}`);
  return mutate((o) => {
    const prior = o.lessons.filter((l) => l.effect === effect && l.subject === subject);
    const live = prior.find((l) => Date.parse(l.expires) > now);
    if (live) return live;
    const days = graph().lessonDays;
    const level = Math.min(prior.length, days.length - 1);
    const lesson = { id: `l${now.toString(36)}${o.lessons.length}`, effect, subject, evidence: evidence.slice(0, 5), created: new Date(now).toISOString(), expires: new Date(now + days[level] * DAY).toISOString(), days: days[level] };
    lesson.text = TEMPLATES[effect](lesson);
    o.lessons.push(lesson);
    return lesson;
  });
}
export function activeLessons(o, now = Date.now()) {
  return o.lessons.filter((l) => Date.parse(l.expires) > now);
}

// Lessons from the graph's triggers, evidence ids only.
export function deriveLessons(state, now = Date.now()) {
  const t = graph().lessonTriggers;
  const made = [];
  const win = t.captcha_stops_on_host.windowDays * DAY;
  const byHost = {};
  for (const s of state.stops || []) {
    if (s.kind === 'captcha' && now - Date.parse(s.at) <= win) (byHost[s.host] ||= []).push(s.key);
    if (s.kind === 'form_broke') made.push(addLesson({ effect: t.form_broke_fill.effect, subject: s.company || s.host, evidence: [s.key], now }));
    if (s.kind === 'timeout') made.push(addLesson({ effect: t.step_over_time.effect, subject: 'sweep', evidence: [s.key], now }));
  }
  for (const [host, keys] of Object.entries(byHost)) {
    if (keys.length >= t.captcha_stops_on_host.count) {
      made.push(addLesson({ effect: 'host_attended', subject: host, evidence: keys, now }));
      made.push(addLesson({ effect: 'host_last', subject: host, evidence: keys, now }));
    }
  }
  for (const [q, y] of Object.entries(state.queryYield || {})) {
    if (y.dry >= t.query_no_new_jobs.sweeps) made.push(addLesson({ effect: 'drop_query', subject: q, evidence: [`query:${q}`], now }));
  }
  return made;
}

// Rules take effect on a job. Returns drops (code removes) and warnings.
export function applyRulesToJob(job, overlay, now = Date.now()) {
  const drops = [];
  const warnings = [];
  const text = `${job.title} ${job.desc || ''}`.toLowerCase();
  for (const r of (overlay && overlay.rules) || []) {
    const v = String(r.value ?? '').toLowerCase();
    if (r.effect === 'exclude_company' && v && String(job.company).toLowerCase().includes(v)) drops.push(`rule:exclude_company:${r.id}`);
    if (r.effect === 'exclude_term' && v && text.includes(v)) drops.push(`rule:exclude_term:${r.id}`);
    if (r.effect === 'require_term' && v && !text.includes(v)) drops.push(`rule:require_term:${r.id}`);
    if (r.effect === 'employment_type' && v && job.type && !job.type.toLowerCase().replace(/[^a-z]/g, '').includes(v.replace(/[^a-z]/g, ''))) drops.push(`rule:employment_type:${r.id}`);
    if (r.effect === 'min_pay') {
      const top = maxPay(job.salary);
      if (top !== null && top < Number(r.value)) drops.push(`rule:min_pay:${r.id}`);
    }
  }
  return { drops, warnings };
}

export function maxPay(salary) {
  if (!salary) return null;
  const nums = String(salary).match(/\d[\d,]*(?:\.\d+)?k?/gi);
  if (!nums) return null;
  const vals = nums.map((n) => (/k$/i.test(n) ? parseFloat(n) * 1000 : parseFloat(n.replace(/,/g, ''))));
  return Math.max(...vals);
}

export function effectiveProfile(profile, overlay) {
  const p = { ...profile, places: [...(profile.places || [])] };
  for (const r of overlay.rules || []) {
    if (r.effect === 'place' && r.value) p.places.push(String(r.value));
    if (r.effect === 'remote') p.remote = r.value !== false && r.value !== 'false';
  }
  return p;
}

export function ruleValue(overlay, effect) {
  const r = (overlay.rules || []).filter((x) => x.effect === effect).pop();
  return r ? r.value : undefined;
}

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
// The hash an unattended consent is bound to: the person's confirmed settings and rules.
export function rulesHash(profile, overlay) {
  // Limits and notifications only tighten what a submit may do, so they do not change the hash the consent is bound to.
  const rules = (overlay.rules || []).filter((r) => !['note', 'period_max', 'notify_quiet_hours', 'notify_off', 'contact_count', 'fill_only', 'referral_delay_days', 'events_window_days'].includes(r.effect)).map((r) => [r.effect, r.value]).sort();
  return crypto.createHash('sha256').update(canonical({ unattended: profile.unattended || null, rules })).digest('hex');
}
