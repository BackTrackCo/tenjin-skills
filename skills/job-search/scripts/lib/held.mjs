import { eeoTextOf } from './profile.mjs';
import { updateState } from './store.mjs';
import { unpark } from './work.mjs';

// A held job goes back in the queue in the next round after its question is answered:
// needs_facts when every missing fact is now in the profile, eeo_missing when the EEO choice is made.
export function resumeHeld(profile) {
  return updateState((s) => {
    let n = 0;
    for (const j of Object.values(s.jobs)) {
      if (!j.parked) continue;
      const r = j.parked.reasons;
      if (r.length === 1 && r[0] === 'needs_facts' && (j.missingFacts || []).every((k) => (profile.facts || {})[k] !== undefined && profile.facts[k] !== '')) {
        unpark(j);
        j.missingFacts = [];
        n++;
      } else if (r.length === 1 && r[0] === 'eeo_missing' && eeoTextOf(profile)) {
        unpark(j);
        n++;
      }
    }
    return n;
  });
}
