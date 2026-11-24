---
description: Show where Agent Loop reports and whether it is working
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/hooks/report.mjs" --status "${CLAUDE_PLUGIN_DATA}"`

Tell the user, in their language, what the output above says, as a short list. Give the group fingerprint and server exactly as shown. If there is a line starting with "Problem:", explain that problem and how to fix it. Do not run any other command.
