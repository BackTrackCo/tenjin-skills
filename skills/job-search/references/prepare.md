# Prepare

Every planned job (`exact` or `confirmed` employer posting, above any score floor, within `period_max`) is prepared automatically in every apply mode. Code handles Greenhouse jobs with no new writing directly in `J work` (straight to `apply_ready`). `J work` emits `prepare_due` only when a job needs new writing or a Pass 1 browser form read (every system other than Greenhouse).

## Steps

1. **Collect form questions:**
   - **Greenhouse:** save the public board API `questions=true` JSON response to a file.
   - **Lever, Ashby and other employer systems:** Pass 1 of the browser subagent reads the live form (`references/apply.md`) and returns `[{"label","required","type","maxLength","options"}]`.
   - Record real option labels word for word (never summarized ranges like `"1..12"`, which `sheet build` and `sheet check --live` refuse). Multi-control dates use `"type":"date"` and `"parts":[{"name":"Month","options":[...]},{"name":"Year","options":[...]}]`.
2. **Build the sheet:** run `J sheet build <key> --questions <file>`. Code tags every field `fact`, `upload`, `answer` or `new_writing` (untagged required fields fail `sheet check`), fills known values, lists unanswered required fields, and stops on forbidden labels.
3. **Draft prose (one Opus call per round):** run `J write-prompt --round` (covers all sheets needing writing plus round lead/contact intros), make one Agent `model: "opus"` call with the returned `model` and `prompt`, save the reply, and run `J write-result --round --result <file>`. Code validates drafts, rebuilds/checks sheets, and advances passing jobs (failed/empty answers hold the job as stopped). Single-job fallback: `J write-prompt <key> --questions <file>` / `J write-result <key> ...`. Always prepare before opening forms for filling.
4. **Resolve unknown required fields:** ask the person once and save via `J answer add --label L --value V --key <job>` (stored in `answers.json`). Code reuses an earlier answer only on exact normalized question match, matching field type, valid option and length fit; anything else is new writing, and near matches go to the person.
5. **Final check:** rebuild if needed, then run `J sheet check <key>`. Passing jobs move to `apply_ready`; failing jobs park with a reason and wait for the person.
