# Daily search (Haiku subagent)

Runs when `J work` lists `search_due`; its `query` carries `role`, `place`, `remote`, `since`, `variant` and `round`. A round is one query per need for one role-word variant: round 0 is the role itself, round N is `search.variants[N-1]` (a synonym or a level, from the query plan made at setup). After you ingest a round run `J search next`: code stops when the round added no new job that passes dedupe, date, place and role words, or when the variants run out. There is no cap on results.

In an attended run, say one line after each search step ("web: 14 results, 9 new").

## 1. Free web searches (every run, also without Tenjin)

Use the web search tool for the round's role (the variant if there is one) and place, and nothing else:
`site:jobs.ashbyhq.com`, `site:job-boards.greenhouse.io`, `site:boards.greenhouse.io`, `site:jobs.lever.co`, and `site:x.com "hiring" "<role>"`. Write one file in this shape and run `J ingest <file>`:

```json
{"need":"web_search","query":{"role":"..","place":"..","remote":false,"since":"2026-11-16","variant":null,"round":0},
 "status":"ok",
 "results":[{"url":"https://job-boards.greenhouse.io/acme/jobs/1"},
            {"url":"https://www.linkedin.com/jobs/view/1","title":"..","company":"..","city":"..","remote":false,"postedAt":null,"snippet":".."},
            {"url":"https://x.com/someone/status/1","author":"someone","snippet":"<the post text from the result>"}]}
```

Status: `ok` when the native web search returned results; when Tenjin answered the search through `request`, copy the envelope word exactly (then only `fulfilled` is delivered, as for the other needs). `fullResultPath` is optional here. Put the result's own fields in; invent none. Code turns a board link into the employer's posting (read from the board API) and sends a LinkedIn, Indeed or similar result through the employer-posting steps, from the search result only. Never fetch a platform page, never open an X page, and never search or fetch a Y Combinator site.

## 2. The router's needs (only when `routed` is true)

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

`salary` is null when the listing shows none. For `x_hiring_posts` use `"posts":[{"url","author","postedAt","text"}]` in place of `postings`. Copy the envelope `status` word exactly as the tool returned it; never translate it. Only `fulfilled` is a delivered result. Every other status (`unverified`, `running`, `needs_approval`, `needs_input`, `unpaid`, `failed`, `native`) holds the source for this run, and the report line carries the word. Then run `J ingest <file>`. The search never runs while an unattended apply batch is open: the guard denies every MCP tool there, so `search_due` waits.

Code holds a source for this run, and the report names it, when the file fails the schema, the status is not `fulfilled`, or the list is empty. A posting reaches the apply queue only when an apply link is on Greenhouse, Lever or Ashby and the board still lists the job; the rest are kept as jobs without an employer posting. A routed posting older than the window stays only when its board confirms it is open, with the warning "posted <date>, still open". A job whose open state cannot be confirmed keeps the warning "not confirmed open" and never enters the apply queue.

## Finding the employer's own posting

A posting found on a job platform (LinkedIn, Indeed, Glassdoor, ZipRecruiter and similar) or a Y Combinator site is never opened, applied to or fetched: those terms ban automated use. Include `employerWebsite` in each posting when the result shows it. Code does the rest, free:

1. An apply link on Greenhouse, Lever or Ashby is the employer's posting (`apply_link`, `exact`).
2. Otherwise code guesses the employer's board from the name and website (three candidates, at most nine requests) and accepts only a board that is the employer's and a job that matches by title, place and date (`board_probe`, `confirmed`). Two matches or none give no match.
3. For a job that passed review and has none yet, `J work` lists `employer_page`. Haiku finds the employer's careers page (a `request` need, or the web search) and reads it itself. Code fetches nothing from that page. Write `{"need":"careers_page","jobKey":"<key>","careersUrl":"https://...","status":"fulfilled","fullResultPath":"..","boardLinks":["<every Greenhouse, Lever or Ashby link on the page>"],"otherLinks":["<links to other hiring systems>"],"signIn":false}` and run `J ingest`. Code runs the ownership and job checks through the board APIs. A board linked from the employer's own page counts as confirmed (`careers_page`). Another hiring system is reported as "apply on the employer's site". `signIn: true` (a sign-in page) is a stop.

Only `exact` and `confirmed` postings reach the apply queue. Everything else is an "apply yourself" item with one reason in the report. A Y Combinator job with no other posting carries its Work at a Startup link for the person to open.

## Hacker News

Code reads the "Ask HN: Who is hiring?" thread through the HN Search API by Algolia (`hn.algolia.com`): one search per role word for comments newer than the last read, top-level comments only, then the role and place prefilter. Job stories come from the Firebase API (`hacker-news.firebaseio.com`), new ids only, one request a second. `J hn` runs both: the job-story reads stop at 90 seconds (`--budget <seconds>`), save every 20 items and report how many are left; the watcher continues on its next tick, 60 seconds at a time. Posts go to Haiku review in batches of 25: one subagent, one ingest file per batch, about the input of one review round. Never fetch news.ycombinator.com.
