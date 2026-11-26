import { bump, companyTitleKey, normLabel } from './store.mjs';

export { sha, normalizeUrl } from '../../../loop-base/lib/hash.mjs';
import { normalizeUrl, sha } from '../../../loop-base/lib/hash.mjs';

export function contentHash(job) {
  return sha([job.title, job.company, job.city, job.region, job.country, job.remote, job.type, job.salary, job.desc].join('\u0001')).slice(0, 16);
}

// What a resolved job keeps when the same link comes back from a search that did not resolve it.
const RESOLVED = ['employerPosting', 'openConfirmed', 'ats', 'board', 'sourceId', 'applyLinks', 'employerWebsite', 'employerWebsiteSource', 'unresolved', 'otherSystem', 'workAtStartupUrl', 'siteLinks'];
const sameJobOnBoard = (a, b) => a.board && a.board === b.board && a.sourceId && a.sourceId === b.sourceId;

// Merge freshly swept jobs into state. A job dropped earlier never comes back.
export function mergeJobs(state, swept, nowIso) {
  const added = [];
  for (const j of swept) {
    let key = normalizeUrl(j.url);
    let existing = state.jobs[key];
    // Another job under the same link (a generic apply link, one comment that lists several roles, no link at all) is its own
    // record: only the same posting on the same board may change a title and a company.
    if (existing && companyTitleKey(existing) !== companyTitleKey(j) && !sameJobOnBoard(existing, j)) {
      key = `${key}#${sha(companyTitleKey(j)).slice(0, 10)}`;
      existing = state.jobs[key];
    }
    if (existing) {
      const h = contentHash(j);
      const changed = h !== existing.hash;
      const kept = {};
      // A repeat that carries no employer posting does not wipe the one a careers page or a board probe confirmed.
      if (!j.employerPosting && existing.employerPosting) for (const f of RESOLVED) if (existing[f] !== undefined) kept[f] = existing[f];
      Object.assign(existing, { ...j, key, hash: h, lastSeen: nowIso, status: existing.status, firstSeen: existing.firstSeen, parked: existing.parked, fit: existing.fit, fitLine: existing.fitLine, warnings: existing.warnings, reviewedHash: existing.reviewedHash, drafts: existing.drafts, verifiedAt: nowIso, statusAt: existing.statusAt, ...kept });
      if (changed) bump(existing); // new data for this job: a changed posting
      continue;
    }
    // The same posting found again under another link: a job whose employer posting is this link, or the same company, title and
    // place already live. A different opening on the same board (another job id) and a repost after a close are separate jobs.
    const twin = Object.values(state.jobs).find((x) => (x.employerPosting && normalizeUrl(x.employerPosting.url) === key) || (companyTitleKey(x) === companyTitleKey(j) && x.place === j.place && x.status !== 'closed' && !(x.sourceId && j.sourceId && x.sourceId !== j.sourceId) && !(x.board && j.board && x.board === j.board && x.sourceId !== j.sourceId)));
    if (twin) {
      twin.alsoAt = [...new Set([...(twin.alsoAt || []), key])];
      twin.lastSeen = nowIso;
      continue;
    }
    state.jobs[key] = { ...j, v: 1, key, hash: contentHash(j), employerPosting: j.employerPosting !== undefined ? j.employerPosting : derivePosting(j, nowIso), openConfirmed: j.openConfirmed !== undefined ? j.openConfirmed : Boolean(j.sourceId && j.board && ['greenhouse', 'lever', 'ashby'].includes(j.ats)), status: 'new', firstSeen: nowIso, lastSeen: nowIso, verifiedAt: nowIso, warnings: j.warnings || [], parked: null };
    added.push(key);
  }
  return added;
}

// A job read from a Greenhouse, Lever or Ashby board is the employer's own posting.
function derivePosting(j, nowIso) {
  if (!j.sourceId || !j.board || !['greenhouse', 'lever', 'ashby'].includes(j.ats)) return null;
  return { url: j.url, system: j.ats, token: j.board.split(':')[1], jobId: j.sourceId, source: 'apply_link', confidence: 'exact', checkedAt: nowIso };
}

export function duplicateWithin(state, job, now, days) {
  const k = companyTitleKey(job);
  const cutoff = now - days * 86400000;
  return state.applications.some((a) => a.companyKey === k && Date.parse(a.at) >= cutoff);
}

export { normLabel };
