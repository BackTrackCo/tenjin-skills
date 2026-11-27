# Setup

G means `node ${CLAUDE_SKILL_DIR}/scripts/gtm.mjs`.

## First run

1. `G tenjin`, `G start status`. It lists what is missing, in the order to ask it, and each answer is saved as it comes, so a partial answer is never lost.
2. Ask in one message, in plain text: the person's name, company, handles (X, Reddit, Hacker News, LinkedIn) and what they sell. Save at once what they give, even if partial: `G profile set --json '{"sender": {"name": "<name>", "company": "<company>", "handles": {"x": "<handle>", "reddit": "<name>", "hn": "<name>", "linkedin": "<slug>"}}}'`. Their handles keep their own posts out of the leads. The postal address is only needed for email: ask for it when they first pick Email, and save it as `sender.postal`.
3. What they sell is a list of offers. Each has its own line, who it helps, a link, phrases, subreddits and an optional buyer. Two products, or one product for two kinds of person, are two offers: never merge them into one description. Save them: `G offers set --json '[{"id": "<short-kebab-id>", "name": "<name>", "what": "<one line>", "who": "<who it helps>", "link": "https://...", "phrases": [...], "subreddits": [...]}]'`.
4. Phrases, per offer: propose three to six, first person and short (ten words at most), written as a buyer writes a post, never as an article title. Good: "how did you get your first users", "my cold emails get no replies", "anyone using Claude for outbound". Bad: "looking for a lead generation tool", "best cold email software". Let the person edit them. Code turns each phrase into the query of each source (a few key words and the operators that source supports); never type a query yourself.
5. Subreddits, per offer: propose five to eight where that offer's buyer asks for help, in the way of the Reddit Scout skill's discovery (communities for the buyer's problem, not for the product). The person edits the list. Reddit is searched only inside this list, and a post from outside it is dropped. An offer with no subreddits is not searched on Reddit.
6. Buyer, per offer: when the person says who it helps but gives no buyer, propose one from their own words (role, company type, place) and ask once. Save it as `buyer`, or `buyerAsked: true` if they decline. A buyer turns on the fit search (references/find.md).
7. One question-tool call: `G ask start` builds it (how emails go out, how often to search, which sources). Record each answer with `G start record --email-mode ask|drafts|show --frequency daily|twice_daily|weekly --sources all|social|free`.
8. The free search and the first report follow in the same session.

## A profile from an older run

An older profile has one `offer`, one list of `phrases` and one `buyer` at the top, and no subreddits. It still loads and the search keeps running on it. `G start status` lists the change: show the person once that this is now a list of offers, propose offers, short first-person phrases and subreddits from what the old profile held and from how the first run went, let them confirm or edit, then save the list with `G offers set` (it replaces the old fields).

## Tenjin

With Tenjin ready, the watcher runs every post source in code (X, Reddit, LinkedIn, the web) and Hacker News for free, and reads the profile of each kept lead. Without it, Hacker News still runs in code and one Haiku web-search step covers the rest (find.md). Say the line from `G hints` once, as one line, when Tenjin is missing or out of date. This skill changes no Tenjin setting.

## Rules

`G rules add --effect <effect> --value <value> --words "<their words>"`, only from the person's own words. Effects: `min_score` (drop leads below it), `follow_up` (one follow-up after N days, attended only), `exclude_term`, `exclude_domain`, `exclude_person`, `notify_off`, `note`, and the caps `leads_per_round`, `emails_per_day`, `searches_per_day`, `companies_per_search`, `phrases_per_round`, `rounds_per_day`. There is no default cap: a cap exists only when the person sets it.

## Recover

After a compaction or `/resume`: `G tenjin`, `G start status`, `G work --commit`, then `G watch` last. A held item stays in `G report --all`; `G leave <key> --reason <reason>` hides an item you decided to leave until it has news.
