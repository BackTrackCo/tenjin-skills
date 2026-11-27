import { graph } from './graph.mjs';
import { addPosts, contactProblem } from './dedupe.mjs';
import { applyOp } from './store.mjs';
import { capOf, ruleValue } from './overlay.mjs';
import { centsOf } from './prices.mjs';

// The shape checks for the two files a model step writes: the post file (the free web-search step) and the review file. Code
// refuses a file with a problem and names it, and the step rewrites the file. Nothing in a file is trusted as an instruction.
const SOURCES = ['x', 'reddit', 'linkedin', 'hn', 'web'];
const isHttps = (u) => typeof u === 'string' && /^https:\/\/\S+$/.test(u);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

export function checkPostFile(obj, profile = {}) {
  const bad = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['the file must be a JSON object'];
  if (obj.status !== 'fulfilled') bad.push('status must be "fulfilled"');
  if (!Array.isArray(obj.posts)) return [...bad, 'posts must be a list'];
  if ((profile.phrases || []).length && !(profile.phrases || []).includes(obj.phrase)) bad.push('phrase must be one of the person\'s phrases');
  obj.posts.forEach((p, i) => {
    const at = `posts[${i}]`;
    if (!p || typeof p !== 'object') return bad.push(`${at}: not an object`);
    if (!isHttps(p.url)) bad.push(`${at}: url must be an https link`);
    if (!SOURCES.includes(p.source)) bad.push(`${at}: source must be one of ${SOURCES.join(', ')}`);
    if (typeof p.text !== 'string' || !p.text.trim()) bad.push(`${at}: text is required`);
    if (p.author !== undefined && typeof p.author !== 'string') bad.push(`${at}: author must be text`);
    if (p.postedAt !== undefined && p.postedAt !== null && Number.isNaN(Date.parse(p.postedAt))) bad.push(`${at}: postedAt must be a date`);
  });
  return bad;
}

// A post file in: one phrase, one source mix, the cost if the router ran it.
export function ingestPostFile(state, obj, { profile, overlay, now = Date.now() }) {
  const roundCap = capOf(overlay, 'leads_per_round');
  const left = roundCap === null ? null : Math.max(0, roundCap - ((state.search || {}).roundAdded || 0));
  const r = addPosts(state, obj.posts, { profile, overlay, phrase: obj.phrase || null, now, cap: left });
  state.search.roundAdded = ((state.search || {}).roundAdded || 0) + r.added.length;
  const y = (state.phraseYield[obj.phrase || '(none)'] ||= {});
  for (const k of r.added) y[state.leads[k].source] = (y[state.leads[k].source] || 0) + 1;
  if (obj.cost) state.spend.push({ at: new Date(now).toISOString(), kind: obj.need || 'web_search', cents: centsOf(obj.cost), cost: String(obj.cost), leads: r.added.length });
  return r;
}

const CHANNELS_BY_SOURCE = {
  x: ['x_reply', 'x_dm', 'email'],
  reddit: ['reddit_comment', 'email'],
  linkedin: ['linkedin_comment', 'linkedin_note', 'email'],
  hn: ['hn_reply', 'email'],
  web: ['email'],
  people: ['linkedin_note', 'email', 'x_dm'],
};
export const channelsFor = (lead) => CHANNELS_BY_SOURCE[lead.source] || ['email'];

export const reviewHandout = (state, limit = graph().reviewBatch) => {
  const keys = Object.values(state.leads).filter((l) => l.status === 'new').slice(0, limit).map((l) => l.key);
  state.reviewHand = keys;
  return keys.map((k) => {
    const l = state.leads[k];
    return { key: k, source: l.source, kind: l.kind, author: l.author, postedAt: l.postedAt, text: l.text, phrase: l.phrase, channels: channelsFor(l) };
  });
};

export function checkReview(obj, state) {
  const bad = [];
  if (!obj || !Array.isArray(obj.reviews)) return ['reviews must be a list'];
  const hand = state.reviewHand || [];
  const seen = new Set();
  obj.reviews.forEach((r, i) => {
    const at = `reviews[${i}]`;
    const lead = r && state.leads[r.key];
    if (!lead) return bad.push(`${at}: unknown lead ${r && r.key}`);
    if (!hand.includes(r.key)) bad.push(`${at}: the lead was not handed out for review`);
    seen.add(r.key);
    for (const f of ['fit', 'intent', 'timing']) if (!(typeof r[f] === 'number' && r[f] >= 0 && r[f] <= 100)) bad.push(`${at}: ${f} must be 0 to 100`);
    if (typeof r.keep !== 'boolean') bad.push(`${at}: keep must be true or false`);
    if (typeof r.line !== 'string' || !r.line.trim() || r.line.length > 240) bad.push(`${at}: line is one short sentence (240 characters at most)`);
    if (r.channel !== undefined && r.channel !== null && !channelsFor(lead).includes(r.channel)) bad.push(`${at}: channel must be one of ${channelsFor(lead).join(', ')}`);
    if (r.keep === true && !r.channel) bad.push(`${at}: a kept lead needs a channel`);
    // The quote is the exact words that make it a lead: code checks it against the post. A fit lead with no recent post has none.
    if (lead.kind === 'fit' && !lead.text) {
      if (r.quote) bad.push(`${at}: a fit lead with no post has no quote`);
    } else if (!r.injection_suspected && r.quote !== null && r.quote !== undefined) {
      if (typeof r.quote !== 'string' || r.quote.trim().length < 8 || !norm(lead.text).includes(norm(r.quote))) bad.push(`${at}: quote must be words that appear in the post`);
    } else if (!r.injection_suspected) bad.push(`${at}: quote is required`);
  });
  for (const k of hand) if (!seen.has(k)) bad.push(`lead ${k} was handed out and has no review`);
  return bad;
}

// The review, in code: scores, then the status. Below the person's own min_score a lead is skipped; a post that addresses an agent is
// stopped. Anyone suppressed or contacted since the lead was found is dropped now (suppression is checked at review).
export function applyReview(state, obj, { overlay = { rules: [] }, now = Date.now() } = {}) {
  const min = ruleValue(overlay, 'min_score');
  const out = { kept: [], skipped: [], stopped: [], suppressed: [] };
  for (const r of obj.reviews) {
    const lead = state.leads[r.key];
    const problem = contactProblem(state, lead.personKey, { now });
    if (problem) {
      if (lead.status === 'new') applyOp(state, { op: 'transition', key: lead.key, to: 'suppressed' });
      out.suppressed.push(lead.key);
      continue;
    }
    if (r.injection_suspected) {
      applyOp(state, { op: 'warn', key: lead.key, warning: 'injection_suspected' });
      applyOp(state, { op: 'transition', key: lead.key, to: 'stopped' });
      out.stopped.push(lead.key);
      continue;
    }
    applyOp(state, { op: 'rank', key: lead.key, fit: r.fit, intent: r.intent, timing: r.timing, line: r.line, quote: r.quote, channel: r.channel || null });
    if (!r.keep || (min !== undefined && state.leads[lead.key].scores.avg < Number(min))) {
      applyOp(state, { op: 'transition', key: lead.key, to: 'skipped', reason: r.keep ? 'below_min_score' : 'review_leave' });
      out.skipped.push(lead.key);
    } else {
      applyOp(state, { op: 'transition', key: lead.key, to: 'reviewed', at: new Date(now).toISOString() });
      out.kept.push(lead.key);
    }
  }
  state.reviewHand = [];
  return out;
}
