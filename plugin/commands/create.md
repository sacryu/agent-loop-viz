---
description: Create a new Agent Loop galaxy group and move my galaxy into it
argument-hint: "[server url]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---
!`node "${CLAUDE_PLUGIN_ROOT}/hooks/report.mjs" --create "${CLAUDE_PLUGIN_DATA}" "$ARGUMENTS"`

Follow the instructions at the end of the output above. Never try to find, show or guess the invite link or its key: it is only in the browser. Do not run any other command.
