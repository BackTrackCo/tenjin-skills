# Daily search (Haiku subagent)

Runs when `J work` lists `search_due`; its `query` carries `role`, `place`, `remote`, `since`, `variant` and `round`. A round is one query per need for one role-word variant: round 0 is the role itself, round N is `search.variants[N-1]` (a synonym or a level, from the query plan made at setup). After you ingest a round run `J search next`: code stops when the round added no new job that passes dedupe, date, place and role words, or when the variants run out. There is no cap on results.

In an attended run, say one line after each search step ("web: 14 results, 9 new").

## 0. With Tenjin, in code

`scripts/lib/router.mjs` is the only file that talks to the router: it starts one `tenjin mcp` process per round, sends each need as text built from a template in `graph.json` (it names no seller), then runs the offer it is given, saves the result to a file (`fullResultPath`) and passes it to an adapter for that supplier. Only a `fulfilled` answer delivers; any other status (`needs_approval`, `needs_input`, `unverified`, `failed`, `unpaid`, `blocked`, ...) holds that one search with its reason, and nothing is sent twice. The router's own limits and `needs_approval` apply; the skill adds no money rule. Adapters exist for the job-posting search, the X hiring-post search, the careers-page finder (a company URL in, the vendor and board out, then the board probe and job match for `confirmed`) and the people search (an empty answer is a normal answer; a person found is a likely contact, marked not confirmed, and one whose address does not name the job's city is dropped).

Each need runs on its own, in the watcher or with `J route`. The web search is one of them: it is phrased as an API for a script, with the board hosts as its `includeDomains`, the role and place in the query and the catch-up window as the start date. Its results are for immediate use only, so they are never saved and only the job links confirmed on the employer's board are kept. A `native` answer or a missing mapper holds that need for the round with a report line, and never becomes a model step. The web-search and LinkedIn-profile mappers are built from the router's spec and are unrecorded until a response is recorded. One that fails or is held never stops the others. A need that code cannot run (no adapter for its kind, or a supplier it does not know) leaves one `need_due` item for the round; `web_search_due` exists only without Tenjin. Without Tenjin, or with the wallet unavailable (`wallet_unavailable`), the searches below run as a Haiku step.

## 1. Free web searches (without Tenjin)

