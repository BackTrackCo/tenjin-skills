import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './paths.mjs';

let cached;
export function graph() {
  cached ||= JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'graph.json'), 'utf8'));
  return cached;
}
