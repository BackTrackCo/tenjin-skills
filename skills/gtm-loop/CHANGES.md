# Changes

## 0.1.0

First release. GTM Loop finds people who want what you sell, writes the first message in your voice, and sends it after your yes.

- The tooling base (state store with a lock, the watcher lease, the router client, the fetch guard, the open command, the question checks, rules, the release check) is copied from the Job Search skill at its source commit `8f22498`, with the skill name and the state folder changed (`~/.tenjin-skills/gtm-loop/`). The writing skill is the same file, byte for byte.
- The release check installs a tag with `owner/repo#tag`: the installer reads `owner/repo@x` as a skill name unless it looks like `v1.2.3` or a commit SHA.
- Not built yet in this commit series: finding leads, drafts, email and the watcher steps. They follow in later commits of the branch.
