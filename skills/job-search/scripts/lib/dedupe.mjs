import crypto from 'node:crypto';
import { companyTitleKey, normLabel } from './store.mjs';

const TRACKING = /^(utm_.*|gh_src|gh_jid|lever-source|lever-origin|ref|source|src|gclid|fbclid|mc_.*)$/i;

export function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function normalizeUrl(u) {
  const url = new URL(u);
  url.hash = '';
  for (const k of [...url.searchParams.keys()]) if (TRACKING.test(k)) url.searchParams.delete(k);
  url.hostname = url.hostname.toLowerCase();
  let s = url.toString();
  s = s.replace(/\/application\/?$/, '/application').replace(/\/+$/, '');
  return s;
}

export function contentHash(job) {
  return sha([job.title, job.company, job.city, job.region, job.country, job.remote, job.type, job.salary, job.desc].join('\u0001')).slice(0, 16);
}

// Merge freshly swept jobs into state. A job dropped earlier never comes back.
export function mergeJobs(state, swept, nowIso) {
  const added = [];
  for (const j of swept) {
    const key = normalizeUrl(j.url);
    const ctKey = `ct:${companyTitleKey(j)}`;
    const existing = state.jobs[key];
    if (existing) {
      const h = contentHash(j);
      Object.assign(existing, { ...j, key, hash: h, lastSeen: nowIso, status: existing.status, firstSeen: existing.firstSeen, parked: existing.parked, fit: existing.fit, fitLine: existing.fitLine, warnings: existing.warnings, reviewedHash: existing.reviewedHash, drafts: existing.drafts, verifiedAt: nowIso, statusAt: existing.statusAt });
      continue;
    }
    if (state.dedupe[key]) continue;
    // cross-source merge: same company and title already live under another URL
    const twin = Object.values(state.jobs).find((x) => companyTitleKey(x) === companyTitleKey(j) && x.place === j.place);
    if (twin) {
      twin.alsoAt = [...new Set([...(twin.alsoAt || []), key])];
      twin.lastSeen = nowIso;
      continue;
    }
    if (state.dedupe[ctKey]) continue;
    state.jobs[key] = { ...j, key, hash: contentHash(j), status: 'new', firstSeen: nowIso, lastSeen: nowIso, verifiedAt: nowIso, warnings: j.warnings || [], parked: null };
    added.push(key);
  }
  return added;
}

export function duplicateWithin(state, job, now, days) {
  const k = companyTitleKey(job);
  const cutoff = now - days * 86400000;
  return state.applications.some((a) => a.companyKey === k && Date.parse(a.at) >= cutoff);
}

export { normLabel };
