---
description: Show the address of my galaxy in Agent Loop
allowed-tools: Bash(node:*)
---
My galaxy's address:

!`node "${CLAUDE_PLUGIN_ROOT}/hooks/report.mjs" --galaxy "${CLAUDE_PLUGIN_DATA}"`

If the output above starts with "No galaxy address:", the user has left their galaxy group and there is no address to open: do not give a link and do not say anything opens or flies to their galaxy. Tell them, in their language and in one or two short sentences, that they left that group (give its fingerprint) and the two ways out the output gives: /agent-loop:rejoin to go back, or /plugin configure agent-loop@agent-loop to set server_url back to http://127.0.0.1:4317 to show it on this computer.

Otherwise reply with only the address above as a clickable link, and one short sentence saying that opening it flies straight to this user's galaxy. If the output says it was opened in the browser with the group key, say that too, and that the invite link (with the key) is under the Invite button on that page.

In both cases, if the output has a line starting with "Problem:", also tell the user that problem and how to fix it, in their language. Do not run any other command.
