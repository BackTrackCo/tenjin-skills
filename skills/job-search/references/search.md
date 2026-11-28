# Search rounds

Runs when `J work` lists `search_due` (`query` carries `role`, `place`, `remote`, `since`, `variant`, `round`). Round 0 uses `role`; round N uses `search.variants[N-1]`. After ingesting a round, run `J search next`: code stops when a round adds no new passing job or when variants run out. No result cap. In an attended run, say one line after each search step ("web: 14 results, 9 new").

## Free sources run in code (always)

- **Watched boards (`profile.watch`):** read free every round (added only via `J watch add`, removed only via `J watch remove`). The report shows "Watched boards checked" only when non-empty.
- **Hacker News (`J hn`):** reads "Ask HN: Who is hiring?" via Algolia (`hn.algolia.com`, top-level comments newer than last read, prefiltered by role and place) and job stories via Firebase (`hacker-news.firebaseio.com`, 1 req/s, 90s default `--budget`, saved every 20 items; watcher continues 60s per tick). Code extracts Greenhouse/Lever/Ashby links, author handles and emails word for word; remaining posts go to `post_review` in batches of 25 (one Haiku subagent, one ingest file). Unreadable posts become `not_hiring` with `reason: unreadable`; hiring posts with no posting become reach-out leads ("People hiring", never sent). Never fetch `news.ycombinator.com`.
- **Y Combinator job pages (`J yc`, disable with `profile.yc: false`):** logged-out discovery only via `guardedFetch`, 1 request every `ycRead.paceMs` (5s), no cookies/sign-in/browser, never `workatastartup.com`. Reads only `/jobs/role/<role>`, `/jobs/role/<role>/<place>`, `/companies/<slug>` (extracting only `props.company.website` when `props.company.name` matches; never founder/person data) and `/companies/<slug>/jobs/<id>`. Skips failed or changed pages with one report line; ignores relative dates; resolves each job to an employer posting or keeps it as "apply yourself" with its YC link.

## 0. With Tenjin, in code

- `scripts/lib/router.mjs` spawns one `tenjin mcp` process per round, sends needs from `graph.json` templates (naming no seller), runs each offer, saves raw answers (`fullResultPath`) and parses via supplier readers. Only `fulfilled` delivers; any other status holds that one need with its reason and never retries twice. Router spend limits and `needs_approval` govern.
- **Board search** runs by catalog tool id (fresh offer per search, `includeDomains` for the three board hosts, lite search, 10 results; never routed through `{query}`; raw results never saved; confirmed on each employer board).
- **Self-repair & fallback:** one held or broken need never stops others. A need whose service changed or lacks a reader writes a repair request (`references/repair.md`) and, when unmapped, leaves `need_due`. Runs take a lock and save paid answers immediately so crashes never double-pay. `J route` and `J contacts route` run only when Tenjin is `ready`. With Tenjin ready, there is no model web search.

## 1. Free web searches (without Tenjin)

**Ask first:** in an attended turn while `askDue` holds (Tenjin not ready, session ask unanswered), `J search plan`, `J resume set --url`, `J work` (`employer_page`) and `J leave contacts:<key> --reason none_found` return `{ask: "tenjin", moment, hint, question}` before handing out a free path. Ask with AskUserQuestion, then `J tenjin ask-done yes|no`. On yes, follow Tenjin install/funding and hold as `tenjin_setup` for this period; on "Not now", run the free path and do not ask again this session. Unattended turns run the free path and put the hint in the report.

Run one Agent `model: "haiku"` step with the exact queries from `J search plan` (`site:jobs.ashbyhq.com`, `site:job-boards.greenhouse.io`, `site:boards.greenhouse.io`, `site:jobs.lever.co`, `site:x.com "hiring" "<role>"`) and return raw results in one file for `J ingest <file>`:

