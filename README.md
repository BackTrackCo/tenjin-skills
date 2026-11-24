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

Then run `/job-search` in Claude Code. The skill checks for Tenjin and offers to set it up if it is missing. It needs Node 20 or later, which `npx` already needs.

### What it does

- **Watched companies, free.** You paste a company's careers link (Greenhouse, Lever or Ashby). Code reads the board from it and checks that company's jobs every sweep, in code, with no model tokens and no limit on how many companies you watch.
- **Daily search, through Tenjin.** A Haiku subagent asks Tenjin's router for job postings that match your role, place and the days since the last search, and for hiring posts on X. The skill names no seller; the router picks, prices and applies your spend limits. Code checks the result's shape, removes duplicates, and sends a posting to the apply queue only when its apply link is on Greenhouse, Lever or Ashby and the board still lists it. Every other posting comes back as an "apply yourself" item with its link. Without Tenjin, the watched boards still run and the report says the search did not run. Contacts also run only when you ask.
- **Review.** A Haiku subagent checks that the work matches the title, adds warnings, and scores fit.
- **Prepare and write.** Answers come from your profile and saved answers. Free-text answers and messages are written by an Opus subagent from your resume, the job text and your own writing rules. The `writing` skill keeps those rules in one Markdown file you can edit; it starts empty.
- **Apply.** A Haiku subagent drives your real Chrome through Claude in Chrome, one application at a time, only on Greenhouse, Lever and Ashby, only from the sheet you saw. Attended is the default: nothing is submitted without your yes for that job and that sheet. Unattended is opt-in, with your own rules, a recorded consent and a dry run first. New writing in an unattended submit needs its own separate consent: without it, unattended runs only upload your resume and reuse answers you gave or approved before, and anything new waits for your yes.
- **Guard.** Setup can add one PreToolUse hook to `~/.claude/settings.json`, on your yes, that checks browser calls while an apply batch is open. It runs on your computer and sends nothing. `jobs.mjs guard uninstall` removes only that hook.
- **Rules and lessons.** Your rules keep your own words and date. The skill adds lessons only about its own work, and they only make it more careful and expire.
- **Notifications.** One line, under 200 characters, when something waits for you. With Remote Control on, it reaches your phone.
- **No default limits.** There is no application cap or usage budget unless you set one as a rule, for example "at most 5 a day".

### Where your data goes

Your resume, profile, rules, saved answers and application records stay in `~/.tenjin-skills/` on your computer. Searches send only search terms (your role and place), through Tenjin. To write, the skill gives your resume, the job text, your answers and your writing rules to a Claude Opus subagent, so they go to your Claude model provider, as all Claude Code work does. Each application sends what the form asks for to that employer. With Remote Control on, the session transcript is stored on Anthropic's servers to sync your devices.

### DeepSeek subagents

Until Tenjin's DeepSeek workers can use Claude in Chrome, Job Search needs Tenjin's DeepSeek subagents off, because such a worker has no Chrome tools. Setup reads the setting and asks before it runs `tenjin config subagents off`; it changes no other Tenjin setting.

### Develop and test

```sh
npm test            # node --test, no dependencies, no network
npm run check:dashes
```

Tests use recorded board responses in `tests/job-search/fixtures/` and a temporary `HOME`; they never touch real settings, state or Tenjin config. The Greenhouse application-questions fixture is hand-built from the documented response shape.
