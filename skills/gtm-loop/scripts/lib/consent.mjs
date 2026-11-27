import { rulesHash } from './overlay.mjs';

// The email consent and the dry run, as in Job Search: a consent is bound to the hash of the person's sender facts and rules, so
// a change to either ends it. Code refuses to record one inside a batch (batch.mjs).
export const emailConsentCurrent = (state, profile, overlay) => Boolean(state.consent.email && state.consent.email.rulesHash === rulesHash(profile, overlay));

export function unattendedProblems(profile) {
  const bad = [];
  const s = profile.sender || {};
  if (!s.name) bad.push('no sender name');
  if (!s.postal) bad.push('no postal address');
  if (!(profile.offer && profile.offer.name)) bad.push('no offer');
  return bad;
}

export function recordEmailConsent(state, profile, overlay, now = Date.now()) {
  const bad = unattendedProblems(profile);
  if (bad.length) throw new Error(`the email consent needs: ${bad.join(', ')}`);
  state.consent.email = { rulesHash: rulesHash(profile, overlay), at: new Date(now).toISOString() };
  state.consentLog.push({ kind: 'email', at: state.consent.email.at });
  return state.consent.email;
}
export function revokeConsent(state, which = 'email') {
  if (which !== 'email') throw new Error('the only consent is email');
  state.consent.email = null;
  return { revoked: which };
}

// A dry run: an unattended round that records what it would have sent and sends nothing; the person reads it and confirms.
export function recordDryRun(state, record) {
  state.consent.dryRun.records.push(record);
  if (state.consent.dryRun.records.length > 100) state.consent.dryRun.records.splice(0, state.consent.dryRun.records.length - 100);
}
export function confirmDryRun(state, profile, overlay, now = Date.now()) {
  if (!state.consent.dryRun.records.length) throw new Error('no dry run to confirm: run an unattended round first');
  state.consent.dryRun.confirmedAt = new Date(now).toISOString();
  state.consent.dryRun.rulesHash = rulesHash(profile, overlay);
  return state.consent.dryRun;
}
export const dryRunDone = (state, profile, overlay) => Boolean(state.consent.dryRun.confirmedAt && state.consent.dryRun.rulesHash === rulesHash(profile, overlay));
export const consentStatus = (state, profile, overlay) => ({ email: emailConsentCurrent(state, profile, overlay), dryRun: dryRunDone(state, profile, overlay), problems: unattendedProblems(profile) });
