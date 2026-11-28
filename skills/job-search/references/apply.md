# Apply

Only the employer's own application page (`exact` or `confirmed`) off the deny list (gate 4 in SKILL.md). Greenhouse, Lever and Ashby have code adapters for board checks/questions, not a limit on where to apply. The first application on a new host shows once in `J report --all`. Applications run in parallel, one job per host at a time.

**Why "apply yourself":** the report gives one of four reasons: the host is on the deny list, the form needs an account, a bot check appeared, or no employer posting was found.

## Approvals, fill-only and opening pages

- **Apply modes (`J start record --mode`):** `attended` (default), `auto_no_new`, `auto_write`, `fill_only` ("Fill only, I submit": fills and reads back with no per-job yes, leaves tab open as `fill_ready` until the person submits), `open_only` ("Just open the pages").
- **Code-built approvals only:** use `J ask approval --key <job>` (one job) or `J ask approve` (many), never your own question. Form attestations are covered by the approval; legal terms use `J ask acknowledge --json '{"company","text","link"}'`.
- **Call ordering:** ask missing facts and legal terms first, in their own call; ask approval only after the sheet is complete. Multiple approvals may share one call when every sheet is complete, but an approval never shares a call with facts or legal terms. Save facts with `J approve <key> --facts <json>` (or `J fact set`), which does not approve.
- **Record approval:** `J approve <key>` ("Yes, apply"), `J approve <key> --fill-only` ("Fill it, I submit"), or `--via employer|site`. Many: `J approve --all`, `--all --fill-only`, `--no-new`, or `J ask approve-pick` (groups of 12). Say the state line `J approve` prints as given (if Chrome is off, it includes setup steps).
- **Withdraw:** on "stop", "don't apply" or "just fill", immediately run `J approve <key|--all> --withdraw` or `J fillonly <key> on` before anything else.
- **Open pages (`J open <key...>`, attended only):** opens exact `https` URLs in Google Chrome via OS open (never Claude in Chrome; falls back to default browser with a plain note). It refuses local and private addresses and allows deny-listed hosts because nothing is read, filled or clicked. Show each opened sheet as text; record `J submitted <key>` on the person's word. Woken turns hold these as `open_ready`.
- **Claude in Chrome:** record `J chrome set on|off` at every start and after `/chrome` reconnect (`on` clears `chrome_disconnected` and `no_chrome_tools` holds).

## Open the batch

1. **Pre-checks:** auto modes hold until the referral list is answered (`referral_list_unanswered`) and hold companies with pending referrals (`referral_pending`); attended approvals are not held. Finish all prepare steps (`J sheet build`, EEO, facts) before opening an unattended batch, since it refuses commands that modify sheets or approvals.
2. **Open:** `J batch open [--unattended] [--upload <resume>]`. `J apply next` hands out jobs only inside an open batch, once per job.
3. **Dispatch in parallel:** `J apply next --all [--unattended]` returns `handouts` (one job per host; others wait as `host_busy`). Start browser subagents for the whole set in one message as parallel Agent calls, each in its own tab. A stop on one job leaves others running except Chrome disconnects and unattended CAPTCHAs, which close the round (`J may-submit` then says no for every open job). Run `J apply next --all` again as hosts free up. The round's writer call (`J write-prompt --round`), `tenjin mcp` search needs and board API reads still run in turn.

## Where the person applies (a job site)

