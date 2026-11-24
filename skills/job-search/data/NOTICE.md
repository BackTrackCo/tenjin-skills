# Attribution: employer registry

`employers.tsv` is derived from the employer registry of career-ops.

- Source: https://github.com/career-ops-hq/career-ops, folder `employers/`, files `boards/greenhouse/`, `boards/lever/` and `boards/ashby/`.
- Commit: `1ef2ea0da345853771cf5bf277b87322d4671ecf`.
- License: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/. The registry's own LICENSE says: "Employer registry by the career-ops contributors, CC BY 4.0, https://github.com/career-ops-hq/career-ops".
- Changes: we kept only rows for Greenhouse, Lever and Ashby, dropped rows marked retired, and reduced each row to four tab-separated columns (ats, region, board, name). Nothing else was changed. The columns are ats, region (us or eu), board token, employer name.

No other file of career-ops is included. Its code is MIT licensed and is not used here.
