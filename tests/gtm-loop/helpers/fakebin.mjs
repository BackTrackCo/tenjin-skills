import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Two scripts that stand in for the OS open command and the clipboard, so no test opens a page or touches a real clipboard. Each
// writes what it was given to a log file.
export function fakeBins() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-bins-'));
  const openLog = path.join(dir, 'open.log');
  const clipLog = path.join(dir, 'clip.log');
  const open = path.join(dir, 'open');
  const clip = path.join(dir, 'clip');
  fs.writeFileSync(open, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${openLog}"\n`, { mode: 0o755 });
  fs.writeFileSync(clip, `#!/bin/sh\ncat > "${clipLog}"\n`, { mode: 0o755 });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return { env: { GTM_LOOP_OPEN_BIN: open, GTM_LOOP_CLIP_BIN: clip }, opened: () => read(openLog).trim().split('\n').filter(Boolean), clipboard: () => read(clipLog) };
}
