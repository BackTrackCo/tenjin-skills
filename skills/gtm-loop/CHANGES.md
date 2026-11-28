# Changes

## 0.1.0

First release. GTM Loop finds people who want what you sell, writes the first message in your voice, and sends it after your yes.

- **Finding leads:** posts asking for what you sell on X, Reddit, LinkedIn, Hacker News (free) and the web, plus buyer-fit company and people search. With Tenjin, searches run in code in the background; without it, Hacker News stays free and one Haiku web-search step covers the rest.
- **Deduplication and safety:** one lead per post and one person per identity (linked only on evidence). Opted-out, bounced, already contacted and rule-excluded leads drop before review; posts addressing an AI agent stop as `injection_suspected`.
- **Review and writing:** parallel Haiku batches score fit, intent and timing with a verbatim quote; one Opus call per round drafts first messages from the signal, offer and writing rules, with code checking length, links, offer disclosure and no-ask rules.
- **Parked drafts and social replies:** drafts park in a dated Markdown file (`drafts/YYYY-MM-DD.md` or a custom folder) where you edit and tick `send` or `skip`. Approved replies on X, Reddit, LinkedIn or Hacker News open in your own Chrome when you say so, with text on the clipboard; you press send. The skill never fetches, scripts or acts on those sites.
- **Email:** uses your connected Gmail tool only after your yes on the exact address and text, with a code-built footer, verified company-domain addresses only, draft-only handling for Germany, Austria, Canada and Australia, single-use handouts, thread-scoped reply/opt-out tracking and domain suppression. Unattended email and follow-ups are opt-in under your own rules and consent.
- **Self-repair:** code sends and reads routed needs through data mappings (`defaults.json` plus `mappings.json`), falling back to generic field matching for unseen services. Input or output breaks hold only that need, save the paid answer, write one repair request (`G repair show` with fenced untrusted content), validate and store the agent's JSON mapping (`G repair apply`), and re-read the saved answer with no second payment (see `references/repair.md`).
- **Base and installer:** tooling base copied from Job Search (`8f22498`) with its own `~/.tenjin-skills/gtm-loop/` state folder; `skills/writing/SKILL.md` is byte-identical. Release installs use `owner/repo#tag` (never `@tag`) for `skills@1.9.0`.
