# Contacts (on request, Haiku subagent)

First time requested, ask how many jobs via `J ask contacts` ("5 jobs (Recommended)", "10 jobs", "Every job that passed review", or Other; no answer defaults to 5). Save as `contact_count` via `J contacts count <n|all> --words "<their words>"`; later requests reuse it. Never ask in an unattended turn.

## Finding contacts

1. **Code first:** a hiring post's author (X handle or email in post text) is already a contact. With Tenjin, `J contacts route` runs company lookup and people search in code (no subagent); people outside the job's city are dropped. Never open `profileUrl` yourself.
2. **Free ways (Agent `model: "haiku"`):** team pages, talks, blog posts, GitHub and LinkedIn profile URLs visible in search snippets. Never fetch or sign in to LinkedIn, and never use YC company pages.

Every contact requires a source link, how to reach them, and one thing they care about (`J ops` refuses incomplete records):
`{"op":"contact","key":"..","name":"..","title":"..","sourceUrl":"..","how":"..","cares":"..","channel":"x|linkedin|email|other"}`

Mark inferred contacts `"basis":"likely","notConfirmed":true`. Never guess a name or address; if none are found, say so (`J leave contacts:<key> --reason none_found`).

## Company lookup before people search

- Before `J contacts route` runs people search, code resolves `employerWebsite` from: job record (`record`), routed posting (`posting`), board/posting homepage link (`board_page`), or with Tenjin a `company_lookup` by catalog tool id (spec fetched free first; bare `domain` is trusted only if `name` or `legalName` matches the job/board company name; registered address is never used as job city; LinkedIn company page is kept for matching).
- Without a website, people search still runs by company name and city: people from other companies are dropped, domain/board-name matches are likely contacts, and unconfirmed/sales/solutions titles ("Field", "Solutions", "Sales", "Account") or mismatched headlines are marked weak.
- Place filter matches metro area and reports dropped counts (`"2 found, 1 outside <city>"`).
- `J contacts route` lists unsearched jobs in `notSearched` with reasons; report them as `"not searched: <reason>"` and say `"returned nothing"` only when a search actually ran and came back empty.

## Example intros and sending

- **Drafting:** the round's one Opus writer call (`J write-prompt --round`, `J write-result --round`) drafts intros alongside sheets and leads (single job: `J write-prompt --intros <key>`, `J intros save <key> --result <file>`; contacts alone: `J write-prompt --contacts <key,key>`). Limits: X/LinkedIn under 300 chars; email subject + max 120 words. Intros need no writing consent and never hold as `writing_needs_yes`.
- **Published email only (Gmail connector):** code decides what may go; the model only sends what `J email next` hands out. Only addresses found word for word in the hiring post itself (HN comment or X post; X posts with both email and handle use email and still display the DM link) may be emailed by the skill. Addresses from people search or team pages stay drafts (`mailto:` link). Limit: 1 email per address per 90 days, no follow-ups, no attachments.
- **Approval & modes:**
  - **Default (batched yes):** `J email batch` lists ready drafts (first batch asks mode via `J ask email-mode` -> `J email mode ask` or `J consent record email`). `J ask email` builds the question call (up to 16 per group via `--group <n>`); `J email approve <ids> --skip-rest` locks approval to draft hashes; `J email next` hands out one at a time; record `J email sent <id> <message id>`.
  - **Unattended (opt-in):** separate `email` consent (bound to rules hash, refused in a batch, revocable via `J consent revoke email`) plus the person's own permission rule for the connector tool; uses `J email next --unattended`.
  - **Drafts-only or no connector:** `J email connector drafts` creates Gmail drafts (`J email sent <id> --drafted`); `J email connector none` shows text + `mailto:` link (`J email sent <id> --shown`).
- **X DMs & LinkedIn notes:** the person sends them manually from the profile link and draft text. Never open X or LinkedIn to send or read.
