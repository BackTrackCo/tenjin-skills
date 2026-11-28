# Setup and the start

Setup asks only what it needs now; the rest comes when it matters. `J tenjin` sets the state (`missing`, `outdated`, `unfunded`, `ready`): when `ready`, run routed search in code (`J route`) and never offer a free-only search first; without a funded Tenjin, ask to install, update or fund Tenjin (naming benefits and prices via `J search plan` / `J ask tenjin` -> `J tenjin ask-done yes|no`) before falling back to free search (references/questions.md).

## The first run, in order

1. **The resume (plain question):** say the `next` text of `J start status` as given. Never ask for a file location or search the person's files. Save with one of:
   - `J resume set --file <file>` (a dragged file or given file; for PDF/Word, read it with your file reader then save text via `J resume set --text`).
   - `J resume set --url <link>` (code fetches public `https` links once, max 3 redirects, refusing local/private/denied hosts; PDF saves as `resume.pdf`, page as `resume.txt`; if sign-in is needed, use a connected tool or ask for a public link, file or text).
   - `J resume set --text` (text on stdin).
   - **LinkedIn profile link:** never fetch or open it. With Tenjin, code reads it via the router (`linkedin_profile`); without Tenjin, it is a hint moment and you ask for a PDF export (LinkedIn: More -> Save to PDF) or text. If the read returns job titles and dates (`roleHint`), take role/role words from it (`search.sources`: `linkedin`), confirm the role with a choice question, and keep titles/dates for warm-path checks; employers-only reads stay thin.
   - **Uploads staging:** a resume file is copied into `~/.tenjin-skills/job-search/uploads/` (0700). Before each upload, `J uploads stage <key>` copies it to `.job-search-upload/<name>` in the working folder (`CLAUDE_PROJECT_DIR` or cwd) and `J uploads unstage <key>` deletes copy and folder right after, on success or failure. An unwritable folder fills without the file and notes it once in the report. A text-only resume holds forms needing a file as `needs_resume_file`.
2. **Read search fields from the resume** (never an open question): role, role words (synonyms and levels), place (exact city if given) and remote (only if stated). Save with `J profile set` (`search.sources`: `resume`). Only if genuinely ambiguous (two tracks, no recent role), ask one choice: `J ask resume --json '{"header","question","guess","next"}'` with the guess first as `"(from your resume)"`.
3. **One question-tool call** (`J ask start`, mark "Four quick choices" done after `J start record`):
   - **Apply mode:** `"Ask me each time (Recommended)"` (default), `"Auto apply"` (follows up with `J ask auto`: approve new answers vs fully auto), `"Fill only, I submit"`, or `"Just open the pages"`. With Chrome off (`J chrome set off`), options needing Chrome carry a note.
   - **Frequency:** `daily`, `twice_daily` or `weekly`.
   - **Positions:** `"50 now, 10 daily (Recommended)"`, `"100 now, 20 daily"`, `"20 now, 5 daily"`, `"No limit"` (`--no-limit`, records nothing), or `"Other"`. Catch-up applies once to the first period; the daily max applies after (split across `twice_daily`, multiplied by 7 for `weekly`). It is a maximum, not a target.
   - **Where to apply:** `"Employer's site (Recommended)"`, `"A job site, I apply"` (opens the job-site page in Chrome with answers, does nothing on the site), or `"Ask me each job"` (`--where employer|site|ask`, `apply.where`, references/apply.md).
   - Record with `J start record --mode attended|auto_no_new|auto_write --frequency daily|twice_daily|weekly --catch-up <n> --per-day <n>|none --words "<their words>"` (changeable later outside a batch via `J start record` or `J frequency set`). Say the reminder line `J start record` prints if any (built from `J rc set`, push history and read-only Claude Code push settings; never a question, at most once per start). Do not stop silently mid-setup after saving the resume, search fields or start choices.
