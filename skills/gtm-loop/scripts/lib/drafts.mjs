import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { graph } from './graph.mjs';
import { stateDir, ensureDir } from './paths.mjs';
import { applyOp } from './store.mjs';
import { offerOfLead } from './offers.mjs';
import { pickLead, CHANNEL_LABEL } from './outreach.mjs';
import { addressFor, buildCandidate, approveEmail, buildFooter } from './email.mjs';
import { contactProblem } from './dedupe.mjs';
import { wordsIn } from './queries.mjs';

// The drafts are parked in a dated Markdown file for the person to read and edit on their own time. Nothing waits on them: no question
// is asked, and the watcher starts again at once. `G drafts sync` reads the person's marks back. Only two kinds of line count in a
// section: its `Channel:` line and its `Decision:` line, both outside any blockquote and any fenced block; the edited text of the
// fenced block of the chosen channel is the message. A post is quoted with every control-like line escaped, and a quoted line is never
// read, so a post cannot approve itself.
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const idOf = (key) => sha(`draft:${key}`).slice(0, 10);
const day = (now) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function draftsDir(profile) {
  const dir = profile && profile.drafts && profile.drafts.dir ? profile.drafts.dir : path.join(stateDir(), 'drafts');
  return dir;
}
export function checkDraftsDir(dir) {
  const p = path.resolve(String(dir));
  let st;
  try { st = fs.statSync(p); } catch { throw new Error(`${p} does not exist`); }
  if (!st.isDirectory()) throw new Error(`${p} is not a folder`);
  try { fs.accessSync(p, fs.constants.W_OK); } catch { throw new Error(`${p} is not writable`); }
  return p;
}
export const draftsFile = (profile, now) => path.join(draftsDir(profile), `${day(now)}.md`);

