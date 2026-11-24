# Prepare

For a `shortlisted` job (the person shortlisted it from the report, or said yes to a list):

1. Get the questions. Greenhouse: save the job's `questions=true` response from the public board API to a file and use it. Lever and Ashby give no form fields: pass 1 of the browser step reads the form first (references/apply.md), then continue here with the fields it returns as `[{"label","required","type","maxLength"}]`.
2. Each sheet field is tagged `fact`, `upload`, `answer` or `new_writing`; `sheet check` fails when a required field has no tag.
3. `J sheet build <key> --questions <file>`. It fills each field from the profile, saved answers, or a checked draft; it lists unanswered required fields and stops on forbidden labels.
3. Prose: `J write-prompt <key> --questions <file>` prints `{model, description, prompt}`. Make one Agent call with exactly that `model` and `prompt`. Save its reply to a file and run `J write-result <key> --questions <file> --result <file>`. A failed or empty answer holds the job as stopped and goes in the report. Prepare runs before the browser, so a long writing job never holds a form open.
4. Unknown required fields: ask the person once and store with `J answer add --label L --value V --key <job>` (kept in `answers.json` with how it was given, the date and the source application). Code reuses an earlier answer only when the normalized question is equal, the field type matches, a select answer is still one of the options and the text fits the limit; anything else is new writing. A near match goes to the person.
5. Rebuild the sheet, then `J sheet check <key>`. If it passes, the job becomes `apply_ready`. If not, it is parked with a reason and waits for the person.
