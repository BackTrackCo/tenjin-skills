# Reddit Scout

[![View the Reddit Scout skill](https://img.shields.io/badge/Agent%20Skill-View%20SKILL.md-24292f?logo=github)](skills/reddit-scout/SKILL.md)

Find recent Reddit threads where you can help. Reddit Scout reads the replies and drafts a short comment when there's something left to add. You decide what to post.

[Quickstart](#quickstart) · [Live example](#example-from-a-live-run) · [Apify vs. glim search test](docs/reddit-search-comparison.md#the-same-search-across-apify-and-glim)

## Quickstart

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

## What happens after you ask

The agent starts with a Reddit-wide keyword search, then searches communities with relevant recent results. You can also give it specific subreddits or paste a thread link to check the replies directly. Each result includes the thread link, subreddit and date, why it's worth replying to, and an editable draft. If nothing qualifies, it says so.

Tenjin lets the agent discover and use providers during the run. Calls paid through Tenjin use your Tenjin spending limits. Connected providers bill their own accounts. If dedicated search is unavailable, the agent can try web search limited to Reddit and verify the results on Reddit.

## Example from a live run

**[Looking for Help Setting Up Claude Code for AI Video Editing](https://www.reddit.com/r/ClaudeCode/comments/1xvektq/looking_for_help_setting_up_claude_code_for_ai/) · r/ClaudeCode · Nov 13, 2026**

**Why reply** — The edit missed the best moments. People already suggested audio peaks and the kill feed, while the mic setup is still unclear.

**Draft**

> Is your mic on its own track? If it is, could you use peaks on that track to shortlist reactions, then check those moments against the kill feed?

The draft is shortened from the live run. The [comparison and walkthrough](docs/reddit-search-comparison.md) show what Apify and glim returned for the same query, how sorting changed the results, and what the agent pulled from the replies.
