import crypto from 'node:crypto';

// gh_jid is kept: on an employer's own page it names the job.
const TRACKING = /^(utm_.*|gh_src|lever-source|lever-origin|ref|source|src|gclid|fbclid|mc_.*)$/i;

export function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function normalizeUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return String(u).trim(); // a link with no scheme is kept as it came, never thrown on
  }
  url.hash = '';
  for (const k of [...url.searchParams.keys()]) if (TRACKING.test(k)) url.searchParams.delete(k);
  url.hostname = url.hostname.toLowerCase();
  let s = url.toString();
  s = s.replace(/\/application\/?$/, '/application').replace(/\/+$/, '');
  return s;
}

// A stable text of a value: object keys sorted, so equal values give equal text and equal hashes.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
