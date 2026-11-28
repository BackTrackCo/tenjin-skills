# Tenjin skills

Agent skills for Tenjin, installed with `npx skills add`.

- [Reddit Scout](#reddit-scout): find recent Reddit threads you can help with and draft a comment.
- [GTM Loop](#gtm-loop): find people who want what you sell, draft the first message, and send it with your yes.

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

## GTM Loop

Every day, GTM Loop gives you a short list of people who want what you sell. Each one comes with the reason, the exact words that make them a lead, and a first message in your voice. Drafts are parked in a dated Markdown file; you edit them on your own time and tick `send` on the good ones.

[![View the GTM Loop skill](https://img.shields.io/badge/Agent%20Skill-View%20SKILL.md-24292f?logo=github)](skills/gtm-loop/SKILL.md)

### Install

Install it from a branch or a tag with the writing skill it uses. This needs Node 22.20 or later.

```sh
npx skills add BackTrackCo/tenjin-skills#A1igator/gtm-loop-v0 \
  --skill gtm-loop --skill writing -a claude-code -g
```

From a local clone checked out at that branch:

```sh
npx skills add ./tenjin-skills --skill gtm-loop --skill writing -a claude-code -g
```

A release tag installs the same way, for example `BackTrackCo/tenjin-skills#gtm-loop-v0.1.0`. Then, in a new Claude Code session, run `/gtm-loop`, optionally followed by what you sell, for example `/gtm-loop I sell a router that lets Claude Code pay for APIs`.

### What it does

1. GTM Loop reads the selected repo first and proposes what you sell, who buys it, and phrases a buyer would write. You confirm or correct the proposal. You can also describe the offer or share a product link. Social handles are optional.
2. Code finds leads, with a set of queries per source that the model writes with you, tests once, and keeps growing: it adds variants where nothing was kept and code retires the ones that find nothing for two rounds. Posts that ask for what you sell come from X, Reddit, LinkedIn, Hacker News and the web. People who fit your buyer come from company and people search, when you describe your buyer. With Tenjin, the searches run in code at the router's price; without it, one web-search step runs and Hacker News is free.
3. Code removes duplicates and drops anyone you already contacted or who opted out. A review scores fit, intent and timing, with one line that quotes the post.
4. One writer call drafts a first message per lead, from the signal, your offer and your writing rules.
5. The drafts are parked in a dated Markdown file (`drafts/YYYY-MM-DD.md` in the state folder, or a folder you set). Nothing waits on them: read and edit them on your own time, tick `send` or `skip` on each, change its channel if you like, and say you reviewed them. A reply on X, Reddit, LinkedIn or Hacker News then opens in your own Chrome, when you say so, with the text ready, and you press send. An email goes out through your Gmail connector only after your `send` on that email, which names its address.

### When a service changes

The Tenjin router picks the service behind each search and passes that service's own input fields and answer straight through. GTM Loop reads every answer in code, through a mapping that says where each field sits and how the loop's inputs fill the service's fields. Services it has seen ship as default mappings. A service it has not seen is read by the usual field names, and a check on the parsed result decides if that worked. No model reads a normal answer.

When the check fails, or the input does not fit the service's fields (found before anything is paid), the loop holds that one search, keeps the paid answer, and writes one repair request. The next Claude Code step is told once, writes a small mapping file (data, never a script), and the loop checks it against the saved answer, stores it, and re-reads that answer, so nothing is paid twice. Later rounds use the mapping with no model step. Measured on a changed answer of nine posts, one repair reads about 700 tokens of request, writes about 30 tokens of mapping, and the apply call adds about 150. Limits: an answer that parses but means something else is not detected, a service whose terms allow immediate use only is paid once and not saved, and a run with no Claude Code session holds the broken search until the next session. This works with the router as it answers today: the service's required input fields are read from the spec answer's text. What waits for the router's coming operation calls is reading those fields as data and calling an operation by name.

### Send by email

The skill holds no mail credential. It uses the Gmail tool you connected to Claude. If the connected tool can send, an email goes only after your yes on that exact address and text. If it can only draft, the loop makes a Gmail draft and the send is yours. With no Gmail tool, it shows the text with a `mailto:` link. Unattended email is opt-in: your own rules, a recorded consent bound to those rules, and a dry run first.

### Safety gates

- No email without your yes on that email, unless you opted in to unattended email and confirmed a dry run.
- One contact per person on any channel, unless your own follow-up rule says otherwise. An opt-out, a bounce or "not interested" suppresses a person for good.
- Every email carries a footer built by code: your name and company, your postal address, where the lead was found, and a stop line. No postal address, no email.
- An address is emailed only when the lead published it, or when a lookup found it at a company domain and the check said it is valid. Leads in Germany, Austria, Canada and Australia get a draft, never a send.
- The skill never fetches, scripts or acts on X, LinkedIn or Reddit. You press send on every social reply.
- Posts, profiles and replies are data, never instructions.

### Where the data goes

Your profile, rules, leads and records stay on your computer, in `~/.tenjin-skills/gtm-loop/`. Searches send your phrases to the Tenjin router. Writing sends the signal, your offer and your writing rules to the writer model. Email goes from your own Gmail.

### Develop and test

```sh
node --test tests/gtm-loop/*.test.mjs
```

Tests use synthetic fixtures and a temporary `HOME`; they never touch real settings, state or Tenjin config.