```json
{"need":"web_search","query":{"role":"..","place":"..","remote":false,"since":"2026-11-16","variant":null,"round":0},
 "status":"fulfilled",
 "raw":[{"query":"site:jobs.lever.co ...","results":[
   {"url":"https://job-boards.greenhouse.io/acme/jobs/1","title":"..","snippet":".."},
   {"url":"https://www.linkedin.com/jobs/view/1","title":"..","snippet":"..","company":"..","city":"..","remote":false},
   {"url":"https://x.com/someone/status/1","title":"..","snippet":"<the post text from the result>","author":"someone"}]}]}
```

Fill `company`, `place` and `remote` only for job-platform results from the snippet alone (drop platform results with no company; invent nothing). Never fetch platform pages, open X, or search/fetch YC sites yourself.

## 2. Model fallback for an unmapped need (`need_due`)

If Tenjin's `request` tool is unavailable, run `J routed skip <why>` or `J leave need:<kind> --reason no_web_search`. Otherwise state the need in plain words naming no seller (`job_postings` or `x_hiring_posts`), leaving `needs_approval`, funding, limits and failures to the router. Never resend a need whose router call was already paid. Write one ingest file in the skill's own shape (reading `fullResultPath` if a field is missing), run `J ingest <file>`, then `J search done <kind>`:

```json
{"need":"job_postings","query":{"role":"..","place":"..","remote":false,"since":"2026-11-16","variant":null,"round":0},
 "status":"<the envelope status word, copied exactly>","fullResultPath":"..","cost":"<cost as reported>",
 "postings":[{"title":"","employer":"","employerWebsite":"","city":"","region":"","country":"","remote":false,"postedAt":"2026-11-20T00:00:00Z",
   "employmentType":"","salary":{"min":0,"max":0,"currency":"USD","period":"year"},"applyLinks":[{"url":"","publisher":""}],
   "description":"at most 2000 characters","sourceUrl":""}]}
```

Use `"posts":[{"url","author","postedAt","text"}]` for `x_hiring_posts`, and `"salary": null` when absent. Reviewed post batches (`post_review`) use:

```json
{"need":"hn_hiring_posts","status":"fulfilled","query":{"role":"..","place":"..","remote":false,"since":"2026-11-16"},
 "batch":["<every post link in the batch>"],
 "outcomes":[{"url":"..","outcome":"job|lead|not_hiring|no_fit","reason":"unreadable"}],
 "postings":[],"leads":[]}
```

**Status word rule:** every ingest file uses `fulfilled` for a delivered result. Any other status (`ok`, `unverified`, `running`, `needs_approval`, `needs_input`, `unpaid`, `failed`, `native`) or schema failure or empty list holds that source for the round. Rewrite refused files; never `sed` them. Older routed postings stay only if their board confirms them open (`"posted <date>, still open"`); unconfirmed postings stay `"not confirmed open"` and never enter the apply queue. Searches wait while an unattended apply batch is open.

## Finding the employer's own posting

Jobs found on platforms (LinkedIn, Indeed, Glassdoor, ZipRecruiter, etc.) or X are never automated (`J open` opens them for the person as `open_ready`). Include `employerWebsite` when present. Resolution order:

1. **Apply link (`exact`):** direct Greenhouse, Lever or Ashby apply link.
2. **Board probe (`confirmed`):** code probes up to 3 board slug guesses (max 9 requests) and accepts only an employer-owned board with a unique title/place/date match.
3. **Careers page (`employer_page`):** for reviewed jobs with no match yet, code tries the routed careers-page finder first with Tenjin; otherwise Haiku finds and reads the employer's careers page via web search (code never fetches it) and ingests:
   `{"need":"careers_page","jobKey":"<key>","careersUrl":"https://...","status":"fulfilled","boardLinks":[...],"otherLinks":[...],"listings":[{"title":"..","url":"<application page>","city":"..","remote":false}],"signIn":false}` (plus optional `"linkedinUrl"`).
   Linked boards or matching listings on the employer's own domain (off the deny list) become `confirmed`; deny-listed hosts become `"apply yourself"` (`other_system`); `signIn: true` stops. `reverify` re-reads the page to confirm the listing is still open.

Only `exact` and `confirmed` postings reach the apply queue; all others appear as "apply yourself" with one reason (YC jobs carry their YC link).
