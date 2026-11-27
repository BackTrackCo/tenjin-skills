# Setup

G means `node ${CLAUDE_SKILL_DIR}/scripts/gtm.mjs`.

## First run

1. `G tenjin`, `G start status`. If `start status` lists what is missing, work through it in this order.
2. Ask the person, in plain text, what they sell: who it helps, what it does, the link, and if they like who buys it (role, company type, place). Save it: `G profile set --json '{"offer": {"name": "<name>", "what": "<one line>", "who": "<who it helps>", "link": "<https link>"}}'`. A buyer, if they described one: `{"buyer": {"roles": ["<role>"], "industry": "<text>", "size": "<text>", "place": "<text>"}}`.
3. Their own handles go in the profile so their own posts drop out: `{"sender": {"name": "<name>", "company": "<company>", "handles": {"x": "<handle>", "reddit": "<name>", "hn": "<name>", "linkedin": "<slug>"}, "domain": "<company domain>"}}`. The postal address is only needed for email: ask for it when they first pick Email, and save it as `sender.postal`. Without it no email goes out.
4. Propose three to six phrases a buyer would write when they want what the person sells (the words in a post, not a product category). Let the person edit them, then `G phrases set "first|second|third"`.
5. One question-tool call: `G ask start` builds it (how emails go out, how often to search, which sources). Record each answer with `G start record --email-mode ask|drafts|show --frequency daily|twice_daily|weekly --sources all|social|free`.
6. The free search and the first report follow in the same session.

## Tenjin

With Tenjin ready, the watcher runs every post source in code (X, Reddit, LinkedIn, the web) and Hacker News for free, and reads the profile of each kept lead. Without it, Hacker News still runs in code and one Haiku web-search step covers the rest (find.md). Say the line from `G hints` once, as one line, when Tenjin is missing or out of date. `G ask tenjin` is not needed: the install flow at tenjin.sh asks its own questions. This skill changes no Tenjin setting.

## Rules

`G rules add --effect <effect> --value <value> --words "<their words>"`, only from the person's own words. Effects: `min_score` (drop leads below it), `follow_up` (one follow-up after N days, attended only), `exclude_term`, `exclude_domain`, `exclude_person`, `notify_off`, `note`, and the caps `leads_per_round`, `emails_per_day`, `searches_per_day`, `companies_per_search`, `phrases_per_round`, `rounds_per_day`. There is no default cap: a cap exists only when the person sets it.

## Recover

After a compaction or `/resume`: `G tenjin`, `G start status`, `G work --commit`, then `G watch` last. A held item stays in `G report --all`; `G leave <key> --reason <reason>` hides an item you decided to leave until it has news.
