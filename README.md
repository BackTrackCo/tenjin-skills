# Tenjin Skills

## Reddit Scout

Find recent Reddit threads where you can help. Get the thread link, what people have already said, and an editable reply that adds something.

### Quickstart

1. [Set up and activate Tenjin in Claude Code](https://tenjin.sh/agents) to give your agent access to dedicated Reddit search and thread reads.
2. Install Reddit Scout from your project directory.

   ```sh
   npx skills add BackTrackCo/tenjin-skills --skill reddit-scout -a claude-code
   ```

3. Start a fresh Claude Code session and paste this prompt.

   > Find recent r/ClaudeCode threads where people are trying to edit video with an agent. Read the replies and suggest how I could help. Give me one short reply draft per useful thread.

Add a topic, subreddit, time window, result count, or budget as needed. For example, a maintainer could ask for five threads from the past week where people need help debugging flaky tests in GitHub Actions. You can invoke the skill directly with `/reddit-scout` in Claude Code. For Codex, use `-a codex` in the install command and mention `$reddit-scout` in your prompt.

The skill uses the tools your agent can access. With Tenjin active, the agent can discover a provider during the run. Paid calls use your existing limits. When dedicated search is unavailable, the agent can try subreddit-scoped web search and verify what it finds. You review and post any reply yourself.

### Example from a real run

**[Looking for Help Setting Up Claude Code for AI Video Editing](https://www.reddit.com/r/ClaudeCode/comments/1xvektq/looking_for_help_setting_up_claude_code_for_ai/) · Nov 13, 2026**

- **What they need** — A gaming creator got Whisper and FFmpeg to cut their footage. The edit missed the best moments, and the replies already covered loudness spikes and sampling frames to read the kill feed.
- **Where you can help** — Ask whether their microphone is on its own track, so they can try using voice reactions without game audio.
- **Optional reply draft** — “Is your mic on its own track? If it is, could you try using spikes on that track to shortlist reactions, then check those moments against the kill feed?”

We shortened the draft from the live run for this example. For the search settings, provider results, and limits of the comparison, see [How we tested Reddit Scout](docs/reddit-search-comparison.md).
