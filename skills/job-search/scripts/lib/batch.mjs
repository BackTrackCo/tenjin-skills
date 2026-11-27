import { graph } from '../../../loop-base/lib/graph.mjs';
import { extendApp } from '../../../loop-base/lib/app.mjs';
import * as base from '../../../loop-base/lib/batch.mjs';
import './paths.mjs';

// The batch (a record in the state, the stale rule, the open and close, the denied-command check) is the loop base's. Job Search declares
// the commands refused while a batch is open and what an opened batch records beyond its mode and times.
// Commands refused while a batch is open, whoever calls them: [command, sub-command or null for any].
export const BATCH_DENIED = [
  ['rules', 'add'], ['rules', 'remove'],
  ['consent', 'record'], ['writing', 'approve'], ['answer', 'add'], ['fact', 'set'],
  ['profile', 'set'], ['frequency', 'set'], ['start', 'record'], ['watch', 'remove'],
  ['dryrun', 'confirm'], ['batch', 'open'],
  ['release', 'apply'], ['intros', 'save'], ['contacts', 'count'], ['leads', 'save'], ['leads', 'mark'], ['email', 'approve'], ['email', 'mode'],
];
// Also refused while an unattended batch is open: nobody is there to say yes, so nothing may record one or loosen a stop.
export const UNATTENDED_DENIED = [
  ['approve', null], ['ask', 'approval'], ['facts', null], ['referral', null], ['fillonly', null], ['unpark', null], ['chrome', 'set'],
  ['sheet', 'build'], ['eeo', 'set'], ['eeo', 'add'], ['eeo', 'skip'], ['eeo', 'answer'], ['agree', null], ['resume', 'set'],
];

// Hosts only from graph.json, so a page cannot widen them.
extendApp({ batch: { denied: BATCH_DENIED, unattendedDenied: UNATTENDED_DENIED, openExtras: () => ({ denied: graph().neverHosts }) } });

export const { STALE_MS, isBatchDenied, batchOf, batchExists, isStale, isActive, batchMode, openBatch, closeBatch, touchBatch, cleanupStale } = base;
