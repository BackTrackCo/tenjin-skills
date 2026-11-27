import crypto from 'node:crypto';
import { applyOp } from './store.mjs';
import { contactedInfo, contactProblem, isSuppressed, contentHash } from './dedupe.mjs';
import { followUpDays } from './overlay.mjs';
import { q } from './questions.mjs';
import { CHANNEL_LABEL } from './outreach.mjs';

// A follow-up exists only when the person's own `follow_up` rule says so ("follow up once after 4 days"). It is one draft per
// person, attended only, never after a reply, never after an opt-out, and the first contact's day is never reset. The follow-up is a
// lead of its own (`fu:<key>`) that goes through the same writer, pick, approval and send as any other, with the first message
// handed to the writer as quoted data.
const DAY = 86400000;
const hashInt = (s) => parseInt(crypto.createHash('sha256').update(s).digest('hex').slice(0, 8), 16);

export function followUpCandidates(state, overlay, now = Date.now()) {
  const days = followUpDays(overlay);
  if (!days) return [];
  return Object.values(state.leads).filter((l) => {
    if (l.status !== 'contacted' || l.followUp || l.followUpSkipped || state.leads[`fu:${l.key}`]) return false;
    const c = contactedInfo(state, l.personKey);
    if (!c || c.replied || (c.followUps || 0) >= 1) return false;
    if (isSuppressed(state, l.personKey)) return false;
    return now - Date.parse(c.at) >= days * DAY;
  });
}

export function followUpItems({ state, overlay, now }) {
  const list = followUpCandidates(state, overlay, now);
  return list.length ? [{ key: 'followup', reason: 'follow_up_due', v: hashInt(list.map((l) => l.key).sort().join('|')), count: list.length, waitsForPerson: true }] : [];
}

export function startFollowUp(state, key, overlay, now = Date.now()) {
  const days = followUpDays(overlay);
  if (!days) throw new Error('no follow_up rule: a follow-up exists only when the person\'s own rule says so');
  const lead = state.leads[key];
  if (!lead || !followUpCandidates(state, overlay, now).some((l) => l.key === key)) throw new Error('that lead is not due for a follow-up');
  const channel = lead.pick && lead.pick.channel;
  const first = channel && lead.drafts && lead.drafts[channel];
  if (!first) throw new Error('the first message is not on record');
  const c = contactedInfo(state, lead.personKey);
  const fuKey = `fu:${key}`;
  const fu = { ...lead, key: fuKey, status: 'reviewed', v: 1, statusAt: new Date(now).toISOString(), draft: undefined, drafts: undefined, pick: undefined, channelProposed: channel, identityRead: true, followUp: { of: key, days, firstText: first.text, at: c.at }, warnings: [] };
  delete fu.draft; delete fu.drafts; delete fu.pick;
  fu.hash = contentHash(fu);
  const problem = contactProblem(state, fu.personKey, { followUp: fu.followUp, now });
  if (problem) throw new Error(`refused: ${problem}`);
  state.leads[fuKey] = fu;
  return { key: fuKey, of: key, channel };
}

export function skipFollowUp(state, key) {
  const lead = state.leads[key];
  if (!lead) throw new Error(`unknown lead: ${key}`);
  lead.followUpSkipped = true;
  return { key, skipped: true };
}

// A reply on a social site, in the person's word: it ends any follow-up for good.
export function recordSocialReply(state, key, { optOut = false, now = Date.now() } = {}) {
  const lead = state.leads[key];
  if (!lead) throw new Error(`unknown lead: ${key}`);
  const c = contactedInfo(state, lead.personKey);
  if (!c) throw new Error('that person was not written to');
  for (const i of Object.keys(state.contacted)) if (state.contacted[i] === c) state.contacted[i] = { ...c, replied: true };
  if (lead.status === 'contacted') applyOp(state, { op: 'transition', key, to: 'replied', at: new Date(now).toISOString() });
  return { key, replied: true, optOut };
}

// One yes or no per due follow-up, four to a call.
export function followUpQuestions(state, overlay, now = Date.now()) {
  const list = followUpCandidates(state, overlay, now);
  const groups = [];
  for (let i = 0; i < list.length; i += 4) {
    const chunk = list.slice(i, i + 4);
    groups.push({
      keys: chunk.map((l) => l.key),
      questions: chunk.map((l, n) => q(`Follow-up ${i + n + 1}`.slice(0, 12), `Follow up once with ${(state.people[l.personKey] || {}).name || l.author || 'this person'} (${CHANNEL_LABEL[l.pick && l.pick.channel] || 'your first message'}, ${Math.floor((now - Date.parse(contactedInfo(state, l.personKey).at)) / DAY)} days ago, no reply)?`, [
        { label: 'Yes, write one (Recommended)', description: 'Writes one short follow-up and shows it with the usual pick.' },
        { label: 'No, leave it', description: 'No follow-up for this person.' },
      ])),
    });
  }
  return groups;
}
