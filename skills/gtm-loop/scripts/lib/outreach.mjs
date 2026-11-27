import crypto from 'node:crypto';
import { applyOp } from './store.mjs';
import { contactProblem, markContacted } from './dedupe.mjs';
import { xReplyLink } from './open.mjs';
import { writeCandidates } from './writing.mjs';
import { q } from './questions.mjs';

// What happens after a draft exists: the pick (one question, the channel as the options), the page that opens in the person's own
// Chrome with the text on the clipboard, and the person's word that they sent it. The skill acts on none of the four sites.
export const CHANNEL_LABEL = { x_reply: 'Reply on X', x_dm: 'Message on X', reddit_comment: 'Comment on Reddit', linkedin_comment: 'Comment on LinkedIn', linkedin_note: 'LinkedIn note', hn_reply: 'Reply on Hacker News', web_reply: 'Reply on the page', email: 'Email' };
export const SOCIAL = ['x_reply', 'x_dm', 'reddit_comment', 'linkedin_comment', 'linkedin_note', 'hn_reply', 'web_reply'];
const clip = (t, n) => String(t).replace(/\s+/g, ' ').slice(0, n);
const hashInt = (s) => parseInt(crypto.createHash('sha256').update(s).digest('hex').slice(0, 8), 16);

// ---- the work list --------------------------------------------------------------------------------------------------
export const writeItems = ({ state }) => {
  const list = writeCandidates(state);
  return list.length ? [{ key: 'write', reason: 'write_due', v: hashInt(list.map((l) => `${l.key}:${l.v}`).sort().join('|')), count: list.length }] : [];
};
// Drafts are parked in a Markdown file: nothing asks and nothing waits. The item only feeds the one notify line.
export const approveItems = ({ state }) => {
  const list = Object.values(state.leads).filter((l) => l.status === 'drafted');
  return list.length ? [{ key: 'approve', reason: 'approve_due', v: hashInt(list.map((l) => `${l.key}:${l.v}`).sort().join('|')), count: list.length, waitsForPerson: true }] : [];
};
// Replies the person approved in the file: opened only in an attended turn, on their word.
export const openItems = ({ state }) => {
  const list = Object.values(state.leads).filter((l) => l.status === 'picked' && l.pick && l.pick.by === 'file' && l.pick.channel !== 'email');
  return list.length ? [{ key: 'open', reason: 'open_due', v: hashInt(list.map((l) => l.key).sort().join('|')), count: list.length, waitsForPerson: true }] : [];
};

// ---- the pick question ----------------------------------------------------------------------------------------------
// Up to four leads per call, one question each; each lead's options are the channels it has a draft for, then skip.
export function pickQuestions(state, { notes = {} } = {}) {
  const leads = Object.values(state.leads).filter((l) => l.status === 'drafted');
  const groups = [];
  for (let i = 0; i < leads.length; i += 4) {
    const chunk = leads.slice(i, i + 4);
    const questions = chunk.map((l, n) => {
      const channels = Object.keys(l.drafts || {}).slice(0, 2);
      const first = l.channelProposed && channels.includes(l.channelProposed) ? l.channelProposed : channels[0];
      const ordered = [first, ...channels.filter((c) => c !== first)];
      const who = (state.people[l.personKey] || {}).name || l.author || 'Someone';
      const d = l.drafts[first];
      const options = ordered.map((c, k) => ({ label: `${CHANNEL_LABEL[c]}${k === 0 ? ' (Recommended)' : ''}`, description: clip(`${l.drafts[c].text}${notes[c] ? ` ${notes[c]}` : ''}`, 110) || 'Draft ready.' }));
      options.push({ label: 'Skip', description: 'Leave this lead; nothing is sent.' });
      return q(`Lead ${i + n + 1}`.slice(0, 12), `${who} on ${l.source}: ${clip(l.line || l.quote || 'a lead', 120)} Draft: "${clip(d.text, 140)}" How should it go?`, options);
    });
    groups.push({ questions, keys: chunk.map((l) => l.key), labels: Object.fromEntries(chunk.map((l) => [l.key, Object.fromEntries(Object.keys(l.drafts).map((c) => [CHANNEL_LABEL[c], c]))])) });
  }
  return groups;
}

