import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './paths.mjs';

// Which code recorded a line: the manifest version and a hash of every script and graph.json. A line recorded by older code is stale
// once the skill is updated, and what the older code was refused for is tried again by the new one.
let cached;
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
export function codeId() {
  if (cached) return cached;
  const h = crypto.createHash('sha256');
  for (const f of walk(path.join(SKILL_DIR, 'scripts')).filter((x) => x.endsWith('.mjs')).sort()) h.update(fs.readFileSync(f));
  h.update(fs.readFileSync(path.join(SKILL_DIR, 'graph.json')));
  let version = '0';
  try { version = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'manifest.json'), 'utf8')).version; } catch {}
  cached = `${version}+${h.digest('hex').slice(0, 12)}`;
  return cached;
}

// A refusal of the skill's own request (the router said the input is wrong, or code could not build or read it) is the old code's
// defect, not a fact about the person: the new code asks again. Everything else (a limit, an approval, a busy provider) stays.
export const REFUSED_BY_CODE = ['needs_input', 'no_input', 'schema_failure'];

export function dropStaleHolds(state) {
  const now = codeId();
  const dropped = (state.held || []).filter((h) => h.codeId !== now && REFUSED_BY_CODE.includes(h.status));
  if (!dropped.length) return 0;
  state.held = state.held.filter((h) => !dropped.includes(h));
  return dropped.length;
}
export const staleHoldsLine = (n) => (n ? `${n} search${n === 1 ? '' : 'es'} that an older version of this skill held (its own request was refused) ${n === 1 ? 'runs' : 'run'} again at the next round.` : null);
