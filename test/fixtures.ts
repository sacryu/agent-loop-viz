// 每种事件的完整假数据。每个字符串字段里都塞着唯一的标记串（路径、命令、输入的话、报错……），
// 还加了几个 Claude Code 以后可能新增的字段。档位 0 的输出里一个标记串都不能出现。

let n = 0;
export const MARKS: string[] = [];
/** 唯一的标记串。故意用字母和下划线，好让它也能通过模型名之类的格式检查（看白名单是不是真的挡住了它） */
export function m(label: string): string {
  const s = `ZQXMARK${label.replace(/[^A-Za-z0-9]/g, "")}N${++n}Z`;
  MARKS.push(s);
  return s;
}

function common(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: m("session"), transcript_path: `C:\\Users\\${m("user")}\\.claude\\projects\\${m("tp")}.jsonl`,
    cwd: `C:\\Users\\${m("user")}\\code\\${m("cwd")}`, hook_event_name: name, permission_mode: m("pmode"),
    prompt_id: m("prompt"), effort: m("effort"), scratchpad_dir: `/tmp/${m("scratch")}`,
    // 以后可能新增的字段：白名单不认识，就不能出去
    future_field: m("future"), future_obj: { nested: m("futureNested"), list: [m("futureList")] },
    hostname: m("host"), user_email: `${m("email")}@example.com`, git_branch: m("branch"), session_title: m("title"),
    ...extra,
  };
}

const toolInput = () => ({
  command: `rm -rf ${m("cmd")}`, file_path: `/home/${m("fp")}/secret.ts`, description: m("desc"), prompt: m("subPrompt"),
  subagent_type: m("subtype"), pattern: m("pattern"), url: `https://${m("url")}.internal/x`, content: m("content"),
});

export function fixtures(): Record<string, unknown>[] {
  return [
    common("SessionStart", { source: m("source"), model: m("model"), agent_type: m("agentTypeSS") }),
    common("SessionStart", { source: "startup", model: { id: m("modelObj") } }),
    common("SessionEnd", { reason: m("reason") }),
    common("UserPromptSubmit", { prompt: `please fix ${m("userPrompt")} in C:\\${m("path")}` }),
    common("UserPromptSubmit", { prompt: `<task-notification><task-id>${m("taskid")}</task-id>${m("taskOut")}` }),
    common("PreToolUse", { tool_name: "Bash", tool_input: toolInput(), tool_use_id: m("tuid") }),
    common("PreToolUse", { tool_name: `mcp__${m("mcpServer")}__${m("mcpTool")}`, tool_input: toolInput(), tool_use_id: m("tuid") }),
    common("PreToolUse", { tool_name: m("unknownTool"), tool_input: toolInput(), tool_use_id: m("tuid") }),
    common("PreToolUse", { tool_name: "Agent", tool_input: toolInput(), tool_use_id: m("tuid") }),
    common("PostToolUse", { tool_name: "Read", tool_input: toolInput(), tool_response: { stdout: m("stdout"), file: { content: m("fileContent") } },
      tool_use_id: m("tuid"), duration_ms: 1234 }),
    common("PostToolUseFailure", { tool_name: "Bash", tool_input: toolInput(), tool_use_id: m("tuid"), error: m("toolError"),
      is_interrupt: true, duration_ms: 50 }),
    common("PostToolBatch", { tool_calls: [{ tool_name: "Read", tool_input: toolInput(), tool_use_id: m("tuid"), tool_response: m("resp") }] }),
    common("PermissionRequest", { tool_name: "Bash", tool_input: toolInput(), tool_use_id: m("tuid"),
      permission_suggestions: [{ type: m("sugg"), rules: [{ toolName: m("rule") }] }] }),
    common("PermissionDenied", { tool_name: "Write", tool_input: toolInput(), tool_use_id: m("tuid"), reason: m("denyReason") }),
    common("Notification", { message: m("notifMsg"), title: m("notifTitle"), notification_type: "permission_prompt" }),
    common("Notification", { message: m("notifMsg"), notification_type: m("ntype") }),
    common("Stop", { stop_hook_active: false, last_assistant_message: m("answer"),
      background_tasks: [{ id: m("bgid"), type: "shell", status: "running", description: m("bgDesc"), command: m("bgCmd") },
        { id: m("bgid"), type: "subagent", status: "running", description: m("bgDesc"), agent_type: m("bgType") }],
      session_crons: [{ id: m("cron"), prompt: m("cronPrompt") }] }),
    common("StopFailure", { error: "rate_limit", error_details: m("errDetails"), last_assistant_message: m("answer") }),
    common("StopFailure", { error: { type: m("errType"), message: m("errMessage") } }),
    common("SubagentStart", { agent_id: m("agentId"), agent_type: m("customAgent") }),
    common("SubagentStart", { agent_id: m("agentId"), agent_type: "Explore" }),
    common("SubagentStop", { agent_id: m("agentId"), agent_type: m("customAgent"), stop_hook_active: false,
      agent_transcript_path: `/x/${m("atp")}`, last_assistant_message: m("subAnswer"), background_tasks: [], session_crons: [] }),
    common("PreToolUse", { agent_id: m("agentId"), agent_type: m("customAgent"), tool_name: "Grep", tool_input: toolInput(), tool_use_id: m("tuid") }),
    common("PreCompact", { trigger: m("trigger"), custom_instructions: m("instructions") }),
    common("PostCompact", { trigger: "auto", compact_summary: m("summary") }),
  ];
}
