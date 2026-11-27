# Loop base

The shared frame of the Tenjin loop skills (Job Search first): code that a loop app imports from `skills/loop-base/lib/`, installed in the same skills folder as the app. The base is not used on its own, never imports app code, and keeps no state of its own.

An app is one `defineApp({...})` object, registered by its own `paths.mjs` with `setApp`, plus its own commands and logic. The base reads the app's `manifest.json` and `graph.json` only through its loaders, and only the keys it documents.

## What an app gives the base

`defineApp({ skillDir })` takes the app's skill folder and reads its `manifest.json`:

- `name` (from `manifest.json`): the app's data folder `~/.tenjin-skills/<name>`, its tag prefix, its skill name and its env prefix. `job-search` gives `JOB_SEARCH_TICK_MS` and `JOB_SEARCH_OPEN_BIN`.
- `skillDir`: where its `manifest.json` and `graph.json` live.

- `state`: `{ empty(), schemaVersion, applyOp(state, op), oldFields(raw) }`, the app's state shape and its own ops; an app attaches it with `extendApp` from the module that builds it.
- `kinds`: `{ [kind]: { collection, statuses, transitions, terminal, onTransition } }`; the base's `transition` moves an item between statuses, refuses an undeclared move or a move out of a final status, and names the kind in the error when the app declares more than one.
- `release`: `{ repo, displayName, skillsCli, companions: [{ skill, manifestKey, tagField, previousField }] }`. The tag prefix is `<name>-v`, the gate files are the manifest's `gateFiles` (in order; a sibling path such as `../loop-base/lib/netguard.mjs` is allowed) and the manifest's `gatesHash` covers them and the gate section of SKILL.md. An update installs the app and `loop-base` at the app's tag, then each companion; a gate change waits for the person's yes.
- `hosts`: `{ allowed, never, userAgent, readModes }` for the fetch guard. `allowed` is the list of hosts the scripts may fetch; `never` (a list or a function that returns one) is refused by name first; a read mode is a named narrow exception (`readModes: { yc: { assert(url) } }`) read logged out, with no cookie and no redirect. A private or local address, or a name that resolves to one, is never fetched.
- `suppliers`: the table of supplier modules, built with `supplierTable(modules, defaultAdapter)`: each module has `HOST` (or `TOOL` and `ANY_HOST`), `KIND`, `mapper` and `adapter`. The router client picks one by the host the spec names or by catalog tool id, refuses an answer from another host and never pays twice. The base ships shared suppliers under `lib/suppliers/` (people search, LinkedIn profile and person posts, X search shape, company lookup); an app names its own `KIND` and the text people see.
- `questions`: `{ noMarker: [headers], markers: ['from your resume'], firstOptionOk: [/regex/] }`, the app's exceptions to the question tool's shape rules (the default first and marked "(Recommended)"; 1 to 4 questions of 2 to 4 options; no text naming the tool's own free-text option). The base's `validateAsk` checks every call; a typed answer is a plain question, `plain(text)`.
- `rules`, `consents`, `batch`, `email`: the vocabulary and lessons of the person's rules, the consent kinds and what they need, the commands refused while a batch is open, and the email candidates with the app's recipient checks (`candidates(state)`, `recipientChecks(...)`). `consent.mjs`, `batch.mjs` and `netguard.mjs` are gate files: an app lists each one it uses in its manifest's `gateFiles`. `email.mjs` is one too in the sense that it decides what may be sent, but an app lists it only if it wants its hash to cover it.
- `steps` and `watcher`, `work.list`: the watcher steps (`{ name, due(ctx), run(ctx), catch, onError }`, run in order every tick; a step may return `{ pending: true }` while code is still reading), the watcher's code files, profile reader, blocking prefixes, wake line and command names, and the app's work list. The base's `runWatcher` exits when work is due, refuses to start while due work is unclaimed or another session holds the lease, restarts on a code change, and reads its tick interval from `<APP>_TICK_MS`.

The base modules that follow add their own fields to the object as they land: state, item kinds, watcher steps, work items, consents, rules, batch, email, hosts, suppliers, report sections, commands and release. Each field is something the app already does in its own code.

## Rules for base code

- A base module never imports a path outside `skills/loop-base/` and never names an app.
- One data folder per app, nothing shared. The one file two apps may both read is the person's writing rules, `~/.tenjin-skills/writing/rules.md`, which the writing skill owns; no loop writes it.
- A base module used before `setApp` fails with a clear error.

## The loop lines every app's SKILL.md carries

Each app writes these with its own command name and pins them in its own tests:

- At every start and after a compaction: run the start commands in order, then the work list, then the watcher last, in the background.
- Start the watcher again after each round and whenever a command reports that it stopped.
- Never ask the person in an unattended turn: hold and notify.
- Questions go through the question tool, built by the app's `ask` command, never as a list written by hand.
