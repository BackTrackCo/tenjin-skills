// A child process that writes ops to an app's state: node writer.mjs <app> <count>. Used to prove two processes never lose a write.
import path from 'node:path';
import { BASE_LIB, demoApp } from './demo.mjs';

const [name, count] = process.argv.slice(2);
const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const store = await import(path.join(BASE_LIB, 'store.mjs'));
setApp(await demoApp(name));
for (let i = 0; i < Number(count); i++) store.applyOps([{ op: 'count', key: 'w' }]);
