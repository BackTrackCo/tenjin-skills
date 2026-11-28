# Send

## Parked drafts file (default)

Nothing asks about a draft and nothing waits on one. After `G write-result`, code writes or appends to `drafts/YYYY-MM-DD.md` in the state folder (or `G profile set drafts.dir <folder>`, which must exist and be writable). Say "N drafts in <full path>" and restart `G watch` immediately.

- Each lead section has a stable id, source link, author, reason, short escaped blockquote of the post, `Channel:` (editable to any listed under `Allowed:`), editable fenced draft block, and `Decision: [ ] send  [ ] skip`. Email sections name the recipient address and note that code adds the footer.
- `G drafts sync` (run automatically by `G work` on start/wake, and manually when the person says they reviewed drafts) reads back only `Channel:`, `Decision:` and fenced draft blocks. Quoted posts never count as controls. Completed sections get an `Outcome:` line; invalid marks (too long, missing address, both boxes ticked) get a `Note (code):` line without overwriting the person's text.
- **Social `send` mark:** records approval and queues `open_due`. The report says `"N approved replies to open: say open them"`. Only in an attended turn when asked, `G open --approved` opens the next page in Google Chrome with the text on the clipboard; the person presses send and confirms (`G sent <key>`). A woken turn opens nothing. Never click, fill, script or use Claude in Chrome on social sites.
- **Email `send` mark:** records approval for that exact address and edited text, re-checks footer/opt-out/suppression, and queues `email_due`.

## Email (Gmail connector)

The skill holds no mail credential; it uses the person's connected Gmail tool only after recorded approval for that exact email.

- **Connector mode** (set once from visible tools): `G email connector send` (can send), `drafts` (drafts only; person sends in Gmail) or `none` (show text and `mailto:` link). Unattended sends also require the person's own permission rule for the send tool; say so, never write it.
- **Direct lookup or approval** (when an email lead has no address yet, its address changed after drafting, or approving via `G pick <key> email`):
  1. `G email resolve <key>` uses a published address or, with Tenjin, looks up and verifies a company-domain address (charges on miss; free-mail addresses are dropped) and prints the exact address, subject, text with code-built footer, country and delivery mode.
  2. `G ask email <key>` builds the approval question showing the exact text; on yes run `G email approve <key> --id <id>`. Any edit needs a fresh yes. If `sender.name` or `sender.postal` is missing, ask and save them first (and before recording unattended email consent).
- **Sending (`email_due`):** `G email next` hands out one approved email (from the drafts file or `G email approve`). Send exactly that to that address only (or create a draft in `drafts` mode / show `mailto:` in `none` mode), then record `G email sent <id> <message id> --thread <thread id>` (add `--how drafted` or `--how shown`). Found addresses in Germany, Austria, Canada or Australia always come as `drafts`. Never edit text or footer.
- **Unrecorded handouts (`unknown_due`):** if a turn ends after `G email next` without `G email sent`, it is never handed out again and becomes `unknown`. Ask the person whether it went and run `G email unknown <id> sent|not_sent`.
- **Replies (`replies_due`):** at most daily for 30 days, `G replies due` lists only threads this skill sent. Read only those threads and record `G reply <id> replied|opt_out|bounce|not_interested [--text "<the reply>"] [--company]`. Any reply stops further contact; opt-out, bounce or "not interested" suppresses the person permanently (`--company` suppresses the whole domain).
- **Unattended email (opt-in):** requires the person's own rules, `G consent record email` in an attended turn (bound to sender details and rules; changing either revokes it), and a confirmed dry run (`G dryrun confirm`). Without consent, unattended turns only create drafts.

## Follow-up (opt-in rule)

`G rules add --effect follow_up --value 4 --words "<their words>"` enables one follow-up per person after N days. `follow_up_due` waits for the person and never wakes you. Attended: `G follow-up ask` (up to four yes/no questions per call); yes runs `G follow-up start <key>` (creates a follow-up lead that goes through the writer, the drafts file and send, with the first message as data); no runs `G follow-up skip <key>`. Any reply ends it permanently (`G replied <key> [--opt-out]` for social, `G reply <id>` for email).
