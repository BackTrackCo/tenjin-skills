import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The two push settings Claude Code saves from /config: "Push when actions required" (`inputNeededNotifEnabled`) and "Push when
// Claude decides" (`agentPushNotifEnabled`). Read-only, and only those two keys: the global config file holds account details,
// so the file is parsed, the two keys are taken and everything else is dropped at once. Never written, never copied, no other
// key is printed or logged. The global config file wins; the user settings file fills a key it does not have. true is on, false
// is off; a missing key, an unreadable file or a value that is not a boolean is unknown (null).
const KEYS = { input: 'inputNeededNotifEnabled', agent: 'agentPushNotifEnabled' };

function takeKeys(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { input: null, agent: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { input: null, agent: null };
  }
  text = null;
  const o = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const out = { input: typeof o[KEYS.input] === 'boolean' ? o[KEYS.input] : null, agent: typeof o[KEYS.agent] === 'boolean' ? o[KEYS.agent] : null };
  parsed = null;
  return out;
}

export function pushSettings({ env = process.env, home = os.homedir() } = {}) {
  const dir = env.CLAUDE_CONFIG_DIR;
  const global = takeKeys(dir ? path.join(dir, '.claude.json') : path.join(home, '.claude.json'));
  const user = takeKeys(dir ? path.join(dir, 'settings.json') : path.join(home, '.claude', 'settings.json'));
  return { input: global.input !== null ? global.input : user.input, agent: global.agent !== null ? global.agent : user.agent };
}