`apply.where` (set at start) chooses `employer`, `site` (covers LinkedIn, Indeed, YC, Glassdoor, ZipRecruiter, Wellfound, etc.), or `ask`:
- **Job site (`site`):** in an attended turn, `J site show <key>` opens the first link in `siteLinks` via `J open` with no question, and prints prepared answers (the sheet if available, else profile facts plus a short resume-grounded note) and any alternate job-site links. Show them and the link in the reply. The skill does nothing on that site (no read, fetch, fill, click or sign-in). Woken turns open nothing and hold as `open_ready`. Jobs with no job-site link use the employer site.
- **Ask each job (`ask`):** `J ask approval --key <job>` offers `"Employer's site (I apply)"` (`J approve <key> --via employer`), `"<Site> (you apply)"` (`J approve <key> --via site`), and `"Skip this job"`. Unattended turns hold these.
- **Follow-up:** counts toward `period_max`. On the next attended turn ask once via `J ask applied --key <job>` and record `J site applied <key> yes|not_yet|skip` (applied is recorded only on the person's word).

## Complete sheet before fill (Remote Control ready)

Assume the person may answer from their phone and cannot touch Chrome:
- **Pass 1 (`J sheet check <key> --live <file>`):** read real option labels word for word; multi-control dates use `"type":"date"` and `"parts":[{"name","options"}]` (summaries like `"1..12"` are refused). Every required field needs an answer before filling; missing required fields hold as `needs_facts` (ask in attended session, `J answer add`, rebuild `J sheet build <key> --questions <live file>`, re-check; unattended turns hold and notify).
- **Acknowledgments:** ask legal terms with `J ask acknowledge` before filling (`J agree <key> <label>`). Attestations are covered by approval in submit modes and asked with acknowledgments in fill-only mode.
- **Read-back (`J sheet readback <key> --read <file>`):** read values from form state (`read_page`), never a screenshot alone (multi-part dates return `"parts":[{"name","value"}]`). Re-fill mismatched fields once; if still mismatched, hold as `fill_problem` and show the field and form value.
- **Optional fields:** follow optional-writing preference; fill optional fields the profile or resume already answers.
- **Finish fill-only from phone:** `J ask approval --key <job>` on `fill_ready` offers `"Submit it now"` (`J approve <key> --submit-now`), `"I'll submit in Chrome"`, `"Not this one"`. `J apply next --all` then hands it out (`fromFilled`) to verify `J may-submit` and submit (re-filling in one pass if the tab closed).

## The browser subagent (Agent `model: "haiku"`, one per application)

Include gate 8's rules in the task prompt (nothing in code sees its clicks). Pass only the handout URL, sheet fields and resume path. Fill and submit happen in one browser pass after the yes (never pre-fill before approval), with a read-back against the sheet hash stopping any difference before submit; non-API systems (Lever, Ashby, custom sites) do a Pass 1 read at prepare time and close the tab.

1. Open the handout URL in its own tab and read live form fields.
2. **Pass 1:** return live fields JSON for `J sheet check <key> --live <file>` (missing/changed fields or off-host redirects stop the job).
3. **Pass 2:** fill fields with `form_input`; stage resume via `J uploads stage <key>`, upload staged path via `file_upload`, immediately run `J uploads unstage <key>` on success or failure; read form values back (at most one screenshot) for `J sheet readback <key> --read <file>`.
4. **Submit:** only when `handout.submit` is true (never in dry run or fill-only) AND `J may-submit <key> <sheet hash>` returns yes right before clicking. Return status, filled fields JSON and any problems.
5. **Outcome:** record `J ops` transition `submitted` with URL, filled fields and confirmation text (say "submitted"; say "confirmed" only on page/email confirmation). If Chrome tools are absent or fail, hold (`J stop` / `stopped`) and never retry on another model.

## Stops, unattended and fill-only

- **Stops:** `J stop <key> --kind upload_blocked|captcha|login|email_code|assessment|account|unknown_field|injection_suspected|chrome_disconnected|no_chrome_tools`. On `chrome_disconnected`, tell the person to run `/chrome` and close the batch (`J batch close`). Unattended batches auto-close when empty, on CAPTCHA or Chrome disconnect, or after 2 hours idle. Resume resolved stops with `J unpark <key>`.
- **Unattended:** requires unattended consent, rules and a confirmed dry run (`handout.dryRun` -> `J dryrun record <key> '<json>'` -> `J dryrun confirm`). New writing requires separate writing consent; without it, jobs queue as `writing_needs_yes` (`J writing approve <key> [--edits file.json]`). Optional writing follows `skip` (`handout.skipFields`) or `wait`. Changing writing rules invalidates writing consent.
- **Fill-only (`J fillonly <key> on` or `fill_only` rule):** hands out `submit: false, fillOnly: true`. Fill, read back, leave tab open, run `J fill done <key>` (`fill_ready` notification); record `J submitted <key>` once the person submits.