**Ask first.** Without Tenjin, in an attended turn, the once-per-session Tenjin ask comes right before the first moment Tenjin would do better, and before that moment's free path runs. One shared state, `askDue` (Tenjin not ready, an attended turn, the session's ask unanswered), is checked by every command that hands out a free path: `J search plan` (the queries), `J resume set --url` (a LinkedIn link's export-or-text fallback) and `J work` (the `employer_page` task text). While it is due they print `{ask: "tenjin", moment, hint, question}` in place of the free path; `J leave contacts:<key> --reason none_found` prints it too, because contacts keep their free ways first and the ask comes when a job is left with none. Ask it with the question tool, then `J tenjin ask-done yes|no`. On a yes the install and fund steps run and the moment holds as `tenjin_setup` for this period until `J tenjin` says `ready`; then it runs through the router in code. If Tenjin is still not ready at the next period, the free path runs with its hint and no new ask. On "Not now" the free path runs and nothing asks again that session. An outdated Tenjin gets the same ask, naming the update. In an unattended turn nothing asks: the free path runs and the hint goes in the report. Run a free path only from what those commands printed.

`J search plan` prints the round's exact queries (`site:jobs.ashbyhq.com`, `site:job-boards.greenhouse.io`, `site:boards.greenhouse.io`, `site:jobs.lever.co`, and `site:x.com "hiring" "<role>"`) and the `query` object to copy. The Haiku subagent only runs them with the web search tool and returns the raw results; code reads the URLs out, drops repeats and sorts them (board links, X posts, then the rest). Write one file in this shape and run `J ingest <file>`:

```json
{"need":"web_search","query":{"role":"..","place":"..","remote":false,"since":"2026-11-16","variant":null,"round":0},
 "status":"ok",
 "raw":[{"query":"site:jobs.lever.co ...","results":[
   {"url":"https://job-boards.greenhouse.io/acme/jobs/1","title":"..","snippet":".."},
   {"url":"https://www.linkedin.com/jobs/view/1","title":"..","snippet":"..","company":"..","city":"..","remote":false},
   {"url":"https://x.com/someone/status/1","title":"..","snippet":"<the post text from the result>","author":"someone"}]}]}
```

The model fills only company, place and remote, and only for a result on a job platform (LinkedIn, Indeed and similar), from the result alone; a platform result with no company is dropped. Status: `ok` when the native web search returned results; when Tenjin answered the search through `request`, copy the envelope word exactly (then only `fulfilled` is delivered). `fullResultPath` is optional. Invent nothing. Code turns a board link into the employer's posting (read from the board API) and sends a platform result through the employer-posting steps, from the search result only. Then `J search web-done`. Never fetch a platform page, never open an X page, and never search or fetch a Y Combinator site.

## 2. A need code could not run (`need_due`), or the whole round without code

Needs Tenjin's `request` tool. If Tenjin is missing or the tool is not loaded yet, run `J routed skip <why>`; the watched boards and the free web searches still ran. State each need in plain words and name no seller:

1. **job_postings**: job postings for the role, in the place (add remote jobs only if `remote` is true), posted since the date.
2. **x_hiring_posts**: hiring posts on X for the same role.

Leave `needs_approval`, funding, spend limits and seller failures to the router: do not retry a paid call that failed, do not change any limit. Add no budget.

Write one file per need in the skill's own shape, filled from what `request` returned, never a seller's raw body (the result's `fullResultPath` holds the whole response; read it if a field is missing, never invent one):

```json
{"need":"job_postings","query":{"role":"..","place":"..","remote":false,"since":"2026-11-16","variant":null,"round":0},
 "status":"<the envelope status word, copied exactly>","fullResultPath":"..","cost":"<cost as reported>",
 "postings":[{"title":"","employer":"","employerWebsite":"","city":"","region":"","country":"","remote":false,"postedAt":"2026-11-20T00:00:00Z",
   "employmentType":"","salary":{"min":0,"max":0,"currency":"USD","period":"year"},"applyLinks":[{"url":"","publisher":""}],
   "description":"at most 2000 characters","sourceUrl":""}]}
```

`salary` is null when the listing shows none. For `x_hiring_posts` use `"posts":[{"url","author","postedAt","text"}]` in place of `postings`. Copy the envelope `status` word exactly as the tool returned it; never translate it. Only `fulfilled` is a delivered result. Every other status (`unverified`, `running`, `needs_approval`, `needs_input`, `unpaid`, `failed`, `native`) holds the source for this run, and the report line carries the word. Then run `J ingest <file>`; for a `need_due` item then `J search done <kind>`, and with no Tenjin tool `J leave need:<kind> --reason no_web_search` (it comes back at the next period). The search waits while an unattended apply batch is open: rounds run one at a time, a batch closes at the end of its round, and the search runs in the next round.

Code holds a source for this run, and the report names it, when the file fails the schema, the status is not `fulfilled`, or the list is empty. A posting reaches the apply queue only when an apply link is on Greenhouse, Lever or Ashby and the board still lists the job; the rest are kept as jobs without an employer posting. A routed posting older than the window stays only when its board confirms it is open, with the warning "posted <date>, still open". A job whose open state cannot be confirmed keeps the warning "not confirmed open" and never enters the apply queue.

## Finding the employer's own posting

A posting found on a job platform (LinkedIn, Indeed, Glassdoor, ZipRecruiter and similar), on X or on a Y Combinator site is never opened, applied to or fetched: those terms ban automated use. Include `employerWebsite` in each posting when the result shows it. Code does the rest, free:

1. An apply link on Greenhouse, Lever or Ashby is the employer's posting (`apply_link`, `exact`).
2. Otherwise code guesses the employer's board from the name and website (three candidates, at most nine requests) and accepts only a board that is the employer's and a job that matches by title, place and date (`board_probe`, `confirmed`). Two matches or none give no match.
3. For a job that passed review and has none yet, with Tenjin the router's careers-page finder runs in code first. `J work` lists `employer_page` only when code found no board link: Haiku reads the employer's careers page itself (a web search). Code fetches nothing from that page. Write `{"need":"careers_page","jobKey":"<key>","careersUrl":"https://...","status":"fulfilled","fullResultPath":"..","boardLinks":["<every Greenhouse, Lever or Ashby link on the page>"],"otherLinks":["<links to other hiring systems>"],"signIn":false}` and run `J ingest`. Code runs the ownership and job checks through the board APIs. A board linked from the employer's own page counts as confirmed (`careers_page`). Another hiring system is reported as "apply on the employer's site". `signIn: true` (a sign-in page) is a stop.

Only `exact` and `confirmed` postings reach the apply queue. Everything else is an "apply yourself" item with one reason in the report. A Y Combinator job with no other posting carries its Work at a Startup link for the person to open.

## Hacker News

Code reads the "Ask HN: Who is hiring?" thread through the HN Search API by Algolia (`hn.algolia.com`): one search per role word for comments newer than the last read, top-level comments only, then the role and place prefilter. Job stories come from the Firebase API (`hacker-news.firebaseio.com`), new ids only, one request a second. `J hn` runs both: the job-story reads stop at 90 seconds (`--budget <seconds>`), save every 20 items and report how many are left; the watcher continues on its next tick, 60 seconds at a time. Code first reads each post's board links, author handle and emails word for word, and turns a post with a Greenhouse, Lever or Ashby link into a posting itself, with its author as the contact. The rest go to Haiku review in batches of 25: one subagent, one ingest file per batch (`batch[]`, `outcomes[]`, `postings[]`, `leads[]`), about the input of one review round. A post that cannot be read is `not_hiring` with `reason: unreadable`: it is counted and not shown again unless its text changes. A hiring post with no job posting becomes a reach-out lead, shown under "People hiring", never sent. Never fetch news.ycombinator.com.