// ---- the pick -------------------------------------------------------------------------------------------------------
// Suppression and the contacted ledger are checked again here, at approval.
export function pickLead(state, key, channel, now = Date.now()) {
  const lead = state.leads[key];
  if (!lead) throw new Error(`unknown lead: ${key}`);
  if (lead.status !== 'drafted') throw new Error(`the lead is ${lead.status}, not drafted`);
  if (channel === 'skip') {
    applyOp(state, { op: 'transition', key, to: 'skipped', reason: 'the person skipped it' });
    return { key, status: 'skipped' };
  }
  if (!lead.drafts || !lead.drafts[channel]) throw new Error(`no draft for ${channel}; the lead has ${Object.keys(lead.drafts || {}).join(', ')}`);
  const problem = contactProblem(state, lead.personKey, { followUp: lead.followUp || null, now });
  if (problem) {
    if (problem.startsWith('suppressed')) applyOp(state, { op: 'transition', key, to: 'suppressed' });
    throw new Error(`refused: ${problem}`);
  }
  lead.pick = { channel, at: new Date(now).toISOString() };
  applyOp(state, { op: 'transition', key, to: 'picked', at: lead.pick.at });
  return { key, status: 'picked', channel };
}

// ---- open and sent --------------------------------------------------------------------------------------------------
const idOf = (state, lead, prefix) => ((state.people[lead.personKey] || {}).ids || []).find((i) => i.startsWith(prefix));
export function pageFor(state, lead, channel, text) {
  switch (channel) {
    case 'x_reply': return xReplyLink(lead.url, text);
    case 'x_dm': {
      const h = idOf(state, lead, 'x:');
      if (!h) throw new Error('no X handle for this person');
      return `https://x.com/${h.slice(2)}`;
    }
    case 'linkedin_note': {
      const s = idOf(state, lead, 'linkedin:');
      return s ? `https://www.linkedin.com/in/${s.slice(9)}` : lead.url;
    }
    case 'reddit_comment': case 'linkedin_comment': case 'hn_reply': case 'web_reply': return lead.url;
    default: throw new Error(`${channel} does not open a page`);
  }
}

export function openPlan(state, key, now = Date.now()) {
  const lead = state.leads[key];
  if (!lead) throw new Error(`unknown lead: ${key}`);
  const problem = contactProblem(state, lead.personKey, { followUp: lead.followUp || null, now });
  if (problem && ['picked', 'suppressed'].includes(lead.status)) throw new Error(`refused: ${problem}`);
  if (lead.status !== 'picked') throw new Error('the lead is not picked');
  const channel = lead.pick.channel;
  if (!SOCIAL.includes(channel)) throw new Error('an email does not open a page: use G email next');
  const d = lead.drafts[channel];
  return { key, channel, text: d.text, url: pageFor(state, lead, channel, d.text) };
}

export function markSentSocial(state, key, now = Date.now()) {
  const lead = state.leads[key];
  if (!lead) throw new Error(`unknown lead: ${key}`);
  const problem = contactProblem(state, lead.personKey, { followUp: lead.followUp || null, now });
  if (problem && ['picked', 'suppressed'].includes(lead.status)) throw new Error(`refused: ${problem}`);
  if (lead.status !== 'picked') throw new Error('the lead is not picked');
  const channel = lead.pick.channel;
  if (!SOCIAL.includes(channel)) throw new Error('an email is marked with G email sent');
  applyOp(state, { op: 'transition', key, to: 'contacted', at: new Date(now).toISOString() });
  markContacted(state, lead.personKey, { channel, leadKey: key, followUp: Boolean(lead.followUp), now });
  state.outreach.push({ at: new Date(now).toISOString(), key, personKey: lead.personKey, channel });
  if (state.outreach.length > 1000) state.outreach.splice(0, state.outreach.length - 1000);
  return { key, status: 'contacted', channel };
}
