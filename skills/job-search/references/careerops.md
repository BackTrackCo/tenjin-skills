# Career-ops folders

A career-ops folder has `cv.md`, `config/profile.yml` and `data/pipeline.md`. Inside one:

- `J setup careerops` reads `cv.md` and `config/profile.yml` and saves the resume text. Ask nothing they already answer.
- Dedupe also skips the URLs in `data/pipeline.md`, `data/applications.md` and `data/scan-history.tsv`.
- Only on the person's yes at setup (`--pipeline yes`), `J pipeline add` appends each job that passed review under `## Pending` (the heading is added if it is missing), one line each, and changes no other file:

```
- [ ] <job URL> | <Company> | <Role> | <Location> | note: write to <name, role>[, not confirmed] (<source link>)
```

The note is left out when no person was found. Then tell the person that `/career-ops pipeline` scores these jobs and tailors their CV. `pipeline add` is refused while a batch is open.

## Credit

The pipeline line format and the career-ops steps are adapted from [vraspar/find-jobs](https://github.com/vraspar/find-jobs), MIT licensed. The format is reproduced as is, so its notice follows:

```
MIT License

Copyright (c) 2026 vraspar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
