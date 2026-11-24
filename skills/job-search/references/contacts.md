# Contacts (on request, Haiku subagent)

Ask how many jobs; 5 if the person does not say (`J contacts request` picks the best 5, or the `contact_count` rule). Free ways first, for each job:

1. The post's author (an X or Hacker News post names someone), the team page, talks, blog posts, GitHub, and LinkedIn profiles that appear in search results. Use a LinkedIn profile only as a link from a search result; never fetch a LinkedIn page, never sign in, never use the Y Combinator company page.
2. Then, if Tenjin is there, the router's people search for the job, stated as a need; name no seller.

Each contact needs: a source link, how to reach them, and one thing they care about. `J ops` `contact` refuses a contact without them:
`{"op":"contact","key":"..","name":"..","title":"..","sourceUrl":"..","how":"..","cares":"..","channel":"x|linkedin|email|other"}`.
A likely person (for example the likely hiring manager from a team page that does not name them) is shown only when marked `"basis":"likely","notConfirmed":true`. Never guess a name or an address. If none is found, say so.

Messages are drafts: `J write-prompt --contacts <key,key>` gives an Opus call; the person edits and sends them.

## Example intros

For every contact whose record names a `channel` (an X handle, an email address, a LinkedIn profile or another public way), one writer call per job writes an example intro for all of that job's contacts: `J write-prompt --intros <key>` prints the Opus call; save its JSON with `J intros save <key> --result <file>`. An X or LinkedIn intro is under 300 characters; an email has a subject line and about 120 words at most; code checks the length per channel and refuses a contact with no channel. The intro is a draft the person sends themselves: never open LinkedIn or another never-automated site to send or read it, and never sign in. No consent gates it, and it is never held as `writing_needs_yes`. In an unattended run the intros are written and kept.
