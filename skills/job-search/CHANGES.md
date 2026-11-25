# Changes

## 0.1.0

First release. Job Search finds jobs that fit a person, checks that each is still open, ranks them and prepares the application.

- Searches: watched company boards (Greenhouse, Lever, Ashby), Hacker News hiring threads, free web searches, and with Tenjin searches that run in code, including job boards and X hiring posts. Every job is found again on the employer's own application page; a job on a site whose terms ban automation is never automated.
- Apply: through Claude in Chrome, attended with a yes on each application or unattended under the person's own rules, consents and a dry run first, with fill-only and open-the-page modes. New writing has its own consent.
- Contacts: a hiring manager or team lead for a job, with an example intro the person sends, and an email only to an address the poster published.
- Safety: no hook; the gates are in SKILL.md and code refuses what a gate forbids. The person's data stays on their computer.

The search sources, the search rounds and the contact rules build on [vraspar/find-jobs](https://github.com/vraspar/find-jobs).
