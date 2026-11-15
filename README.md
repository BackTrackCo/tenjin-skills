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

## Example from a live run

### Finding highlights in gameplay footage

[r/ClaudeCode thread](https://www.reddit.com/r/ClaudeCode/comments/1xvektq/looking_for_help_setting_up_claude_code_for_ai/) · Nov 13, 2026

Whisper and FFmpeg cut the footage and missed the highlights. Replies covered audio peaks and the kill feed. The creator’s mic setup was still unclear.

> **Reply draft** · shortened from the run
>
> Is your mic on its own track? If it is, could you use peaks on that track to shortlist reactions, then check those moments against the kill feed?

[How we tested Reddit Scout](docs/reddit-search-comparison.md)
