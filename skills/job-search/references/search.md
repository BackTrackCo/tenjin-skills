# Daily routed search (Haiku subagent)

Runs when `J work` lists `search_due`; its `query` carries `role`, `place`, `remote` and `since` (the days since the last search, at most 14). Needs Tenjin's `request` tool. If Tenjin is missing or the tool is not loaded yet, run `J routed skip <why>` and stop; the watched boards still run without Tenjin.

Agent `model: "haiku"`. For each need, state it to the `request` tool in plain words and name no seller:

1. **job_postings**: job postings for the role, in the place (add remote jobs only if `remote` is true), posted since the date.
2. **x_hiring_posts**: hiring posts on X for the same role.

Leave `needs_approval`, funding, spend limits and seller failures to the router: do not retry a paid call that failed, do not change any limit. Add no budget.

Write one file per need in the skill's own shape, filled from what `request` returned, never a seller's raw body (the result's `fullResultPath` holds the whole response; read it if a field is missing, never invent one):

```json
{"need":"job_postings","query":{"role":"..","place":"..","remote":false,"since":"2026-11-16"},
 "status":"<the envelope status word, copied exactly>","fullResultPath":"..","cost":"<cost as reported>",
 "postings":[{"title":"","employer":"","city":"","region":"","country":"","remote":false,"postedAt":"2026-11-20T00:00:00Z",
   "employmentType":"","salary":{"min":0,"max":0,"currency":"USD","period":"year"},"applyLinks":[{"url":"","publisher":""}],
   "description":"at most 2000 characters","sourceUrl":""}]}
```

`salary` is null when the listing shows none. For `x_hiring_posts` use `"posts":[{"url","author","postedAt","text"}]` in place of `postings`. Copy the envelope `status` word exactly as the tool returned it; never translate or rename it. Only `fulfilled` is a delivered result. Every other status (`unverified`, `running`, `needs_approval`, `needs_input`, `unpaid`, `failed`, `native`) holds the source for this run, and the report line carries the word. Then run `J ingest <file>`. The search never runs while an unattended apply batch is open: the guard denies every MCP tool there, so `search_due` waits.

Code holds the source for this run, and the report names it, when the file fails the schema, the status is not a delivered result, or the list is empty. A posting reaches the apply queue only when an apply link is on Greenhouse, Lever or Ashby and the board still lists the job; the rest become "apply yourself" items. Report the router's cost as given.
