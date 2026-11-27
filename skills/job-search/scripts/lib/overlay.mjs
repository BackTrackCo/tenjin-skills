import { graph } from '../../../loop-base/lib/graph.mjs';
import { extendApp } from '../../../loop-base/lib/app.mjs';
import { canonical } from '../../../loop-base/lib/hash.mjs';
import * as base from '../../../loop-base/lib/rules.mjs';
import './paths.mjs';

// The rules and lessons core (the rules file, the vocabulary check, tighten-only lessons that expire, the consent hash) is the loop
// base's. Job Search declares its vocabulary from graph.json, its value checks, its lesson texts and the effects that only tighten.
const DAY = 86400000;

// Lesson texts: a template over evidence ids, never page text.
const TEMPLATES = {
  host_attended: (l) => `Two bot checks stopped applications on ${l.subject} within 7 days, so jobs there wait for the person. Evidence: ${l.evidence.join(', ')}.`,
  host_last: (l) => `Jobs on ${l.subject} go last. Evidence: ${l.evidence.join(', ')}.`,
  company_attended: (l) => `A form at ${l.subject} broke the fill, so its jobs wait for the person. Evidence: ${l.evidence.join(', ')}.`,
  drop_query: (l) => `The query "${l.subject}" found no new job in 5 sweeps and is paused. Evidence: ${l.evidence.join(', ')}.`,
  fewer_queries: (l) => `A step ran over its time, so the next run uses fewer queries. Evidence: ${l.evidence.join(', ')}.`,
};

const whole = (n) => Number.isInteger(Number(n)) && Number(n) > 0;
extendApp({ rules: {
  effects: () => graph().ruleEffects,
  check(effect, value) {
    if (effect === 'contact_count' && !(value === 'all' || whole(value))) throw new Error('contact_count is a whole number of jobs, or "all"');
    if (effect === 'period_max') {
      const ok = value === 'none' || whole(value) || (value && typeof value === 'object' && (value.catchUp === undefined || value.catchUp === null || whole(value.catchUp)) && (value.perDay === 'none' || whole(value.perDay)));
      if (!ok) throw new Error('period_max is a whole number of positions, "none" for no limit, or {catchUp, perDay}');
    }
  },
  lessonEffects: () => graph().lessonEffects,
  lessonDays: () => graph().lessonDays,
  lessonTemplates: TEMPLATES,
  // Limits and notifications only tighten what a submit may do, so they do not change the hash the consent is bound to.
  exempt: ['note', 'period_max', 'notify_quiet_hours', 'notify_off', 'contact_count', 'fill_only', 'referral_delay_days', 'events_window_days'],
  hashParts: (profile) => ({ unattended: profile.unattended || null }),
} });

export const { rulesFile, loadOverlay, addRule, removeRule, addLesson, activeLessons, ruleValue, rulesHash } = base;
export { canonical };

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
