import path from 'node:path';
import { extendApp, getApp } from '../../../loop-base/lib/app.mjs';
import * as base from '../../../loop-base/lib/watcher.mjs';
import { checkRelease, recordRelease } from './release.mjs';
import { SKILL_DIR, readJson, stateDir } from './paths.mjs';
import { loadState, updateState } from './store.mjs';
import { loadOverlay } from './overlay.mjs';
import { persist, runSweep, sweepDue } from './sweep.mjs';
import { workList, unattendedBatchOpen } from './work.mjs';
import { frequencyOf } from '../../../loop-base/lib/schedule.mjs';
import { routedRounds } from './routed.mjs';
import { prepareInCode } from './prepare.mjs';
import { resolveBoardPosts } from './ingest.mjs';
import { hnDue, runHn } from './hn.mjs';
import { ycDue, runYc } from './yc.mjs';

const DAY = 86400000;

export const readProfile = () => readJson(path.join(stateDir(), 'profile.json'), {});

// Job Search's watcher steps, in today's order. The frame (the heartbeat, the wake rules, the claims, the host) is the loop base's.
// The sweep step has no catch: an error there ends the tick. The others hold their own failures as a held source and go on.
const held = (prefix, detail, extra) => (st) => { st.held = [...st.held.filter((h) => !String(h.detail).startsWith(prefix)), { reason: 'source_empty', detail }]; if (extra) extra(st); };
const STEPS = [
  { name: 'sweep', catch: false,
    due: ({ profile, now, firstTick }) => (profile.watch || []).length && sweepDue(loadState(), now, { hour: profile.sweepHour, firstTick, frequency: frequencyOf(profile) }),
    async run({ profile, now, fetchImpl }) { persist(await runSweep({ state: loadState(), profile, overlay: loadOverlay(), fetch: fetchImpl, now })); } },
  { name: 'hn', catch: true,
    due: ({ fetchImpl, profile, now }) => fetchImpl && hnDue(loadState(), profile, now),
    async run(c) { const r = await runHn({ fetch: c.fetchImpl, profile: c.profile, state: loadState(), budgetMs: c.hnBudgetMs || 60_000, sleep: c.sleep, clock: c.clock, now: c.now }); return { pending: Boolean(r && r.remaining > 0) }; }, // the round is not over: code is still reading
    onError: (e, c) => updateState(held('hn:', `hn: ${e.message}`, (st) => { st.hn = { ...(st.hn || {}), lastAt: new Date(c.now).toISOString() }; })) },
  { name: 'yc', catch: true,
    due: ({ fetchImpl, profile, now }) => fetchImpl && ycDue(loadState(), profile, now),
    async run(c) { const r = await runYc({ fetch: c.fetchImpl, profile: c.profile, state: loadState(), sleep: c.sleep, clock: c.clock, now: c.now }); return { pending: Boolean(r && r.remaining > 0) }; },
    onError: (e, c) => updateState(held('yc:', `yc: ${e.message}`, (st) => { st.yc = { ...(st.yc || {}), lastAt: new Date(c.now).toISOString() }; })) },
  // With Tenjin ready, the search rounds run in code, never inside an open unattended batch.
  { name: 'routed', catch: true,
    due: ({ fetchImpl, profile }) => fetchImpl && profile.search && profile.search.role && (loadState().tenjin || {}).status === 'ready' && !unattendedBatchOpen(),
    run: ({ profile, fetchImpl, now, routerClient }) => routedRounds({ profile, fetch: fetchImpl, now, client: routerClient }),
    onError: (e) => updateState(held('routed:run', `routed:run: ${e.message}`)) },
  { name: 'release', catch: false,
    due: ({ profile, fetchImpl, now }) => profile.updates !== false && fetchImpl && (!loadState().update.lastCheckAt || now - Date.parse(loadState().update.lastCheckAt) >= DAY),
    async run({ fetchImpl, runner, now }) { recordRelease(await checkRelease({ fetchImpl, runner, now }), now); } }, // the line goes to the report and the notify set, with no wake of its own
  // Mechanics in code before the work list is read: a post with a board link becomes a posting, and a sheet with no new
  // writing goes straight to apply_ready. Only what is left needs a model.
  { name: 'mechanics', catch: true,
    due: ({ fetchImpl }) => Boolean(fetchImpl),
    async run({ profile, fetchImpl, now }) { await resolveBoardPosts({ profile, overlay: loadOverlay(), fetch: fetchImpl, now }); await prepareInCode({ fetch: fetchImpl, profile }); },
    onError: (e) => updateState(held('code:', `code: ${e.message}`)) },
];

extendApp({
  steps: STEPS,
  watcher: {
    codeFiles: ['scripts/jobs.mjs', 'scripts/lib/watcher.mjs', 'scripts/lib/sweep.mjs', 'scripts/lib/work.mjs', 'scripts/lib/routed.mjs', 'scripts/lib/prepare.mjs', 'scripts/lib/ingest.mjs', '../loop-base/lib/watcher.mjs', '../loop-base/lib/work.mjs'],
    readProfile,
    blocking: /^(park|held|consent|facts|referral):/,
    rearm: 'run /job-search again to re-arm',
    commands: { work: 'J work --commit', watch: 'J watch' },
    // One line: the round's steps first (so a woken model that has only this line knows the last one), then what is due.
    wakeLine: ({ counts, notify, newNotify }) => `Job Search round: run J work --commit --unattended (J is node ${path.join(SKILL_DIR, 'scripts', 'jobs.mjs')}), handle each item, then start J watch last with run_in_background. Due: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'waiting on you'}${newNotify ? `; notify: ${notify}` : ''}.`,
  },
  work: { ...getApp().work, list: (o) => workList(o), roundMark: (s) => `${s.sweep.lastAt || ''}|${(s.routed || {}).lastSearchAt || ''}|${(s.hn || {}).lastAt || ''}|${(s.yc || {}).lastAt || ''}` },
});

export const watcherCodeHash = base.codeHash;
export const { tick, runWatcher } = base;
