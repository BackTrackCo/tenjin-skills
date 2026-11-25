# Asking the questions

In an attended turn, every question that has choices goes through Claude Code's question tool (AskUserQuestion), not a list in prose. `J ask <kind>` prints the exact payload; pass it as the tool's input.

- Each option has a short label and a one-line description. The default is the first option, labelled "(Recommended)", or "(from your resume)" for a resume guess. The tool adds its own "Other" free-text answer.
- Group the questions of one moment in one call: 1 to 4 questions, 2 to 4 options each.
- The start: the resume as a plain question (a file, a link or the text), then one call (`J ask start`) with the apply mode, the search frequency, the positions and where to apply, then the `/rc` reminder line (not a question). Many sheets at once, attended: `J ask approve`, then `J ask approve-pick` for the groups of 16.
- The same tool for: the role, place or remote when the resume leaves it open (`J ask resume`), the Tenjin ask (`J ask tenjin`), the EEO choice (`J ask eeo`), the optional-writing `skip` or `wait` (`J ask optional-writing`), the attended yes for a sheet when it fits (`J ask yes`), and a missing fact with fixed answers (`J ask fact`, with "Skip this job").
- A rule is a question-tool call too ("Skip clearance and citizenship-restricted jobs?", "Add remote or Canada?"): never ask for exact words in prose. Record the chosen option with `J rules add --from-choice "<the option label>" --effect <e> --value <v>`: the label is the person's words, with the date. Text typed through "Other" goes in `--words` the usual way.
- A fact with no fixed answers (a phone number, pay) can be a plain question, or the tool with "Skip this job" and the answer through "Other".
- Never in an unattended turn: nobody can answer. Hold the job, send the notification, and ask when the person is back. `J ask` refuses in an unattended batch.

## Tenjin hints

Code computes a `hint` on a work item or report row at these moments, so the model never decides when to mention Tenjin: the daily search while Tenjin is missing, outdated or unfunded; a job whose free steps found no employer posting; a job whose free ways found no contact. Say the hint's line once. The ask comes at most once per session (`askTenjin` on the item): "Install Tenjin and add funds?" with `J ask tenjin --json '{"line","status"}'`. On a yes, follow the "Install Tenjin from tenjin.sh" flow at tenjin.sh/skills.md, which includes the funding step; if Tenjin is there with no balance, run the CLI's own `tenjin fund`. Pick no amount, change no Tenjin setting, name no seller and no model. Record the answer with `J tenjin ask-done yes|no`; a no is kept with its date, and the ask waits for the next session. In an unattended run, only mention it in the report.

The once-per-session ask lists everything Tenjin adds, built by code (`tenjinOffer`): the current moment's gain first, then every other line (more job sources, the employer board search in code, the employer's own application page, a hiring manager or team lead where the free ways found nobody, a LinkedIn link as the resume, and that these searches run in the background in code with none of your Claude usage), then the cost line. Say it exactly as `J` prints it; a hint is only its moment's one line.
