import { registerCollector } from './work.mjs';
import { registerStep } from './watcher.mjs';
import { loadOverlay } from './overlay.mjs';
import { reviewItems, searchItems, searchStep } from './search.mjs';
import { approveItems, writeItems } from './outreach.mjs';
import { runIdentityReads } from './routed.mjs';
import { emailItems } from './email-items.mjs';
import { followUpItems } from './followup.mjs';
import { prepUnattended } from './email-prep.mjs';
import { readProfile } from './profile.mjs';
import { loadState } from './store.mjs';

// Everything the CLI adds to the work list and the watcher tick. Imported by gtm.mjs, so a command and the watcher always agree.
registerCollector(searchItems);
registerCollector(reviewItems);
registerStep('search', ({ profile, now, fetchImpl, routerClient }) => searchStep({ profile, overlay: loadOverlay(), fetchImpl, now, routerClient }));
registerCollector(writeItems);
registerCollector(approveItems);
// The profile reads of kept leads run in code once a search round is over, with Tenjin ready.
registerStep('reads', async ({ routerClient, now }) => {
  if (loadState().tenjin.status === 'ready') await runIdentityReads({ client: routerClient, now });
});
registerCollector(emailItems);
registerCollector(followUpItems);
// With the person's email consent current, emails are prepared and approved on the consent in code; the model only hands out.
registerStep('email', async ({ routerClient, now }) => {
  await prepUnattended({ profile: readProfile(), overlay: loadOverlay(), client: routerClient, now });
});
