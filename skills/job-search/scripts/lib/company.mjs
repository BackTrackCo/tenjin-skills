import { websiteLabel } from './employer.mjs';

// Finding the company before the people search. The employer's website names the right company, since a short name alone matches
// many. What code already has, in order: a link field in the job record (`record`), the routed posting's employer website field
// (`posting`), the company homepage link on a posting or board page code read (`board_page`); with Tenjin a company lookup by name
// or link (`company_lookup`). A domain is saved only after code checks it against the company name and the board's company name.
export function websiteOf(job) {
  const rec = job.companyUrl || job.companyWebsite || job.homepage;
  if (typeof rec === 'string' && rec.trim()) return { url: rec.trim(), source: 'record' };
  if (typeof job.employerWebsite === 'string' && job.employerWebsite.trim()) return { url: job.employerWebsite.trim(), source: job.employerWebsiteSource || 'posting' };
  if (typeof job.boardHomepage === 'string' && job.boardHomepage.trim()) return { url: job.boardHomepage.trim(), source: 'board_page' };
  return null;
}

// The names the company is known by: the posting's company and the board's company name.
export const companyNames = (job) => [job.company, job.boardCompany].filter((n) => typeof n === 'string' && n.trim());

export { normName, nameMatches } from '../../../loop-base/lib/names.mjs';
