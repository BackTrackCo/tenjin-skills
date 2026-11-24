# Setup

Run once, attended. Ask only what is missing; `J setup check` shows what is done. Save the stage as you go: `J setup stage <stage> <next step>`.

1. **Tenjin.** `J tenjin`. If missing or outdated, say once what Tenjin does here (routes paid lookups, keeps spend limits) and ask whether to set it up. On a yes, follow the install steps at tenjin.sh/skills.md to the end: it installs, asks the spending questions, offers funding and gives the activation step. Copy none of it and change no Tenjin setting. The core (free sweep, review, prepare, writing, attended apply) needs no restart. Only the router steps on request wait for the next session; say so once.
2. **Resume.** Ask for the resume file path. `J setup resume <path>` reads only that path. If the path is a placeholder or does not exist, it asks and reads nothing. Never search the person's files.
3. **Profile.** Build with the person and save with `J profile set '<json>'`:
   - `facts`: first_name, last_name, email, phone, linkedin, github, website, location, current_company, authorized_to_work, requires_sponsorship, salary_expectation (only what they give).
   - `places`: a city means that city. `remote: true` only if the person says remote.
   - `watch`: companies by name, `[{"name":"Acme"}]`. Tokens are looked up in the bundled employer list; for one it lacks, find the board URL and add `{"name","ats","token"}`.
   - `windowDays`, `sweepHour` if they ask.
4. **EEO choice.** Voluntary demographic questions follow one explicit choice: `{"eeo":"decline_all"}` or `{"eeo":{"answers":{"<question label, lowercase>":"<answer>"}}}`. Do not choose for them.
5. **Guard hook.** Explain: one PreToolUse hook in `~/.claude/settings.json` that checks browser calls during an apply batch, runs on this computer, sends nothing, and is removed with `J guard uninstall`. Ask separately. On a yes, `J guard install`. If the write is refused, apply waits (unattended cannot run); say so.
6. **DeepSeek subagents.** `J setup deepseek` reads the state. If on, explain: a DeepSeek worker has no Claude in Chrome tools, so every application would stop, until Tenjin's DeepSeek workers can use Claude in Chrome. Only on a yes: `J setup deepseek --yes`. If they keep it on: `J setup deepseek --keep` (applications then hold as `deepseek_on`).
7. **Remote Control, once.** Say it lets the phone get the push and answer while the session, Monitor and Chrome keep running here. The person turns it on: `/remote-control`, or "Enable Remote Control for all sessions" in `/config`, plus the Claude app and its push toggles.
8. **Unattended (only if they ask).** Set `profile.unattended`: `roles` (title words), `places`, `remote`, `minPay`, `excludeCompanies`, `excludeLevels`, `minScore`, `hosts` (greenhouse, lever, ashby). Show it, ask for a clear yes, then `J consent unattended`. Open each allowed host's public board page once with the person present so Chrome allows the site for the session. Chrome stays open, the computer awake, the session open.

A daily Desktop scheduled task running `/job-search sweep only` is an option for someone who will not keep a session open. It never applies.
