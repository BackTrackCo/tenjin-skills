# Send

## Drafts are parked in a Markdown file

Nothing asks about a draft and nothing waits on one. After `G write-result`, code writes (or adds to) the day's file, `drafts/YYYY-MM-DD.md` in the state folder, or in the folder the person set with `G profile set drafts.dir <folder>` (it must exist and be writable). Say "N drafts in <full path>" and carry on: start the watcher again at once.

Each lead has a section with a stable id: its source link, the author as the platform shows it, the reason, the post as a short blockquote, a `Channel:` line (the person may change it to another channel listed under `Allowed:`), the draft in a fenced block they edit, and one line, `Decision: [ ] send  [ ] skip`. An email section also names the address it goes to and says the footer is added by code.

The person reads and edits on their own time. `G drafts sync` (run at every start and wake by `G work`, and when they say they reviewed the drafts) reads their marks back. Only the `Channel:` line, the `Decision:` line and the text in the fenced blocks count; a quoted post never does, and code escapes control-like lines in it. A section is marked with its outcome and the person's own text is never rewritten or deleted. A new round only adds new sections to that day's file. Code writes a `Note (code):` line when a mark is not ready (too long, no address yet, both boxes ticked), and the person fixes it and ticks again.

A `send` on an email is the person's yes for that exact address and edited text. Code re-checks the footer, the opt-out line and suppression, and `email_due` follows: send exactly what `G email next` hands out. A `send` on a social reply records the yes and becomes `open_due`: the report says "N approved replies to open: say open them". It waits for the person. In an attended turn, when they say so, `G open --approved` opens the next one in their own Google Chrome with the text on the clipboard; they press send and tell you, then `G sent <key>`. A woken turn opens nothing. Never click, fill or script on those sites, and never use a Claude in Chrome tool for them.

## Email

The skill holds no mail credential. It uses the Gmail tool the person connected to Claude, and only after the person's yes on that exact email.

**Connector mode.** Once, from the tools you can see: `G email connector send` (a connected Gmail tool that can send), `drafts` (it can only make drafts: the person presses Send) or `none` (no Gmail tool: the text with a `mailto:` link). In auto mode a connected tool may send with no prompt, so this skill's own recorded yes is the gate. An unattended send also needs the person's own permission rule for that send tool; say so, never write it.

**For a picked email** (`G pick <key> email`):
1. `G email resolve <key>` finds the address. A published address needs no lookup. Otherwise, with Tenjin, a work-email lookup (it charges on a miss) and a check run in code; only an address at the person's company domain that the check calls `valid` can be used, and a found free-mail address is dropped. It prints the exact email: address, subject, the text with the footer code built, the country and how it will leave.
2. `G ask email <key>` builds the yes question. Show the exact text in it. On yes: `G email approve <key> --id <id>`. A changed word is a different email and needs its own yes. No postal address in the profile, no email: ask for it and save it as `sender.postal`.
3. `email_due`: `G email next` hands out one approved email. Send exactly that, with the Gmail tool's send, to that address only (mode `drafts`: its draft tool; mode `none`: show the text and the mailto link), then `G email sent <id> <message id> --thread <thread id>` (add `--how drafted` or `--how shown`). A found address in Germany, Austria, Canada or Australia always comes as `drafts`. Never edit the text or the footer.
4. If a turn ends with an email handed out and no result recorded, the next `G email next` never hands it out again: it becomes `unknown`. Ask the person whether it went and record `G email unknown <id> sent|not_sent`.

**Replies.** `replies_due` (at most once a day, for 30 days): `G replies due` lists the threads this skill sent. Read only those, with the Gmail tool's thread read. Record each with `G reply <id> replied|opt_out|bounce|not_interested [--text "<the reply>"] [--company]`. Any reply ends further contact; an opt-out word in the text, a bounce or "not interested" suppresses that person for good; `--company` suppresses the whole domain. No reply classifier: the person reads replies in Gmail.

**Unattended email** is opt-in: the person's own rules, `G consent record email` on their own words in an attended turn (it is bound to their sender facts and rules, and a change to either ends it), and a dry run first: an unattended round records what it would send and sends nothing; the person reads it and runs `G dryrun confirm`. Without the consent an unattended turn only makes drafts.

## Follow-up (only if the person's rule says so)

`G rules add --effect follow_up --value 4 --words "<their words>"` makes one follow-up per person possible, 4 days after the first message. `follow_up_due` waits for the person and never wakes you. Attended: `G follow-up ask` builds one yes or no question per person, four to a call; yes: `G follow-up start <key>`, which makes a lead of its own on the same channel that goes through the writer, the pick and the send like any other (the writer gets the first message as data); no: `G follow-up skip <key>`. Any reply ends it for good: `G replied <key>` (X, Reddit, LinkedIn, Hacker News; add `--opt-out` to suppress) or `G reply <id> ...` (email). A follow-up is never offered a second time, and the first message's day is never reset.
