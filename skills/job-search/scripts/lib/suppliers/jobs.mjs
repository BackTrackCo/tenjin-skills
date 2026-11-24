// The job-posting supplier: input mapper and result adapter. The result has data.jobs[] with job_title, employer_name,
// job_publisher, job_apply_link, apply_options[], job_is_remote, job_posted_at_datetime_utc, job_city, job_state,
// job_country, the salary fields and job_description (read from a live answer on 2026-11-24).
// The host below is the one the spec text names; it is checked again against the envelope's `supplier` after the run.
export const HOST = 'jsearch';

export function mapper({ role, place, remote, since }) {
  const days = since ? Math.max(1, Math.ceil((Date.now() - Date.parse(since)) / 86400000)) : 14;
  return { query: `${role}${place ? ` in ${place}` : ''}`, remote_jobs_only: remote === true, date_posted: days <= 1 ? 'today' : days <= 3 ? '3days' : days <= 7 ? 'week' : 'month' };
}

const str = (v) => (typeof v === 'string' ? v : '');
export function adapter(result) {
  const list = result && result.data && result.data.jobs;
  if (!Array.isArray(list)) throw new Error('the result has no data.jobs list');
  const postings = list.map((j) => {
    if (!j || !str(j.job_title) || !str(j.employer_name)) throw new Error('a job has no title or employer');
    const links = [];
    for (const o of j.apply_options || []) if (str(o.apply_link)) links.push({ url: o.apply_link, publisher: str(o.publisher) });
    if (str(j.job_apply_link) && !links.some((l) => l.url === j.job_apply_link)) links.unshift({ url: j.job_apply_link, publisher: str(j.job_publisher) });
    const min = typeof j.job_min_salary === 'number' ? j.job_min_salary : null;
    const max = typeof j.job_max_salary === 'number' ? j.job_max_salary : null;
    return {
      title: j.job_title, employer: j.employer_name, employerWebsite: str(j.employer_website) || undefined,
      city: str(j.job_city), region: str(j.job_state), country: str(j.job_country), remote: j.job_is_remote === true,
      postedAt: str(j.job_posted_at_datetime_utc) || null, employmentType: str(j.job_employment_type),
      salary: min !== null || max !== null ? { min, max, currency: str(j.job_salary_currency) || 'USD', period: str(j.job_salary_period).toLowerCase() || 'year' } : null,
      applyLinks: links, description: str(j.job_description).slice(0, 2000), sourceUrl: links[0] ? links[0].url : str(j.job_google_link) || 'router:no-link',
    };
  });
  return { postings };
}
