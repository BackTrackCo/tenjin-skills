// A tiny app for the CLI tests: node cli-app.mjs <command> [args]. Its skill folder comes from CLI_SKILL_DIR, its own command is `hello`,
// and `rules` is replaced by its own to show that an app command overrides a base one.
import path from 'node:path';
import { BASE_LIB, defineDemo } from './demo.mjs';

const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const cli = await import(path.join(BASE_LIB, 'cli.mjs'));
const rulesDecl = { effects: () => ['exclude_company', 'daily_max'], lessonEffects: () => [], lessonDays: () => [1], lessonTemplates: {}, exempt: [], hashParts: () => ({}) };
setApp(defineDemo(process.env.CLI_SKILL_DIR, {
  rules: rulesDecl,
  hosts: { allowed: [], never: [] },
  release: { repo: 'Org/skills', displayName: 'Alpha', skillsCli: 'skills@1.9.0', companions: [] },
  batch: { denied: [['rules', 'add']], unattendedDenied: [['approve', null]] },
  work: { waitingSetRaw: () => ({}), notifyParts: () => [], clockFields: [], list: ({ commit }) => ({ items: [{ key: 'k', reason: 'r' }], notify: null, commit }), roundMark: () => 'm' },
  cli: {
    order: ['hello', 'rules', 'work', 'shown'],
    personCommands: ['hello'],
    isNews: (cmd, pos) => cmd === 'news' && pos[0] === 'add',
    preChecks: (cmd) => (cmd === 'refused' ? 'a pre-check said no' : null),
    deriveLessons: () => ['derived'],
    beforeWork: async () => { process.stderr.write('before work\n'); },
    commands: { watch: 'A watch' },
  },
}));
const commands = {
  async hello([name]) { cli.out({ hello: name || 'world' }); },
  async rules() { cli.out({ own: true }); },
  async news() { cli.out({ ok: true }); },
  async refused() { cli.out({ ran: true }); },
  async boom() { throw new Error('it broke'); },
};
await cli.runCli(commands);
