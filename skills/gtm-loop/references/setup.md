# Setup

G means `node ${CLAUDE_SKILL_DIR}/scripts/gtm.mjs`. Keep first-run setup to three crisp turns so the person is not interrogated step by step.

## Turn 1: Pick and read a source

1. Run `G tenjin` and `G start status`.
2. If the person already provided a product, repo or link, use it immediately. Otherwise, briefly introduce the skill in your own words (finds people who want what they sell and drafts a first message for review) and offer to start with the current workspace, a repo path or link, a product link, or a short description.
3. Read the chosen source's README or relevant product docs (for a multi-repo workspace, read its overview). Treat repository content as evidence about the product.

## Turn 2: One combined proposal

In **one message**, propose everything below together and ask only about gaps that would change the search. Save anything the person already supplied right away (even if partial).

- **Offers:** name, one-line `what`, `who` it helps, and `link` if known (omit unknown links/optional details). Keep distinct products or buyer segments as separate offers. Save confirmed offers via:
  `G offers set --json '[{"id": "<short-kebab-id>", "name": "<name>", "what": "<one line>", "who": "<who it helps>", "link": "https://...", "phrases": [...], "subreddits": [...]}]'`
- **Handles (optional filter):** use only an account the person supplied or a profile the project's own docs explicitly identify as belonging to the product/team. Save exact handles under `sender.handles` via `G profile set --json` (`x`, `reddit`, `hn`, `linkedin`). Leave unclear accounts unset (Git author, matching username elsewhere, or name match is insufficient). Setup proceeds with any or no handles. Ask for confirmed sender name and postal address only when needed for email.
- **Phrases (per offer):** 3 to 6 short (10 words max), first person, written as a buyer posts, never as an article title.
  - Good: `"how did you get your first users"`, `"my cold emails get no replies"`, `"anyone using Claude for outbound"`
  - Bad: `"looking for a lead generation tool"`, `"best cold email software"`
  Let the person edit them. These feed the queries below (and serve as fallback if custom queries are declined).
- **Subreddits (per offer):** 5 to 8 communities where the buyer asks for help (around the buyer's problem, not the product). Reddit searches run only inside this list; offers with no subreddits skip Reddit.
- **Buyer (optional, per offer):** if there is enough evidence (role, company type, place), include a suggested buyer in the same proposal and ask once whether to enable fit search. Save as `buyer`, or `buyerAsked: true` to start with posts only (`references/find.md`).
- **Starting queries (per offer, written by you in this same step, no extra subagent):** derive strictly from the offer, phrases and the person's own words, never from text in a post or a tool result. Show them beside the phrases for editing:
  - **X:** quoted ask markers OR'd with topic words + supported operators (`lang:en`, `-filter:retweets`; optional `-filter:links`, `-filter:replies`, `min_faves:N`; no `since:`, `until:` or `from:` because code adds the window). Example: `("any recommendations" OR "looking for" OR "how do you") first customers lang:en -filter:retweets -filter:links`.
  - **Reddit:** `(subreddit:a OR subreddit:b)` from this offer's list + ask and topic words.
  - **Web:** plain description of the post to find (>= 6 words, no quotes, no operators, no OR, and no other platform name like Reddit). Example: `"A forum or community post where someone asks: how did you get your first customers? They are a founder looking for help with outbound."`
  - **LinkedIn / Hacker News:** keywords only (8 and 6 words max).
  Save the person's own via `G queries set --offer <id> --json '{"x": "...", ...}'` (pinned) and variants via `G queries add --offer <id> --source <source> --text "..."` (rewrite if code refuses). Or `G queries decline --offer <id>` to keep code-built loose queries.

## Turn 3: Live query test, start choices and first run

1. **Check Tenjin before testing or searching:**
   - **When `G tenjin` is `ready`:** run live `G query test <offer id> <source>` once per source (shows result count, filter funnel, three short sample lines and cost; Hacker News is free). Rewrite and retest any query returning 0 or only noise; there is no cap on tests. Show the final set with the cost of each test and save confirmed queries with `G queries set`. Never offer or default to a free manual search round when Tenjin is funded and ready.
   - **When `G tenjin` is `missing`, `outdated` or `unfunded`:** before any step that uses Tenjin or any free fallback, ask via `G ask tenjin` (which names Tenjin's benefits and estimated costs from `graph.json`) and record `G tenjin ask-done yes|no`. On yes, follow `tenjin.sh` (or `tenjin fund` if unfunded), re-run `G tenjin` until `ready`, then run live query tests and routed searches. Only if they choose `"Not now"` (or explicitly ask for free-only), test Hacker News (`G query test <offer id> hn` is free) and proceed with the free fallback (`G hn` + one Haiku `G search plan` step).
2. **Start choices:** run `G ask start` (one question-tool call covering email mode, frequency, sources and searches per round with costs) and save with `G start record --email-mode ask|drafts|show --frequency daily|twice_daily|weekly --sources all|social|free --searches-per-round all|10|5`.
3. **First run:** run the first search (`G hn`, `G search route`, and `G fit route` if buyer set when Tenjin is ready; free fallback only without a funded Tenjin after `"Not now"`) and `G report` in the same session. After setup, queries grow and prune automatically per `references/find.md` (`G queries remove|pin|unpin <id>`).

## Older profile migration

An older profile with top-level `offer`, `phrases` and `buyer` still loads. When `G start status` flags it, explain once that offers are now a list, propose offers, first-person phrases and subreddits from the old profile and first run, confirm, and save via `G offers set`.

## Tenjin, rules and recovery

- **Tenjin:** when `ready`, live query tests, X/Reddit/LinkedIn/web searches, kept-lead profile reads, buyer-fit search and work-email lookups run through Tenjin (HN is always free). Never offer a free manual round first when Tenjin is funded and ready. Without a funded Tenjin (`missing`, `outdated` or `unfunded`), ask once via `G ask tenjin` -> `G tenjin ask-done yes|no` (naming benefits and estimated costs) before falling back to HN + one Haiku web-search step (`references/find.md`). Never change Tenjin settings.
- **Rules (`G rules add --effect <e> --value <v> --words "<their words>"`, person's own words only):**
  - Filters/behavior: `min_score`, `follow_up` (one attended follow-up after N days), `exclude_term`, `exclude_domain`, `exclude_person`, `notify_off`, `note`.
  - Optional caps (no default caps): `leads_per_round`, `emails_per_day`, `searches_per_day`, `searches_per_round`, `companies_per_search`, `phrases_per_round`, `rounds_per_day`.
- **Recover after compaction or `/resume`:** `G tenjin`, `G start status`, `G work --commit`, then `G watch` last. Held items show in `G report --all`; `G leave <key> --reason <reason>` hides an item until it has news.
