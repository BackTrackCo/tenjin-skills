// Child process for the two-writer test: writes N ops through the store.
import { applyOps } from '../../../skills/job-search/scripts/lib/store.mjs';
const [tag, n] = process.argv.slice(2);
for (let i = 0; i < Number(n); i++) applyOps([{ op: 'answer', label: `${tag} ${i}`, value: String(i) }]);
