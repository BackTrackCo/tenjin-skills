# Tenjin skills

Agent skills for Tenjin, installed with `npx skills add`.

- [Reddit Scout](#reddit-scout): find Reddit threads you can help with and draft replies.
- [Job Search](#job-search): find, rank and apply to jobs, with your yes on each application.

## Reddit Scout

Find recent Reddit threads you can help with. Scout reads the replies and drafts a comment if there’s something useful to add. You decide what to post.

[![View the Reddit Scout skill](https://img.shields.io/badge/Agent%20Skill-View%20SKILL.md-24292f?logo=github)](skills/reddit-scout/SKILL.md)

### Quickstart

1. **Set up Tenjin.** If you’re new to Tenjin, paste this into Claude Code. [Setup guide](https://github.com/BackTrackCo/tenjin-agent#install)

   ```text
   Install Tenjin from tenjin.sh
   ```

2. **Install Reddit Scout** from your project directory.

   ```sh
   npx skills add BackTrackCo/tenjin-skills \
     --skill reddit-scout -a claude-code
   ```

3. **Try it** in a fresh Claude Code session.

   > Find Reddit threads from the past week about editing video with an agent. Read the replies and draft a short comment for each thread where I could help.

Use `/reddit-scout` to invoke it directly. Give it a topic to discover subreddits, name communities to narrow the search, or paste a thread link to check its replies. You can include a time window, result count, or budget.

For Codex, replace `-a claude-code` with `-a codex`. Tenjin’s Codex integration is experimental. Calls paid through Tenjin follow your spending limits. Connected providers bill their own accounts.

### Example output

The current skill replayed a post and nine replies saved during a live run. [Reddit thread](https://www.reddit.com/r/ClaudeCode/comments/1xvektq/looking_for_help_setting_up_claude_code_for_ai/) · [How we tested Reddit Scout](docs/reddit-search-comparison.md)

```text
1 thread worth joining from the November 14 capture. The open
angle is testing highlight selection against moments the creator
actually wants; existing replies cover tools, signals, and
candidate shortlists.

Looking for Help Setting Up Claude Code for AI Video Editing
· r/ClaudeCode · November 13

Editable comment:

Before paying for a full setup, try marking 3–5 moments you’d
actually use from one recording, with timestamps and why each
works. Give those examples to Claude, then test its shortlist on
a different recording against your own picks. That should help
separate whether it needs a clearer definition of “best” or
whether the transcript/audio signals are missing the on-screen
action.

Reviewed only the supplied post and all nine captured comments.
Posting status is unknown; check before replying.
```

## Job Search

Every day, Job Search reads the public job boards of the companies you watch (Greenhouse, Lever and Ashby), checks and ranks what is new, and tells you what fits. For the ones you like it prepares answers and, through Claude in Chrome, fills the application with you saying yes to each one. It never hides that it is automation and never goes around a CAPTCHA or bot check: it stops and hands that step to you.

[![View the Job Search skill](https://img.shields.io/badge/Agent%20Skill-View%20SKILL.md-24292f?logo=github)](skills/job-search/SKILL.md)

### Install

Claude Code only, for now. Global, because your state is per person. A release is pinned to a tag that a maintainer cuts after review; replace the version with the latest `job-search-v*` tag.

```sh
npx skills add BackTrackCo/tenjin-skills@job-search-v0.1.0 \
  --skill job-search --skill writing -a claude-code -g
```

Then run `/job-search` in Claude Code. It asks you to share your resume (a file, a link or the text), then four quick choices in one question: how applications go out (you approve each, auto, "Fill only, I submit" or "Just open the pages"), how often to search, how many positions to make ready per period, and where you prefer to apply. The free search and the first report follow in the same session. Tenjin is never required to start; it comes up as a recommendation where it would do better, and you decide. The install (the `skills` installer) needs Node 22.20 or later, and the skill itself runs on Node 20 or later.

### What it does

- **Watched companies, free.** There is no watch-list question and the skill never builds a list itself. When you ask for a company in your own message, by name or with a careers link, its board is added and stays until you remove it. Code reads each listed board every sweep, with no model tokens and no limit on the list.
- **Daily search.** Each round runs free web searches of the three board hosts and X (also without Tenjin), then, with Tenjin, the router's job-posting and X searches; the next round uses a new role word (a synonym or a level) and stops when it finds nothing new. Hacker News "Who is hiring?" is read through its Algolia search API. Older postings stay only when their board confirms they are open.
- **Searches in code.** With Tenjin, the job-posting search runs in code through the router at the router's price, with no Claude usage for the searches, and a held search is named in the report. A hiring post with no job posting becomes a reach-out lead ("People hiring") with an example intro you send yourself.
- **Searches, through Tenjin.** With Tenjin the watcher runs each search round in code, at your search frequency: job postings that match your role, place and the days since the last search, hiring posts on X, and a direct search of company job boards. The skill names no seller; the router picks, prices and applies your spend limits. Code checks each result's shape, removes duplicates, and sends a posting to the apply queue only through the employer's own posting (an apply link on a company job board, or the employer's careers page). Every other posting comes back as an "apply yourself" item with its link. Without Tenjin, the watched boards still run and the report says the search did not run. Contacts also run only when you ask.
- **Review.** A Haiku subagent checks that the work matches the title, adds warnings, and scores fit.
- **Prepare and write.** Answers come from your profile and saved answers. Free-text answers and messages are written by an Opus subagent from your resume, the job text and your own writing rules. The `writing` skill keeps those rules in one Markdown file you can edit; it starts empty.
- **Jobs found on platforms.** A job found on LinkedIn, Indeed, Glassdoor, ZipRecruiter or X is never automated, neither read, fetched nor filled, because their terms ban automated use; the Y Combinator job sites are never opened in the skill's browser or filled either, but code reads their public job pages, logged out, for discovery only (the role page, the company page and the job page, one request at a time, slowly, on paths that YC's robots.txt allows), and each job is then found on the employer's own board like any other; "Just open the pages" and the job-site apply option open the job's page in your own Chrome for you, and the skill does nothing on that site. The skill finds the employer's own posting instead: from an apply link, from a board that code confirms is the employer's and matches the job, or from the employer's careers page. If it cannot, the report says why and gives you the link. Hacker News "Who is hiring?" posts and YC job stories come in through Hacker News's official API only. On any other hiring system the skill reads the live form and applies the same way; it never makes an account, and a form that needs a sign-in stops.
- **Fill only.** Choose fill-only for a job, or with a `fill_only` rule for every job or named companies: the form is filled and read back, nothing is submitted, the tab stays open, and you get one notification. You check it, press submit, and say so.
- **Apply.** A Haiku subagent drives your real Chrome through Claude in Chrome, in parallel with one job per host at a time, on any employer application page except a short deny list of sites whose terms ban automation, only from the sheet you saw. Attended is the default: nothing is submitted without your yes for that job and that sheet. Unattended is opt-in, with your own rules, a recorded consent and a dry run first. New writing in an unattended submit needs its own separate consent: without it, unattended runs only upload your resume and reuse answers you gave or approved before, and anything new waits for your yes.
- **Safety, with no hook.** Job Search edits none of your Claude Code settings. In code: a job is handed out only in an open batch, only as the employer's own posting, and the commands that change what a submit may do (rules, consents, the profile, answers, writing approval) are refused while a batch is open. The rest is a rule in the browser subagent's task, because nothing in code sees its clicks. Every consent change and writing approval shows in your next report and in a notification.
- **Rules and lessons.** Your rules keep your own words and date. The skill adds lessons only about its own work, and they only make it more careful and expire.
- **Uploads.** Files a form takes (your resume copy, under its own name) live in `~/.tenjin-skills/job-search/uploads/`, apart from the state files. Because Claude in Chrome can upload only from folders the session may read, the skill copies the file into a hidden `.job-search-upload` folder in the session's working folder just before each upload and deletes the copy and the folder right after, on success or failure. It never asks you to grant a folder. If a crash leaves a copy behind, the next apply step removes it, and that exact folder name is the only thing the skill ever touches there. If the working folder cannot be written, the job is filled without the file and the report says so once.
- **Events.** When you say yes, the skill finds coming events (meetups, talks, hackathons, office hours, demo days, recruiting events) by the companies you want to work at, in the next 60 days, near you or online. Code reads public Luma pages and the Y Combinator events page, logged out and slowly, plus a company's own events page; with Tenjin it also searches the web and public X posts. Each event is confirmed on its own page where possible, and you judge nothing: the model only checks that the company is really behind it. The report lists them and one push comes for new ones. The skill never registers for an event; `J events open` opens its page in your Chrome.
- **Notifications.** One line, under 200 characters, when something waits for you. With Remote Control on and both push settings in `/config` turned on ("Push when actions required" and "Push when Claude decides"), it reaches your phone.
- **No default limits.** There is no application cap or usage budget unless you set one as a rule, for example "at most 5 a day".

### Where your data goes

Your resume, profile, rules, saved answers and application records stay in `~/.tenjin-skills/` on your computer. Searches send only search terms (your role and place), through Tenjin. To write, the skill gives your resume, the job text, your answers and your writing rules to a Claude Opus subagent, so they go to your Claude model provider, as all Claude Code work does. Each application sends what the form asks for to that employer. With Remote Control on, the session transcript is stored on Anthropic's servers to sync your devices.

### Credit

The search sources, the search rounds and the contact rules build on [vraspar/find-jobs](https://github.com/vraspar/find-jobs).

### Develop and test

```sh
npm test            # node --test, no dependencies, no network
npm run check:dashes
```

Tests use recorded board responses in `tests/job-search/fixtures/` and a temporary `HOME`; they never touch real settings, state or Tenjin config. The Greenhouse application-questions fixture is hand-built from the documented response shape.
