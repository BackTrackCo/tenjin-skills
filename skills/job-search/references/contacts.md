# Contacts (on request, Haiku subagent)

Ask how many jobs; 5 if the person does not say (`J contacts request` picks the best 5, or the `contact_count` rule). Free ways first, for each job:

1. The post's author (an X or Hacker News post names someone), the team page, talks, blog posts, GitHub, and LinkedIn profiles that appear in search results. Use a LinkedIn profile only as a link from a search result; never fetch a LinkedIn page, never sign in, never use the Y Combinator company page.
2. Then, if Tenjin is there, the router's people search for the job, stated as a need; name no seller.

Each contact needs: a source link, how to reach them, and one thing they care about. `J ops` `contact` refuses a contact without them:
`{"op":"contact","key":"..","name":"..","title":"..","sourceUrl":"..","how":"..","cares":".."}`.
A likely person (for example the likely hiring manager from a team page that does not name them) is shown only when marked `"basis":"likely","notConfirmed":true`. Never guess a name or an address. If none is found, say so.

Messages are drafts: `J write-prompt --contacts <key,key>` gives an Opus call; the person edits and sends them.
