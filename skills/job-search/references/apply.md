# Apply

Only the employer's own posting on Greenhouse, Lever or Ashby (`exact` or `confirmed`), never a job platform or a Y Combinator site: LinkedIn, Indeed, Glassdoor, ZipRecruiter and similar ban automated use, and the YC Terms of Use ban automated access to news.ycombinator.com and workatastartup.com. One application at a time.

## Open the batch
1. `J batch open` (add `--unattended` for an unattended batch). Run the probe command it prints, then `J guard selftest`. If it fails, stop: apply waits, notify with the reason `guard_missing`.
2. Attended: show the person the list of sheets (each with its filled fields). They say yes to all or some. Record each: `J approve <key>`. A changed sheet needs a new yes.
3. `J apply next` (or `--unattended`). It prints `handout` or `refused` and the `queue` with reasons. `deepseek_on` means turn DeepSeek off or apply by hand.

## The browser subagent (Agent `model: "haiku"`, one per application)
Give it only the handout's URL, the sheet's fields and the resume path. It uses Claude in Chrome tool calls, in its own tab, and:
1. Opens the URL. 2. Reads the form fields. 3. Pass 1: returns the live fields as JSON; the main session runs `J sheet check <key> --live <file>`. A field the sheet lacks, a changed field or a redirect to another host stops the job.
4. Pass 2: fills each field with `form_input` by reference, uploads the resume with `file_upload`, reads the values back, at most one screenshot. The main session runs `J sheet readback <key> --read <file>`; a mismatch stops before submit.
5. Submits only when `handout.submit` is true (never in a dry run). Returns a short result: status, filled fields as JSON, problems.

If the subagent has no Chrome tools or fails, hold the job (`J ops` transition `stopped`), report it, and do not retry on another model.

After a submit, `J ops` transition `submitted`; record the URL, filled fields and confirmation text. Say "submitted"; say "confirmed" only when the page or a forwarded email confirms.

## Stops
A bot check or unknown field: `J stop <key> --kind ...`. Chrome gone: `J stop <key> --kind chrome_disconnected` and tell the person to reconnect with `/chrome`. Then `J batch close`. An unattended batch also closes in code when `apply next` finds nothing left to submit, or on a captcha or `chrome_disconnected` stop; a batch with no activity for two hours is closed by the next `J work`.

## Unattended
New writing needs the writing consent, which is separate from the unattended one. Without it, `apply next` queues the job as `writing_needs_yes` (one notification, no submit): show the draft, and on the person's yes `J writing approve <key>` (add `--edits file.json` for edited text); the fields become earlier answers and the job returns to the queue. Optional writing fields follow the recorded choice: `skip` leaves them empty (`handout.skipFields`), `wait` holds the job. A changed writing rule makes the writing consent stale.

First batch is a dry run (`handout.dryRun`): fill and read back, submit nothing, `J dryrun record <key> '<json>'`. The person reviews, then `J dryrun confirm`. After that, `J apply next --unattended` submits only jobs that pass the rules. After each run give one report.

## Fill-only

For a job with `J fillonly <key> on`, or under a `fill_only` rule (every job, or a named company), `apply next` hands out `submit: false` and `fillOnly: true`. Fill, read back, never submit, leave the tab open, then `J fill done <key>`: one notification, `fill_ready`. The person checks the tab, presses submit and says so; then `J submitted <key>`. No yes is needed for a fill, because nothing is submitted.
