// The careers-page finder (recorded 2026-11-24). Input: `url` must be an absolute https URL: a bare domain is refused
// before payment. Result: {result: {found, careers_page: {url}, open_positions: {count, vendor, board}}}.
export const HOST = 'signal.halowerk.com';
export const KIND = 'careers_page';

export function mapper({ website }) {
  const raw = String(website || '').trim();
  if (!raw) throw new Error('no employer website for the careers-page lookup');
  return { url: /^https?:\/\//i.test(raw) ? raw.replace(/^http:/i, 'https:') : `https://${raw}` };
}

const BOARD_URL = { greenhouse: (b) => `https://boards.greenhouse.io/${b}`, lever: (b) => `https://jobs.lever.co/${b}`, ashby: (b) => `https://jobs.ashbyhq.com/${b}` };

// A board candidate when the vendor is Greenhouse, Lever or Ashby (it still goes through the board probe and the job
// match for `confirmed`); otherwise only the careers page URL, for "apply on the employer's site".
export function adapter(res, fields) {
  const { jobKey } = fields;
  const r = res && res.result;
  if (!r || typeof r.found !== 'boolean') throw new Error('the result has no found flag');
  const page = (r.careers_page && r.careers_page.url) || null;
  const op = r.open_positions || {};
  const vendor = String(op.vendor || '').toLowerCase();
  const board = typeof op.board === 'string' && /^[A-Za-z0-9._-]+$/.test(op.board) ? op.board : null;
  const boardLinks = r.found && BOARD_URL[vendor] && board ? [BOARD_URL[vendor](board)] : [];
  return { jobKey, careersUrl: page || mapper(fields).url, found: r.found, careersPageOnly: r.found && !boardLinks.length && Boolean(page), boardLinks, otherLinks: [], signIn: false };
}
