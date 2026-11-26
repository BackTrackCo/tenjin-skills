# Loop base

The shared frame of the Tenjin loop skills (Job Search first): code that a loop app imports from `skills/loop-base/lib/`, installed in the same skills folder as the app. The base is not used on its own, never imports app code, and keeps no state of its own.

An app is one `defineApp({...})` object, registered by its own `paths.mjs` with `setApp`, plus its own commands and logic. The base reads the app's `manifest.json` and `graph.json` only through its loaders, and only the keys it documents.

## What an app gives the base

`defineApp({ skillDir })` takes the app's skill folder and reads its `manifest.json`:

- `name` (from `manifest.json`): the app's data folder `~/.tenjin-skills/<name>`, its tag prefix, its skill name and its env prefix. `job-search` gives `JOB_SEARCH_TICK_MS` and `JOB_SEARCH_OPEN_BIN`.
- `skillDir`: where its `manifest.json` and `graph.json` live.

- `state`: `{ empty(), schemaVersion, applyOp(state, op), oldFields(raw) }`, the app's state shape and its own ops; an app attaches it with `extendApp` from the module that builds it.
- `kinds`: `{ [kind]: { collection, statuses, transitions, terminal, onTransition } }`; the base's `transition` moves an item between statuses, refuses an undeclared move or a move out of a final status, and names the kind in the error when the app declares more than one.

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
