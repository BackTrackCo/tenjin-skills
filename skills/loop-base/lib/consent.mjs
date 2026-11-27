import { getApp } from './app.mjs';
import { canonical, sha } from './hash.mjs';
import { rulesHash } from './rules.mjs';

// Consents, recorded only from the person's own yes. The app declares them:
//   consents: { kinds: ['unattended', 'writing', 'email'], problems(profile), limitsOf(overlay), loosened(was, now), writingScope }
// `problems` says what is missing before the main consent can be recorded; `limitsOf` and `loosened` say what limits the consent was
// given under and whether the current ones are looser (a looser limit needs a new consent). The state carries `consent: { unattended,
// writing, email, dryRun }`. This file is a gate file for every app that uses it.
const decl = () => {
  const c = getApp().consents;
  if (!c || !Array.isArray(c.kinds)) throw new Error(`the app ${getApp().name} has not declared its consents`);
  return c;
};

// Only an attended yes records it, and only with the person's choice for optional writing fields:
// skip leaves them out, wait holds the job for the person. There is no default.
export function recordConsent(state, profile, overlay, now = Date.now(), optionalWriting) {
  const d = decl();
  const problems = d.problems(profile);
  if (problems.length) throw new Error(`cannot record consent: ${problems.join('; ')}`);
  if (!['skip', 'wait'].includes(optionalWriting)) throw new Error('the person picks skip or wait for optional writing fields; there is no default');
  // Limits that only tighten stay out of the hash, but the consent remembers the limits it was given under: removing or
  // raising the positions rule, or removing a fill-only rule, loosens an unattended run and needs a new consent.
  state.consent.unattended = { rulesHash: rulesHash(profile, overlay), at: new Date(now).toISOString(), optionalWriting, limits: d.limitsOf(overlay) };
  state.consent.dryRun = { records: [], confirmedAt: null, rulesHash: null };
  return state.consent.unattended;
}

// Writing consent is separate from the unattended consent: it covers new writing in an unattended submit.
// It is bound to the writing scope and the person's writing rules, so a changed rule makes it stale.
export const writingHash = (rulesText = '') => sha(canonical({ scope: decl().writingScope, rules: String(rulesText).trim() }));
export function recordWritingConsent(state, rulesText = '', now = Date.now()) {
  state.consent.writing = { at: new Date(now).toISOString(), hash: writingHash(rulesText) };
  return state.consent.writing;
}
export function writingConsentCurrent(state, rulesText = '') {
  return Boolean(state.consent.writing && state.consent.writing.hash === writingHash(rulesText));
}
export function revokeConsent(state, which) {
  const { kinds } = decl();
  if (!kinds.includes(which)) throw new Error(`revoke ${kinds.slice(0, -1).join(', ')} or ${kinds[kinds.length - 1]}`);
  state.consent[which] = null;
}

export function consentStatus(state, profile, overlay) {
  const d = decl();
  const c = state.consent.unattended;
  if (!c) return { ok: false, reason: 'no_consent' };
  if (c.rulesHash !== rulesHash(profile, overlay) || d.loosened(c.limits, d.limitsOf(overlay))) return { ok: false, reason: 'rules_changed' };
  return { ok: true };
}

export function recordDryRun(state, record) {
  state.consent.dryRun.records.push({ ...record, submitted: false });
}
export function confirmDryRun(state, profile, overlay, now = Date.now()) {
  if (!consentStatus(state, profile, overlay).ok) throw new Error('record the unattended consent first');
  if (!state.consent.dryRun.records.length) throw new Error('the dry run has no records to review');
  state.consent.dryRun.confirmedAt = new Date(now).toISOString();
  state.consent.dryRun.rulesHash = rulesHash(profile, overlay);
}
export const dryRunDone = (state, profile, overlay) => Boolean(state.consent.dryRun.confirmedAt && state.consent.dryRun.rulesHash === rulesHash(profile, overlay));
