# Send

## Approve and send on a social site

`approve_due` waits for the person; it never wakes you. In an attended turn, `G ask pick` builds one question per group of up to four drafted leads, with the channel as the options (reply where they posted, a message, a LinkedIn note, email, skip). Make one AskUserQuestion call per group, in order, and record each answer: `G pick <key> <channel|skip>` (the channel for a label is in `labels[key]`). Code checks suppression and the contacted ledger again at the pick and refuses a person who opted out or was already written to.

For a picked reply on X, Reddit, LinkedIn or Hacker News: `G open <key>` opens the page in the person's own Google Chrome and puts the text on the clipboard. On X the page is the reply page with the text filled in (the clipboard holds it too). Say its `say` line. The person presses send and tells you: then `G sent <key>`. Never click, fill or script on those sites, and never use a Claude in Chrome tool for them. `G open` and `G sent` are refused in an unattended turn.

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
