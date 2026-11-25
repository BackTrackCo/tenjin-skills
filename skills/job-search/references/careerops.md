# Career-ops folders

A career-ops folder has `cv.md`, `config/profile.yml` and `data/pipeline.md`. Inside one:

- `J setup careerops` reads `cv.md` and `config/profile.yml` and saves the resume text. Ask nothing they already answer.
- Dedupe also skips the URLs in `data/pipeline.md`, `data/applications.md` and `data/scan-history.tsv`.
- Only on the person's yes at setup (`--pipeline yes`), `J pipeline add` appends each job that passed review under `## Pending` (the heading is added if it is missing), one line each, and changes no other file:

```
- [ ] <job URL> | <Company> | <Role> | <Location> | note: write to <name, role>[, not confirmed] (<source link>)
```

The note is left out when no person was found. Then tell the person that `/career-ops pipeline` scores these jobs and tailors their CV. `pipeline add` is refused while a batch is open.
