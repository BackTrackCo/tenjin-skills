# Track and follow up

- **Application statuses:** `submitted`, `confirmed`, `interview`, `offer`, `rejected`, `withdrawn`, `closed` (record transitions via `J ops`).
- **Skip reasons:** `too_senior`, `too_junior`, `place`, `pay`, `company`, `stack`, `other`.
- **Follow-up (`follow_up_due`, attended only):** 14 days after `submitted`, ask the person what happened via `J ask follow_up --json '{"company","title"}'` and record the outcome via `J outcome <key> --status reply|interview|rejected|offer|no_reply` (or `J ops` signal: `reply`, `interview`, `rejection`, `offer`). Never contact an employer on the person's behalf.
