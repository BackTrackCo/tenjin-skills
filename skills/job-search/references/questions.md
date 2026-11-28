# Asking the questions

In an attended turn, every choice question goes through Claude Code's AskUserQuestion tool using the exact payload `J ask <kind>` prints (never a prose list). Never ask in an unattended turn: hold, notify, and ask when the person returns (`J ask` refuses in an unattended batch).

## Shape and grouping

- Short option labels with one-line descriptions; default first labelled `"(Recommended)"` or `"(from your resume)"`. No question or option text names the tool's own free-text option; code refuses one that does.
- Group questions for one moment into one call: 1 to 4 questions, 2 to 4 options each.
- **Start flow:** resume as a plain message (`J start status` `next`), then one `J ask start` call (apply mode, frequency, positions, where to apply), then the `/rc` reminder if printed, then the `referral` prompt from `J start record` as a plain message. Auto modes follow with `J ask auto`.
- **Other choice calls:** `J ask approve` / `J ask approve-pick` (groups of 12), `J ask resume`, `J ask tenjin`, `J ask optional-writing`, `J ask yes`, `J ask contacts`, `J ask follow_up`, `J ask email` (over 16 drafts: groups of 16 via `--group <n>`), and `J ask acknowledge` (legal terms with text and link).

## When to use plain text vs choices

- **Typed answers:** use a plain question with your guess in its text (`J ask place`, `J ask role`, phone, pay, address, name, and optional follow-up detail `J ask follow_up_detail`).
- **Form facts (`J ask facts`, never write your own list):**
  - Code merges identical missing facts across all prepared jobs (already-known profile/resume/saved answers fill automatically).
  - Fixed-option fields become choice calls (`calls`, max 4 questions per call, sent in order): 2 to 4 options shown verbatim (plus skip for 2-3 options); > 4 options show the first 3 plus any decline option (else the 4th), never naming "Other". Differing option lists across jobs split into separate questions.
  - Dates, names and free text come in one plain message (`plain`). Each question names its jobs.
  - Record with `J facts answer <id> <value>` or `J facts skip <id>`. Facts and approvals never share a call. Woken turns hold and push a count.
- **Rules from choices:** ask rules as choice calls and record via `J rules add --from-choice "<option label>" --effect <e> --value <v>` (typed custom text uses `--words`).
- **Voluntary demographic fields (EEO):** never a choice (`J ask eeo` is refused). Ask one plain question via `J eeo question --key <job>`, save text with `J eeo set`, match to future forms via `J eeo answer`, ask missing fields plainly (`J eeo add`), and skip optional fields with `J eeo skip <key> <field>` (required fields cannot be skipped).

## Tenjin hints

- Code computes `hint` on work items/reports at four moments: search round while Tenjin is missing/outdated/unfunded, job with no free employer posting, job with no free contact, or LinkedIn resume link. Say the hint line once.
- **Once-per-session ask (`askTenjin`):** built by code (`tenjinOffer`) using `prices` in `graph.json` (provider price plus 15% routing fee for routed queries only, never for catalog tool-id calls; never quote prices yourself). Say it exactly as printed with `J ask tenjin --json '{"line","status"}'` ("Set up Tenjin (Recommended)" / "Not now").
- On yes, follow "Install Tenjin from tenjin.sh" (`tenjin.sh/skills.md`, including funding; or `tenjin fund` if installed with zero balance). Pick no amount, change no Tenjin setting, name no seller or model. Record `J tenjin ask-done yes|no`. In unattended runs, mention only in the report.

## Referrals

- **Start question (plain message, every mode):** send `J start record`'s `referral` text after `J ask start` (repeats for auto mode only while unanswered; never reads or opens LinkedIn). Record via `J referral list set --words "<their words>"` (splits on newlines/semicolons/commas, extracts referrer after parens/colon/`via`/`through`; `"none"` saves empty), then read back in one line. Update anytime with `J referral add|remove|list`.
- **Holds & timing:** auto modes hold until answered (`referral_list_unanswered`) and hold listed companies (`referral_pending`); attended approvals show the pending referral with "Wait for the referral"; fill-only/open-only show the note without holding. After 7 days (overridable via `referral_delay_days`), `J ask referral` asks `"Is your referral at <company> in?"` -> `J referral in|notyet|without <company>`.
- **Forms & outreach:** fill referral form fields with the person's given referrer name (wins over "how did you hear"). Employee referral links are applied by the person (`J submitted <key> --referral-link`). Draft a referrer ask with `J referral draft <company>` -> `J referral draft-save <company> --text <file>`. Sending by email (`J referral email <company> <address>`) accepts only an address typed by the person in this session and always requires its own `J email approve` (never unattended or looked-up).
- **"Also worked at" hints (`J contacts warm`):** checks past employers with titles/dates from resume or LinkedIn read (small employers <= 50 people: direct overlap; larger employers: requires overlapping dates and shared team word). Shown as hints only, never contacted or treated as referrals unless the person says so.
