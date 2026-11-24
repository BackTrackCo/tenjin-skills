import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './paths.mjs';

// data/employers.tsv: ats, region, board, name. From career-ops (CC BY 4.0), see data/NOTICE.md.
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
let rows;
function load(file) {
  const text = fs.readFileSync(file || path.join(SKILL_DIR, 'data', 'employers.tsv'), 'utf8');
  return text.split('\n').filter(Boolean).map((l) => {
    const [ats, region, board, name] = l.split('\t');
    return { ats, region: region || 'us', token: board, name };
  });
}

export function lookupEmployer(name, { ats, file } = {}) {
  rows = file ? load(file) : (rows ||= load());
  const n = norm(name);
  let hits = rows.filter((r) => norm(r.name) === n || norm(r.token) === n);
  if (ats) hits = hits.filter((r) => r.ats === ats);
  return hits;
}
