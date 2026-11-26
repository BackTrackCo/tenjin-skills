import { extendApp } from '../../../loop-base/lib/app.mjs';
import * as base from '../../../loop-base/lib/release.mjs';
import { guardedFetch } from './net.mjs';
import './paths.mjs';

// Releases and gates come from the loop base. Job Search declares its repo, its name in text, and the writing skill it installs beside
// itself; the gate files are listed in manifest.json (`gateFiles`).
export const REPO = 'BackTrackCo/tenjin-skills';
export const SKILLS_CLI = 'skills@1.9.0';
extendApp({ release: { repo: REPO, displayName: 'Job Search', skillsCli: SKILLS_CLI, guardedFetch, companions: [{ skill: 'writing', manifestKey: 'writing', tagField: 'writingTag', previousField: 'previousWriting' }] } });

export const { cmpVer, gateSection, gatesHash, pickRelease, installCommands, checkRelease, applyUpdate, recordRelease } = base;
