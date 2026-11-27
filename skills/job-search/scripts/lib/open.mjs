import './paths.mjs';

// Opening a page (the checks on the link, the operating system's own open command in the person's Chrome, the default-browser fallback)
// is the loop base's: nothing reads, fetches, fills or clicks that page. This file keeps which page to open for a job.
export { checkOpenUrl, chromeCommand, defaultCommand, FALLBACK_LINE, openPage } from '../../../loop-base/lib/open.mjs';

// The page to open for a job: its employer posting in "Just open the pages"; in every stronger mode only the fallback, a job
// the skill must not or cannot fill (its application on a deny-listed host, or a stop at a login or a bot check).
export function openUrlOf(job, profile = {}) {
  if (profile.applyMode === 'open_only') return job.employerPosting && job.sheet ? job.employerPosting.url : job.otherSystem ? job.otherSystem.url : null;
  if (job.otherSystem && job.otherSystem.url) return job.otherSystem.url;
  if (job.parked && job.employerPosting && job.parked.reasons.some((r) => ['captcha', 'login', 'sign_in'].includes(r))) return job.employerPosting.url;
  return null;
}
