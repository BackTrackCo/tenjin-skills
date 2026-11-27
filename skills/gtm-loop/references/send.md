# Send

## Approve and send on a social site

`approve_due` waits for the person; it never wakes you. In an attended turn, `G ask pick` builds one question per group of up to four drafted leads, with the channel as the options (reply where they posted, a message, a LinkedIn note, email, skip). Make one AskUserQuestion call per group, in order, and record each answer: `G pick <key> <channel|skip>` (the channel for a label is in `labels[key]`). Code checks suppression and the contacted ledger again at the pick and refuses a person who opted out or was already written to.

For a picked reply on X, Reddit, LinkedIn or Hacker News: `G open <key>` opens the page in the person's own Google Chrome and puts the text on the clipboard. On X the page is the reply page with the text filled in (the clipboard holds it too). Say its `say` line. The person presses send and tells you: then `G sent <key>`. Never click, fill or script on those sites, and never use a Claude in Chrome tool for them. `G open` and `G sent` are refused in an unattended turn.
