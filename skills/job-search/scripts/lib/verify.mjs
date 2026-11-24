import { graph } from './graph.mjs';
import { applyRulesToJob } from './overlay.mjs';

const DAY = 86400000;

// Code drops a job only when it is outside the date window or the place,
// or a rule of the person's drops it. Everything else becomes a warning.
export function screenJob(job, profile, rules, now) {
  const drops = [];
  const warnings = [];
  const windowDays = profile.windowDays || 14;
  if (job.posted && now - Date.parse(job.posted) > graph().staleListingDays * DAY) warnings.push('listed over 60 days');
  else if (job.posted && now - Date.parse(job.posted) > windowDays * DAY && !profile.includeOld) drops.push('outside_date_window');
  const places = (profile.places || []).map((p) => p.toLowerCase());
  if (places.length) {
    const hay = `${job.city} ${job.region} ${job.country}`.toLowerCase();
    const inPlace = places.some((p) => hay.includes(p));
    if (!inPlace && !(job.remote && profile.remote === true)) drops.push('outside_place');
  }
  if (/contract|temporary|temp\b|freelance/i.test(job.type || '') || /\bcontract\b/i.test(job.title)) warnings.push('contract');
  const byRules = applyRulesToJob(job, rules, now);
  drops.push(...byRules.drops);
  warnings.push(...byRules.warnings);
  return { drop: [...new Set(drops)], warnings: [...new Set(warnings)] };
}
