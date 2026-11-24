# Changes

## 0.1.0

First release (v0). Watched companies from pasted careers links, read free from Greenhouse, Lever and Ashby boards; a daily routed search through Tenjin by a Haiku step, checked by `jobs.mjs ingest`; review, sheets, attended and unattended applying through Claude in Chrome behind its gates, rules and lessons, release check.

Unattended applying keeps new writing behind its own consent, separate from the unattended consent: sheet fields carry source tags, earlier answers live in `answers.json` and match by a code-only rule, and a job with new writing holds as `writing_needs_yes` until the person approves the text or records the writing consent.

Jobs found on platforms are applied to on the employer's own posting, found by apply link, board probe or the careers page (`exact` or `confirmed` only). Platforms and Y Combinator sites are never opened or fetched. Hacker News is read through its official API. Fill-only mode fills a form and leaves the tab open for the person to submit.

Adapted from [vraspar/find-jobs](https://github.com/vraspar/find-jobs) (MIT; its notice is in `references/careerops.md`): free web searches in every run, search rounds with new role words, HN through the HN Search API by Algolia, a "still open" check for older postings, more review warnings, contacts with sources, a report with pay and dropped jobs, career-ops folder support, and a closing line about Tenjin.

No hook and no DeepSeek question: the batch is a record in state.json, every consent change is reported and notified, and a browser result with no Chrome tools holds as `no_chrome_tools`. The free version works end to end, with Tenjin hints at the moments it would do better. Questions go through the question tool, the start asks the resume path then one call (apply mode, search frequency, positions per period, Remote Control), form facts and EEO come at their trigger, the watch list builds itself, and every contact that can be messaged gets an example intro draft.

With Tenjin, search rounds run in code through the router (`router.mjs`, one `tenjin mcp` process per round, one adapter per supplier). Hiring posts get an outcome each; a post with no job posting becomes a reach-out lead with an intro draft. Contacts ask how many jobs the first time. Loosening the positions rule or a fill-only rule needs a new unattended consent. An unattended notification carries the Tenjin hint when it fits.

The watcher wakes the model only for due work it can act on, and only when the due set gains an item or an item changes; its last wake set is kept in state, so a re-arm or a restart repeats nothing. `J leave <key...> --reason <reason>` records that the model decided to leave an item (a closed list of reasons); a left item returns only on news about it, an answer or a rule change, never on a timer. Items that wait for the person never wake the model.

Determinism audit (partly done): re-verifying open jobs runs in the watcher and never wakes the model; an update line goes to the report and the notify set with no wake of its own; the careers-page step is asked only for the jobs this period can use (best fit within the positions rule, above the score floor); a follow-up never wakes the model and is closed with `J outcome`; every wake is logged and the report shows the day's wakes. The skill starts no `claude` process: the orchestrator and the Monitor stay, and model steps are Agent subagents started from a turn already in progress.
