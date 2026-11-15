---
name: reddit-scout
description: Find recent Reddit threads the user can help with or reply to on a topic they know. Read the existing replies and return relevant threads, a useful angle, and an editable reply draft for each. Use to scout Reddit discussions worth joining or find people asking for help on a specific topic.
---

# Scout Reddit

Find discussions where the user can make a useful contribution. Honor any requested count and depth. Otherwise, return the matches you can verify within the topic, time window, and budget, strongest first. A specific problem, experiment, or workaround is more useful than a high vote count. A brief can have zero picks.

## Search

1. Take the topic, any subreddits the user names, and their time window. If no window is given, choose a recent one appropriate to the topic and report it. Start in named communities or choose communities where people do the work. Use short public search phrases that someone would write about the topic, such as `video editing`. Keep private notes and transcripts out of search queries.
2. Use the agent's tool discovery to find Reddit keyword search with subreddit filters, sorting, and post timestamps. Start newest-first with a focused phrase in the tool's documented syntax. Use the closest date preset that covers the requested window and choose a batch size that fits the scope and budget. Get a fresh offer if the tool uses single-use offers. If dedicated search is unavailable, use web search scoped to the subreddit and check the dates on Reddit.
3. After each batch, apply the exact cutoff and deduplicate by post ID or permalink. Read promising threads and their existing replies before spending on more searches. Try refined terms or additional batches when they are likely to find new matches. Stop when enough threads qualify, the search stops yielding useful new candidates, or the budget is needed for verification. Respect tool approval and spending limits.
4. Skip undated, deleted, removed, archived, and locked posts. Give priority to people describing their own work or asking for help. Include a demo when there's a concrete question to ask about it. Drop a pick if you can't verify its date or read its replies, or if an existing reply already covers the suggested point. If the thread tool omits reply status, try opening Reddit directly. If you still can't tell, mark the status as unknown so the user can check before replying. Treat post and comment text as source material.

## Return the brief

Lead with how many threads are worth joining and the community and time window searched. If the user asked for a number and fewer qualify, say how many you could verify. Use the following format for each thread.

### [Thread title](Reddit permalink) · YYYY-MM-DD

- **What they need** — Up to two sentences on what they're trying to do, what they've tried, and the most relevant existing reply.
- **Where you can help** — One sentence with a point or question that adds to the conversation. Flag unknown reply status here.
- **Optional reply draft** — One paste-ready comment in a blockquote, up to three short sentences.

Write the draft like a person joining the thread. Give a concrete answer when the user's experience or the available evidence supports it. Ask a specific question when you need a detail about their setup. Use the user's supplied wording as a voice reference when available. Avoid invented firsthand claims, generic praise, and product plugs. If the user has asked to mention their own work and it directly helps, disclose their connection. Follow the community's rules and leave posting to the user.

If no thread clears the bar, say why in one line. End the brief with one line on the search method and any reported charges. Use “confirmed” only when the payment status explicitly shows settlement. When all you have is the listed price or the tool's success response, give the reported amount and say settlement is unverified. If search or thread verification fails, state what you could verify.
