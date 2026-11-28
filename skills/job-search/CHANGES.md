# Changes

## 0.1.0

First release. Job Search finds jobs that fit a person, checks that each is still open, ranks them and prepares the application.

- **Searches:** watched company boards you ask for (Greenhouse, Lever, Ashby), Hacker News hiring threads, public Y Combinator job pages (logged out, discovery only), free web searches, and with Tenjin routed searches in code (job postings, X hiring posts, board search). Every job is resolved to the employer's own application page; sites whose terms ban automation are never automated.
- **Apply:** through Claude in Chrome, attended with a yes on each application or unattended under your own rules, consents and a dry run first, plus fill-only and open-the-page modes. New writing has its own separate consent.
- **Contacts and events:** hiring managers or team leads for target jobs, with example intros you send and Gmail outreach only to addresses published word for word in hiring posts, plus opt-in tracking of upcoming company events.
- **Safety:** no hook; gates live in `SKILL.md` and code enforces batch locks, URL/host deny lists, upload staging and consents. Your data stays on your computer.
- **Self-repair:** existing supplier readers stay in place while unseen or changed services fall back to generic field matching. Input or output breaks hold only that need, save the paid answer, write one repair request (`J repair show` with fenced untrusted content), validate and store the agent's JSON mapping (`J repair apply`), and replay the saved answer on the next run of that need with no second payment (see `references/repair.md`).

The search sources, the search rounds and the contact rules build on [vraspar/find-jobs](https://github.com/vraspar/find-jobs).
