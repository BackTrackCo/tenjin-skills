import { getApp } from './app.mjs';

// The report frame. The app declares its sections: report: { sections(ctx) -> [segment], ruleText(rule) }, where a segment is an array of
// lines or { shared: 'rules' | 'lessons' | 'updates' | 'consent' }. The base joins the segments in order and renders each shared
// section the same way for every app: the person's rules in their own words, the lessons the app learned, the update lines and the
// consent changes. ctx is { state, overlay, since, now, profile, short }.
const decl = () => {
  const r = getApp().report;
  if (!r || typeof r.sections !== 'function') throw new Error(`the app ${getApp().name} has not declared its report sections`);
  return r;
};

const SHARED = {
  rules({ overlay, since }, ruleText) {
    const newRules = (overlay.rules || []).filter((r) => !since || r.date >= since.slice(0, 10));
    if (!newRules.length) return [];
    return ['', '## Rules (your words)', ...newRules.map((r) => `- ${r.date}: "${r.words}" (${ruleText(r)}) id ${r.id}`)];
  },
  lessons({ overlay, now }) {
    const lessons = (overlay.lessons || []).filter((l) => Date.parse(l.expires) > now);
    if (!lessons.length) return [];
    return ['', '## Lessons the skill learned (they only make it more careful)', ...lessons.map((l) => `- ${l.text} Expires ${l.expires.slice(0, 10)}. id ${l.id}`)];
  },
  updates({ state }) {
    if (!(state.updateLines && state.updateLines.length)) return [];
    return ['', '## Updates', ...state.updateLines.slice(-3).map((u) => `- ${u}`)];
  },
  // Every consent change and writing approval is visible: a line in the next report. The short report leaves out the undo hint.
  consent({ state, short }) {
    const consent = (state.consentLog || []).filter((c) => !c.acked);
    if (!consent.length) return [];
    return ['', '## Consent changes (check that each one was yours)', ...consent.map((c) => `- ${c.at.slice(0, 16).replace('T', ' ')}: ${c.what}.${short ? '' : ' Say so if this was not you; `consent revoke` undoes it.'}`)];
  },
};

export function renderReport(state, overlay, { since = null, now = Date.now(), profile = null, short = false } = {}) {
  const d = decl();
  const ctx = { state, overlay, since, now, profile: profile || {}, short };
  const ruleText = d.ruleText || ((r) => (r.value === null || r.value === undefined ? r.effect : `${r.effect} ${typeof r.value === 'object' ? JSON.stringify(r.value) : r.value}`));
  const out = [];
  for (const seg of d.sections(ctx)) {
    if (Array.isArray(seg)) out.push(...seg);
    else if (seg && SHARED[seg.shared]) out.push(...SHARED[seg.shared](ctx, ruleText));
    else throw new Error(`unknown report segment: ${JSON.stringify(seg)}`);
  }
  return out.join('\n');
}
