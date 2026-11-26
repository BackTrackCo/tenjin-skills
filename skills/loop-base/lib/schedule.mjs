// How often the skill searches, and the period that the positions count belongs to.
export const FREQUENCIES = ['daily', 'twice_daily', 'weekly'];
const HOUR = 3600000;
export const INTERVAL_MS = { daily: 24 * HOUR, twice_daily: 12 * HOUR, weekly: 168 * HOUR };

export const frequencyOf = (profile) => {
  const f = profile && profile.frequency;
  return FREQUENCIES.includes(f) ? f : 'daily';
};

// A search is due 4 hours before its interval ends (2 hours for a twice-a-day search), and always when it is
// 2 hours past due. A daily search before its morning hour waits for it, as before.
export function searchIsDue({ lastAt, now, frequency = 'daily', hour = 7 }) {
  if (lastAt === null || lastAt === undefined) return true;
  const interval = INTERVAL_MS[frequency];
  const elapsed = now - lastAt;
  const lead = frequency === 'twice_daily' ? 2 * HOUR : 4 * HOUR;
  if (elapsed >= interval + 2 * HOUR) return true;
  if (elapsed < interval - lead) return false;
  return frequency === 'daily' ? new Date(now).getHours() >= hour : true;
}

// The start of the current period, in local time: midnight (daily), midnight or noon (twice a day), Monday midnight (weekly).
export function periodStart(now, frequency = 'daily') {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  if (frequency === 'twice_daily') d.setHours(d.getHours() >= 12 ? 12 : 0);
  else d.setHours(0);
  if (frequency === 'weekly') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

// A follow-up comes due a set number of days after a moment (a timing default the person can change, never a cap).
export const afterDays = (from, days, now = Date.now()) => Number.isFinite(from) && now - from >= days * 24 * HOUR;
