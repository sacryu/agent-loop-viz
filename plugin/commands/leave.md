---
description: Take my galaxy out of its Agent Loop galaxy group
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/hooks/report.mjs" --leave "${CLAUDE_PLUGIN_DATA}"`

Tell the user, in their language and in two or three short sentences, what the output above says: whether they left a galaxy group (and which fingerprint), whether the server removed their galaxy right away, whether the group's page was opened in their browser to clear the group from it (and show that they left), and what to do next (going back to this computer with /plugin configure, or /agent-loop:rejoin). Do not run any other command.
