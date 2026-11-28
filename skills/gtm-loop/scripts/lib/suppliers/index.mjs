import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The default mappings: what each service the skill has seen answers and takes, as plain data (defaults.json). This is the only
// place a service host appears; it never appears in text people see. A mapping is {need, hosts, input, output, noCache?, any?}.
// A service with no entry here reads through the generic reader, and a person's repaired mappings (repairs.mjs) win over these.
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'defaults.json');
let DEFAULTS;
export const defaults = () => (DEFAULTS ||= JSON.parse(fs.readFileSync(FILE, 'utf8')));

// The default for a need, by the host the router's spec names; an entry marked `any` is the fallback for a need whose service is not
// listed (company and enrichment answers differ little between sellers). The seller id is the matched host, else null.
export function defaultFor(kind, specText) {
  const lower = String(specText).toLowerCase();
  const rows = defaults().filter((d) => d.need === kind);
  const hit = rows.find((d) => !d.any && d.hosts.some((h) => lower.includes(h)));
  if (hit) return { ...hit, seller: hit.hosts.find((h) => lower.includes(h)) };
  const any = rows.find((d) => d.any);
  return any ? { ...any, seller: null } : null;
}

// Does any default of this need carry the no-cache flag for this seller: the answer is never saved.
export const noCacheFor = (kind, seller) => defaults().some((d) => d.need === kind && d.noCache && (d.any || d.hosts.includes(seller)));
