# Changes

## 0.1.0

First release. GTM Loop finds people who want what you sell, writes the first message in your voice, and sends it after your yes.

- Finding leads: posts that ask for what you sell on X, Reddit, LinkedIn, Hacker News (free) and the web, and, when you describe your buyer, companies and the people at them with their recent posts. With Tenjin the searches run in code in the background; without it Hacker News stays free and one Haiku web-search step covers the rest.
- One lead per post, one person per identity, linked only on evidence. Anyone opted out, bounced, already contacted or excluded by your rules is dropped before review. A post that addresses an AI agent is stopped, never acted on.
- A Haiku review scores fit, intent and timing with a line that quotes the post; one Opus call writes the first message per round from the signal, your offer and your writing rules, and code checks length per channel, links, the sender's connection to the offer, and that a lead found by search is never told they asked.
- You pick the leads and the channel in one question. A reply on X, Reddit, LinkedIn or Hacker News opens in your own Chrome with the text on the clipboard; you press send. The skill never fetches, scripts or acts on those sites.
- Email goes through the Gmail tool you connected, only after your yes on the exact address and text, with a footer built by code, found addresses only at the company domain after a valid check, a draft instead of a send for Germany, Austria, Canada and Australia, a handout that is never repeated, replies and opt-outs read from the threads the skill sent, and domain suppression.
- Unattended email is opt-in: your own rules, a recorded consent bound to them, and a dry run first. A follow-up exists only when your own rule says so.
- The tooling base (state store with a lock, the watcher lease, the router client, the fetch guard, the open command, the question checks, rules, the release check) is copied from the Job Search tooling at its source commit `8f22498`, with the skill name and the state folder changed (`~/.tenjin-skills/gtm-loop/`). The writing skill is the same file, byte for byte.
- The release check installs a tag with `owner/repo#tag`: the installer reads `owner/repo@x` as a skill name unless it looks like `v1.2.3` or a commit SHA.
