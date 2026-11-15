# Reddit Scout

Find recent Reddit threads you can help with. Scout reads the replies and drafts a comment if there’s something useful to add. You decide what to post.

[![View the Reddit Scout skill](https://img.shields.io/badge/Agent%20Skill-View%20SKILL.md-24292f?logo=github)](skills/reddit-scout/SKILL.md)

## Quickstart

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

## Example output

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
