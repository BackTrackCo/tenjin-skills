import crypto from 'node:crypto';
import { pendingApproved, repliesDue, unknownList } from './email.mjs';

const hashInt = (s) => parseInt(crypto.createHash('sha256').update(s).digest('hex').slice(0, 8), 16);
const DAY = 86400000;

// Approved emails wait for the model's handout (email_due). An unknown handout waits for the person's word. The sent threads are
// checked for replies at most once a day, and only while they are young.
export function emailItems({ state, now }) {
  const items = [];
  const ready = pendingApproved(state);
  if (ready.length) items.push({ key: 'email', reason: 'email_due', v: hashInt(ready.map((d) => d.id).sort().join('|')), count: ready.length });
  const unknown = unknownList(state);
  if (unknown.length) items.push({ key: 'unknown', reason: 'unknown_due', v: hashInt(unknown.map((d) => d.id).sort().join('|')), count: unknown.length, waitsForPerson: true });
  const threads = repliesDue(state, now);
  if (threads.length) items.push({ key: 'replies', reason: 'replies_due', v: hashInt(`${Math.floor(now / DAY)}|${threads.map((t) => t.id).sort().join('|')}`), count: threads.length });
  return items;
}