// ---- writing ---------------------------------------------------------------------------------------------------------
// One line of a post or a profile, safe to show: control words, checkboxes, backticks and headings lose their meaning.
export function esc(line) {
  return String(line)
    .replace(/`/g, "'")
    .replace(/\[[ xX]\]/g, '(box)')
    .replace(/^(\s*)(Decision|Channel|Draft|Outcome|Note|Allowed|Subject)\b/i, '$1\\$2')
    .replace(/^(\s*)(#+)/, '$1\\$2')
    .replace(/\(id:\s*[0-9a-f]{6,}\)/gi, '(id removed)');
}
const quote = (text, max = 400) => {
  const cut = String(text).replace(/\r/g, '').slice(0, max) + (String(text).length > max ? ' ...' : '');
  return cut.split('\n').map((l) => `> ${esc(l)}`).join('\n');
};
const fenceFor = (text) => '`'.repeat(Math.max(3, (String(text).match(/`+/g) || []).reduce((n, r) => Math.max(n, r.length), 0) + 1));
const block = (text) => { const f = fenceFor(text); return `${f}text\n${String(text).replace(/\r/g, '')}\n${f}`; };
const authorOf = (state, l) => {
  if (l.source === 'x') return l.author ? `@${l.author}` : '';
  if (l.source === 'reddit') return l.author ? `u/${l.author}` : '';
  const p = state.people[l.personKey] || {};
  return esc(p.name || l.author || '');
};

export function sectionFor(state, profile, lead, n) {
  const id = idOf(lead.key);
  const drafts = lead.drafts || {};
  const channels = Object.keys(drafts);
  const first = lead.channelProposed && drafts[lead.channelProposed] ? lead.channelProposed : channels[0];
  const offer = offerOfLead(profile, lead);
  const out = [
    `## ${n}. ${CHANNEL_LABEL[first] || first} (id: ${id})`,
    '',
    `- Source: ${lead.url}`,
    `- Author: ${authorOf(state, lead)}`,
    `- Offer: ${esc(offer.name || offer.id)}`,
    `- Why: ${esc(lead.line || lead.quote || '')}`,
  ];
  const a = drafts.email ? addressFor(state, lead) : null;
  if (a && a.addr) out.push(`- Email to: ${a.addr} (${a.source === 'post' ? 'published by them' : 'found and checked'}); the footer is added by code`);
  out.push('', quote(lead.text || '(no post: found by search)'), '', `Channel: ${first}`, `Allowed: ${channels.join(', ')}`);
  for (const c of [first, ...channels.filter((x) => x !== first)]) {
    const d = drafts[c];
    out.push('', `Draft (${c}):`, '', block(c === 'email' ? `Subject: ${d.subject || ''}\n\n${d.text}` : d.text));
  }
  out.push('', 'Decision: [ ] send  [ ] skip', '');
  return { id, text: out.join('\n') };
}

// New sections are appended to the day's file. A section that exists is never touched, whoever edited it.
export function writeDrafts(state, profile, now = Date.now()) {
  const dir = draftsDir(profile);
  ensureDir(dir);
  const file = draftsFile(profile, now);
  const exists = fs.existsSync(file);
  const cur = exists ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set([...cur.matchAll(/^## .*\(id: ([0-9a-f]{10})\)\s*$/gm)].map((m) => m[1]));
  let n = have.size;
  const adds = [];
  state.draftIds ||= {};
  for (const l of Object.values(state.leads).filter((x) => x.status === 'drafted' && x.drafts && Object.keys(x.drafts).length)) {
    const id = idOf(l.key);
    state.draftIds[id] = l.key;
    if (have.has(id) || l.draftFile) continue;
    n += 1;
    const sec = sectionFor(state, profile, l, n);
    adds.push(sec.text);
    l.draftFile = file;
    if (l.drafts.email) { const a = addressFor(state, l); l.draftedTo = a.addr || null; }
  }
  if (!adds.length) return { file, added: 0, total: have.size };
  const head = exists ? '' : `# Drafts for ${day(now)}\n\nRead and edit these on your own time. For each: edit the text in its fenced block, optionally change the \`Channel:\` line to another allowed channel, then tick \`send\` or \`skip\` on its \`Decision:\` line. Nothing is sent until you say you reviewed them (or the next start) and the skill reads your marks. Only the \`Channel:\` and \`Decision:\` lines and the fenced text count; the quoted post never does.\n\n`;
  fs.writeFileSync(file, `${cur}${head}${adds.join('\n')}`, { mode: 0o600 });
  return { file, added: adds.length, total: have.size + adds.length };
}

// ---- reading ---------------------------------------------------------------------------------------------------------
// Sections by their id. Lines inside a blockquote or a fenced block are never read as controls.
export function parseSections(text) {
  const lines = String(text).split('\n');
  const secs = [];
  let cur = null;
  let fence = null;
  let label = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      if (line.trim() === fence.marker) { cur && label && (cur.fences[label] = fence.body.join('\n')); fence = null; label = null; } else fence.body.push(line);
      continue;
    }
    const h = /^## .*\(id: ([0-9a-f]{10})\)\s*$/.exec(line);
    if (h) { cur = { id: h[1], start: i, channel: null, decision: null, decisionLine: null, outcome: false, noteLine: null, fences: {}, allowed: [] }; secs.push(cur); label = null; continue; }
    if (!cur) continue;
    if (line.startsWith('>')) continue;
    const f = /^(`{3,}|~{3,})/.exec(line);
    if (f) { fence = { marker: f[1], body: [] }; continue; }
    const dl = /^Draft \(([a-z_]+)\):\s*$/.exec(line);
    if (dl) { label = dl[1]; continue; }
    const ch = /^Channel:\s*([a-z_]+)\s*$/.exec(line);
    if (ch && cur.channel === null) { cur.channel = ch[1]; continue; }
    const al = /^Allowed:\s*(.*)$/.exec(line);
    if (al && !cur.allowed.length) { cur.allowed = al[1].split(',').map((x) => x.trim()).filter(Boolean); continue; }
    const dc = /^Decision:\s*\[( |x|X)\]\s*send\s+\[( |x|X)\]\s*skip\s*$/.exec(line);
    if (dc && cur.decision === null) { cur.decision = { send: dc[1] !== ' ', skip: dc[2] !== ' ' }; cur.decisionLine = i; continue; }
    if (/^Outcome:/.test(line)) { cur.outcome = true; continue; }
    if (/^Note \(code\):/.test(line)) cur.noteLine = i;
  }
  return secs;
}

const recent = (profile, now) => {
  const dir = draftsDir(profile);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).filter((f) => now - Date.parse(f.slice(0, 10)) < 30 * 86400000).sort().map((f) => path.join(dir, f));
};

const fenceText = (sec, channel) => (sec.fences[channel] === undefined ? null : sec.fences[channel]);
function splitSubject(raw) {
  const m = /^Subject:[ \t]*(.*)\n\n?([\s\S]*)$/.exec(raw);
  return m ? { subject: m[1].trim(), body: m[2].trim() } : { subject: null, body: raw.trim() };
}

// The person's yes for one lead and channel, with the text they edited. Returns the outcome line, or {note} when it is not ready.
function applySection(state, profile, lead, sec, now) {
  const channel = sec.channel || lead.channelProposed;
  const allowed = sec.allowed.length ? sec.allowed : Object.keys(lead.drafts || {});
  if (!allowed.includes(channel) || !(lead.drafts || {})[channel]) return { note: `the channel "${channel}" is not one of: ${allowed.join(', ')}. Change the Channel line and tick again.` };
  const raw = fenceText(sec, channel);
  if (raw === null || !raw.trim()) return { note: `the ${channel} draft block is empty or missing: put your text in its fenced block and tick again.` };
  const problem = contactProblem(state, lead.personKey, { followUp: lead.followUp || null, now });
  if (problem) { if (problem.startsWith('suppressed') && lead.status === 'drafted') applyOp(state, { op: 'transition', key: lead.key, to: 'suppressed' }); return { outcome: `no longer available: ${problem}. Nothing is sent.`, final: true }; }
  const g = graph().channels[channel];
  let subject = lead.drafts[channel].subject || null;
  let text = raw.trim();
  if (channel === 'email') {
    const s = splitSubject(raw);
    if (!s.subject) return { note: 'an email block starts with a "Subject: ..." line, then a blank line, then the text.' };
    subject = s.subject; text = s.body;
    if (subject.length > g.subjectMax) return { note: `the subject is ${g.subjectMax} characters at most.` };
    if (wordsIn(text).length > g.maxWords) return { note: `an email is ${g.maxWords} words at most (this is ${wordsIn(text).length}).` };
    if (/Reply stop and I will not write again/i.test(text) || /^--\s*$/m.test(text)) return { note: 'the footer and the opt-out line are added by code: take them out of the text.' };
  } else if (text.length > g.max) return { note: `${channel} is ${g.max} characters at most (this is ${text.length}): shorten it and tick again.` };
  lead.drafts[channel] = { ...lead.drafts[channel], text, subject, editedAt: new Date(now).toISOString() };
  if (lead.channelProposed === channel) lead.draft = lead.drafts[channel];
  if (lead.status !== 'drafted') return { outcome: `the lead is ${lead.status}: nothing more to do here.`, final: true };
  if (channel === 'email') {
    const a = addressFor(state, lead);
    if (!a.addr) return { note: `no address to send to yet (${a.problem}): ask the model to run G email resolve ${lead.key}.` };
    if (lead.draftedTo !== a.addr) return { note: `the address changed since this draft was written (${a.addr}): ask the model to run G ask email ${lead.key} for your yes on the exact address.` };
    let c;
    try { c = buildCandidate(state, lead, profile); buildFooter({ profile, lead, country: (state.people[lead.personKey] || {}).country || null, addressSource: a.source }); } catch (e) { return { note: e.message } ; }
    pickLead(state, lead.key, 'email', now);
    lead.pick.by = 'file';
    approveEmail(state, lead, profile, { expectId: c.id, by: 'file', now });
    return { outcome: 'send recorded for the email to ' + a.addr + ': the model sends it at its next turn with your Gmail tool (or makes a draft).', final: true };
  }
  pickLead(state, lead.key, channel, now);
  lead.pick.by = 'file';
  return { outcome: `send recorded for ${CHANNEL_LABEL[channel] || channel}: say "open them" in a turn with the skill and it opens the page; you press send.`, final: true };
}

export function syncDrafts(state, profile, now = Date.now()) {
  const results = [];
  let waiting = 0;
  for (const file of recent(profile, now)) {
    const text = fs.readFileSync(file, 'utf8');
    const secs = parseSections(text);
    const lines = text.split('\n');
    const inserts = []; // [lineIndex, newLine, replaceExisting]
    for (const sec of secs) {
      if (sec.outcome || sec.decision === null) continue;
      const key = (state.draftIds || {})[sec.id];
      const lead = key && state.leads[key];
      if (!lead) continue;
      const d = sec.decision;
      if (d.send && d.skip) { inserts.push([sec, 'Note (code): tick one box, not both.']); results.push({ id: sec.id, key: lead.key, note: 'both boxes' }); continue; }
      if (!d.send && !d.skip) { waiting += 1; continue; }
      let res;
      if (d.skip) {
        if (lead.status === 'drafted') applyOp(state, { op: 'transition', key: lead.key, to: 'skipped', reason: 'the person skipped it in the drafts file' });
        res = { outcome: 'skipped: the lead is left.', final: true };
      } else res = applySection(state, profile, lead, sec, now);
      if (res.final) { inserts.push([sec, `Outcome: ${res.outcome} (synced ${day(now)})`]); results.push({ id: sec.id, key: lead.key, outcome: res.outcome }); } else inserts.push([sec, `Note (code): ${res.note}`]), results.push({ id: sec.id, key: lead.key, note: res.note });
    }
    if (inserts.length) {
      for (const [sec, line] of inserts.sort((a, b) => b[0].decisionLine - a[0].decisionLine)) {
        if (line.startsWith('Note (code):') && sec.noteLine !== null) lines[sec.noteLine] = line;
        else lines.splice(sec.decisionLine + 1, 0, line);
      }
      fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
    }
  }
  return { synced: results.filter((r) => r.outcome).length, notes: results.filter((r) => r.note).length, waiting, results };
}

// Drafts with no decision yet, and approved replies waiting to be opened.
export const parked = (state) => Object.values(state.leads).filter((l) => l.status === 'drafted');
export const approvedReplies = (state) => Object.values(state.leads).filter((l) => l.status === 'picked' && l.pick && l.pick.by === 'file' && l.pick.channel !== 'email');
