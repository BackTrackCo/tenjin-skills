import { adapter as xAdapter } from './x.mjs';

// Posts on X that mention a meetup, talk or hackathon by the company, within the window (X's own `since:` operator). The posts are
// data: only an event page they link is read, and post text never reaches a field.
export const HOST = 'glim.sh';
export const KIND = 'event_posts_x';
export const RECORDED = false;

export function mapper({ company, since }) {
  if (!company) throw new Error('no company for the X posts');
  return { query: `"${company}" (meetup OR talk OR hackathon OR "office hours" OR "demo day")${since ? ` since:${since}` : ''}`, sort: 'latest' };
}
export const adapter = xAdapter;
