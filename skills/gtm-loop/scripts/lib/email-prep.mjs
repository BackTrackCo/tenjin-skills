import { RouterClient } from './router.mjs';
import { loadState, updateState } from './store.mjs';
import { emailConsentCurrent } from './consent.mjs';
import { approveEmail } from './email.mjs';
import { resolveAddress } from './lookup.mjs';

// Unattended email: with the person's consent current, an email lead that review proposed for email and the writer drafted is
// resolved (a published address, or the lookup and check) and approved on the consent. The gates run again at handout. Without
// the consent nothing is approved here, so an unattended turn can only make drafts of what a person approved earlier.
export async function prepUnattended({ profile, overlay, client = new RouterClient(), now = Date.now(), save }) {
  const st = loadState();
  if (!emailConsentCurrent(st, profile, overlay)) return { skipped: 'no email consent' };
  const out = { approved: [], skipped: [] };
  const todo = Object.values(st.leads).filter((l) => l.status === 'drafted' && l.channelProposed === 'email' && l.drafts && l.drafts.email && !l.followUp);
  for (const l of todo) {
    try {
      if (!l.emailFromPost && st.tenjin.status === 'ready') await resolveAddress({ leadKey: l.key, client, now, save });
      updateState((s) => approveEmail(s, s.leads[l.key], profile, { by: 'consent', now }));
      out.approved.push(l.key);
    } catch (e) {
      out.skipped.push({ key: l.key, why: e.message });
    }
  }
  return out;
}