4. **Auto mode extras (shown back for a clear yes):** unattended rules (`profile.unattended`: `roles`, `places`, `remote`, `minPay`, `excludeCompanies`, `excludeLevels`, `minScore`, `hosts`: hiring systems or `*`), then `J consent record unattended --optional-writing skip|wait` (`J ask optional-writing`), plus `J consent record writing` for fully auto. A dry run precedes the first unattended submit.
5. **First search, report and loop status** in the same session (`J work`, references/search.md): with Tenjin `ready`, run routed search (`J route`, `J hn`, `J yc` and watched boards); without a funded Tenjin, ask to install, update or fund Tenjin first (`J search plan` -> `J ask tenjin` -> `J tenjin ask-done yes|no`) before falling back to free search. The first report says what was searched and from where. Start `J watch` last (in Claude Code) and end every setup and round reply with one explicit **Loop status** line saying whether the background loop (`J watch`) is running now or not (and what setup step or schedule choice it is waiting on if not).

## Later, at their trigger

- **Leaving items:** `J leave search web need:<kind> --reason no_web_search` (returns next period) and `J leave contacts:<jobkey> --reason none_found`; never leave a post batch. `J retry <key>` retries on the person's word; `J fact set account <host>` marks an existing account so a `sign_in` job returns.
- **Form facts (phone, work authorization, sponsorship, pay):** job holds as `needs_facts`; ask merged across jobs with `J ask facts` (references/questions.md) and save with `J facts answer <id> <value>` (or `J fact set <name> <value>`).
- **Voluntary demographic fields (EEO):** at the first form with them, ask one plain question (`J eeo question --key <job>`, never a choice) and save as text (`J eeo set`). On later forms match saved text to options (`J eeo answer <key> <field label> <option>`). Never guess an unanswered field: ask plainly for that field only (`J eeo add`), or skip optional fields (`J eeo skip <key> <field label>`, saved so future forms skip it; required fields cannot be skipped). In auto mode, a woken turn with missing EEO holds as `eeo_missing` with one notification until the next attended turn.
- **Watched companies:** never suggested or asked about. Added only when the person names a company or pastes a careers link: `J watch add <company or careers link>` (`profile.watch`; if no board is found, say the one plain line returned, not a question). Stays until `J watch remove <name>`.

## Profile shapes

`J profile set '<json>'` validates shapes and refuses bad ones:
- `places` (string[]), `remote`, `includeOld`, `updates`, `hn`, `yc` (booleans)
- `frequency` (`daily`|`twice_daily`|`weekly`), `windowDays` (> 0), `sweepHour` (0 to 23)
- `watch` (`[{"url"}]`), `apply` (`{"where": "employer"|"site"|"ask", "source": "person"}`)
- `search` (`{"role","place","remote","roleWords","variants","sources"}` with source `resume`|`linkedin`|`person`; `search.role` and `search.roleWords` also filter watched-board titles)
- `facts` (string/number/boolean map), `eeoText` (person's own words; legacy `eeo` is refused until cleared via `J profile set '{"eeo": null}'`), `unattended` (`roles`, `places`, `excludeCompanies`, `excludeLevels`, `hosts` string[]; `minPay`, `minScore` numbers)

## Other setup notes

- **Watcher:** `J watch` runs in the background (`run_in_background`), ticks every minute, stays silent while quiet, and exits 0 with one line when actionable work is due (start it last after `J work --commit`; it refuses while due work is unclaimed). Stale or dead-PID leases are reclaimed by `J arm`, and commands report `watcher: stopped` until restarted.
- **Unattended permissions & Chrome:** the skill writes no settings allow rules, so woken turns can hit a permission prompt. Visit each allowed host's public board page once with the person present so Chrome allows it for the session; keep Chrome open, computer awake and session open.
- **Resume after restart:** After `claude --chrome --resume` nothing runs by itself: when the person messages, run the every-start sequence (`J tenjin`, `J start status`, `J chrome set on|off`, `J rc set on|unknown`, `J arm`, `J work --commit`, `J watch` last).
- **Push failures:** `J notify result not_sent --reason off|present|none` (`off`: say `/config` sentence once; `none`: both sentences once; `present`: nothing).
- **Updates & lessons:** gate-changing/major updates wait as `update_waiting` (`J release apply` on yes; `J release check` checks now) and never alter rules, profile or writing rules. After stops, `J lessons derive` records tighten-only expiring lessons (`J lessons`, `J rules remove <id>`).
