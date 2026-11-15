# How we tested Reddit Scout

We wanted an agent to find people we could genuinely help on Reddit. A thread title can get you to the right conversation. The replies tell you whether you still have anything to add.

## The same search across Apify and glim

On November 14, 2026 in Toronto, we ran `MCP tools` in r/ClaudeCode using each endpoint's relevance sort and one-week preset. We requested 10 posts per source, matched results by Reddit post ID, and used the same 72-hour cutoff when counting fresh posts. We counted a post body when the response included nonempty body text.

| | Apify `automation-lab/reddit-scraper` | glim via Tenjin |
| --- | ---: | ---: |
| Posts returned | 10 | 10 |
| Posts with body text | 4 | 5 |
| Posts from the last 72 hours | 2 | 3 |
| Fresh posts with body text | 0 | 2 |

Five post IDs appeared in both lists. Apify reported $0 in usage for this run. The glim search quoted 1¢ in provider fees. This tests a single keyword, two particular endpoints, and one point in time. It tells us what the agent received on that run.

We ran a separate paired search for `video editing` in r/ClaudeCode through glim. Both calls used the same one-week preset and requested 10 posts. Relevance sort returned **3 fresh posts** and newest-first returned **7**, using the same 72-hour window. Both found the strongest thread. That’s why the skill starts with newest-first for a recent search and checks each post's timestamp.

## What Claude did with the result

We asked Claude Code for recent r/ClaudeCode conversations about editing video with agents. The prompt and the skill let Claude choose the provider. In the first desktop session, Tenjin offered the connected Firecrawl account. In a fresh session with that account temporarily skipped, it offered the connected Apify account. Claude discovered glim through Tenjin and used it for the Reddit search and thread reads in both sessions.

One thread made the list. A [gaming creator looking for an AI video-editing workflow](https://www.reddit.com/r/ClaudeCode/comments/1xvektq/looking_for_help_setting_up_claude_code_for_ai/) had followed advice on using Whisper and FFmpeg. Their workflow managed to cut the footage and missed the best moments. The replies already suggested audio peaks, looking for changes in the kill feed, and using DaVinci Resolve. Once Claude read them, it could suggest a more specific question about whether voice and game audio were recorded on separate tracks.

The fresh desktop run made two searches and two thread reads at 3¢ in reported provider costs. Settlement was unknown at the time we checked. The skill now asks the agent to report that distinction.

## Try the comparison on your own topic

> Search the same topic and subreddit through two available Reddit search providers. Use matching sort, time window, and result limits where supported, and call out any input differences. Deduplicate by Reddit post ID. Show which posts are unique to each provider, how many meet the time window, and which are worth reading.

[Install Reddit Scout and try the full workflow](../README.md#quickstart).
