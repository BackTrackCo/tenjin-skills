import { registerCollector } from './work.mjs';
import { registerStep } from './watcher.mjs';
import { loadOverlay } from './overlay.mjs';
import { reviewItems, searchItems, searchStep } from './search.mjs';

// Everything the CLI adds to the work list and the watcher tick. Imported by gtm.mjs, so a command and the watcher always agree.
registerCollector(searchItems);
registerCollector(reviewItems);
registerStep('search', ({ profile, now, fetchImpl, routerClient }) => searchStep({ profile, overlay: loadOverlay(), fetchImpl, now, routerClient }));
