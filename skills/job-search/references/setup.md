# Setup and the start

Setup asks only what it needs now; the rest comes when it matters. Nothing here asks about Tenjin or stops for it: `J tenjin` only sets the hint state (`missing`, `outdated`, `unfunded`, `ready`), and Tenjin comes up as a recommendation at a hint moment, after a free result (references/questions.md).

## The first run, in order

1. **The resume path**, a plain question: "Which file is your resume?" `J setup resume <path>` reads only that path. A placeholder or a missing file asks again and reads nothing. Never search the person's files. In a career-ops folder (`cv.md`, `config/profile.yml` and `data/pipeline.md` all there) run `J setup careerops` instead: it reads `cv.md` and `config/profile.yml`, and you ask nothing they already answer. Dedupe then also skips the URLs in `data/pipeline.md`, `data/applications.md` and `data/scan-history.tsv`. Ask once whether each job that passes review may be added under `## Pending` (references/careerops.md); on a yes `J setup careerops --pipeline yes`.
2. **Read the rest from the resume**, never as an open question: the role, the role words for the search rounds (synonyms and levels), the place (as the resume gives it, so a city stays that city) and remote (only if the resume or the person says remote). Save with `J profile set` and `search.sources` saying `resume` for each. Where the resume really leaves one open (two tracks, no recent role), ask one choice question: `J ask resume --json '{"header","question","guess","next"}'`, the guess first as "(from your resume)".
3. **One question-tool call**: `J ask start` prints it. Four questions: the apply mode (attended is the default; "Auto apply only when there are no new questions"; "Auto apply, and also write new answers"), the search frequency (every day, twice a day, once a week), the positions per period (up to 10, 5 or 20, or "Other": any number, or "no limit"; no answer means no limit), and Remote Control (the person turns it on; the skill changes no setting; it is offered once). Record the answers: `J start record --mode attended|auto_no_new|auto_write --frequency daily|twice_daily|weekly --positions <n>|none|skip --remote-control now|later --words "<their words>"`. Change them later, outside a batch, with the same command or `J frequency set`.
4. **An auto mode also needs**, shown back for a clear yes: the unattended rules (`profile.unattended`: `roles`, `places`, `remote`, `minPay`, `excludeCompanies`, `excludeLevels`, `minScore`, `hosts`), then `J consent record unattended --optional-writing skip|wait` (the person picks; `J ask optional-writing`). For "also write new answers", `J consent record writing`. The dry run comes before the first unattended submit.
5. **Then the free search and the report** in the same session (`J work`, references/search.md). The first report says what was searched, from where.

## Later, at their trigger

- A form fact (phone, work authorization, sponsorship, pay): the job holds as `needs_facts`; ask then (`J ask fact` for fixed answers), save with `J fact set <name> <value>`.
- The EEO choice, at the first form that has voluntary demographic questions: `J ask eeo`, then `J profile set '{"eeo":"decline_all"}'`.
- A watched company: there is no question. A board joins the list when one of its jobs passes review; the person can paste a careers link (`profile.watch`, `[{"url": "..."}]`) or remove a company (`J watch remove <name>`).

## Profile shapes

`J profile set '<json>'` checks the shape and refuses a bad one with the reason: `places` list of strings, `remote`, `includeOld`, `updates`, `hn` true or false, `frequency` daily, twice_daily or weekly, `windowDays` positive number, `sweepHour` 0 to 23, `watch` list of `{"url"}`, `search` `{"role","place","remote","roleWords","variants","sources"}` (lists of strings; `sources` says `resume` or `person` for each value), `facts` object of text, number or true/false, `eeo` `"decline_all"` or `{"answers": {...}}`, `unattended` (lists of strings; `minPay`, `minScore` numbers), `careerOps`. `search.role` also filters watched-board titles by its words; `search.roleWords` widens it.

## Other setup notes

- Unattended turns that the Monitor wakes can stop at a permission prompt, because the skill's `allowed-tools` grant clears at the next message; this skill writes no allow rules into settings. Open each allowed host's public board page once with the person present so Chrome allows the site for the session. Chrome stays open, the computer awake, the session open.
- A daily Desktop scheduled task running `/job-search sweep only` is an option for someone who will not keep a session open. It never applies.
- The skill never installs Tenjin unasked, and changes no Tenjin setting.
