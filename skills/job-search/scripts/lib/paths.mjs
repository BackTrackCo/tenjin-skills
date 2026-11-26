import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineApp, setApp } from '../../../loop-base/lib/app.mjs';
import * as base from '../../../loop-base/lib/paths.mjs';

// Job Search registers itself with the loop base on load; the base keeps its data in ~/.tenjin-skills/<name> from the manifest's name.
export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
setApp(defineApp({ skillDir: SKILL_DIR }));

export const { rootDir, stateDir, writingRulesPath, ensureDir, readJson, writeJsonAtomic } = base;
