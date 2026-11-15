# Tenjin Skills

[![View the Reddit Scout skill](https://img.shields.io/badge/Agent%20Skill-View%20SKILL.md-24292f?logo=github)](skills/reddit-scout/SKILL.md)

## Reddit Scout

Tell your agent what you know about. Reddit Scout finds recent threads on that topic, reads the replies, and drafts a short comment when you have something to add. You decide what to post.

[Quickstart](#quickstart) · [Example result](#example-from-a-live-run) · [Apify vs. glim results](docs/reddit-search-comparison.md)

### Quickstart

1. If you need Tenjin, paste this into Claude Code and follow the setup prompts. [Tenjin installation guide](https://github.com/BackTrackCo/tenjin-agent#install)

   ```text
   Install Tenjin from tenjin.sh
   ```

2. From your project directory, install Reddit Scout with the [Skills CLI](https://github.com/vercel-labs/skills#install-a-skill).

   ```sh
   npx skills add BackTrackCo/tenjin-skills --skill reddit-scout -a claude-code
   ```

3. Open a fresh Claude Code session and try this.

   > Find Reddit threads from the past week where people are trying to edit video with an agent. Tell me which communities are talking about it, and give me a short draft for each thread where I could help.

You can invoke it directly with `/reddit-scout` or give it a topic, subreddit, time window, desired number of threads, and budget in plain English. For Codex, use `-a codex` in the install command. Tenjin’s Codex integration is experimental.

### What happens after you ask

The agent starts with a Reddit-wide keyword search, looks for communities with relevant recent threads, then searches inside those communities. If you specify subreddits as the scope, it searches there. It reads promising threads and their replies, then gives you a link, a way to help, and an editable draft. If nothing qualifies, it says so.

Tenjin lets the agent discover and use providers during the run. Calls paid through Tenjin use your Tenjin spending limits. Connected providers bill their own accounts. If dedicated search is unavailable, the agent can try web search limited to Reddit and verify the results on Reddit.

### Example from a live run

**[Looking for Help Setting Up Claude Code for AI Video Editing](https://www.reddit.com/r/ClaudeCode/comments/1xvektq/looking_for_help_setting_up_claude_code_for_ai/) · Nov 13, 2026**

**What they need** — Whisper and FFmpeg cut a gaming creator’s footage, but missed the best moments. Replies already suggest using audio peaks and checking the kill feed.

**Where you can help** — Ask whether the mic is on its own track, so the creator can separate reactions from the game audio.

**Editable draft** — “Is your mic on its own track? If it is, could you use peaks on that track to shortlist reactions, then check those moments against the kill feed?”

The draft is shortened from the live run. The [comparison and walkthrough](docs/reddit-search-comparison.md) show what Apify and glim returned for the same query, how sorting changed the results, and what the agent pulled from the replies.
