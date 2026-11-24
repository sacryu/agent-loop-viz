// 工具归类表。plugin/hooks/report.mjs 里抄了一份（它不能从这里导入），由 test/plugin-sync.test.ts 保证两份一致。
// 依据是 Python 版 agentloop/humanize.py 的工具分组。MCP 工具一律记成 mcp：名字里可能带公司内部系统名。

export const TOOL_KINDS = ["read", "edit", "search", "shell", "web", "agent", "ask", "plan", "progress", "mcp", "other"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export const TOOL_TABLE: Record<string, ToolKind> = {
  Read: "read", NotebookRead: "read", LS: "read",
  Edit: "edit", MultiEdit: "edit", Write: "edit", NotebookEdit: "edit",
  Grep: "search", Glob: "search",
  Bash: "shell", PowerShell: "shell", BashOutput: "shell", KillBash: "shell", KillShell: "shell",
  WebFetch: "web", WebSearch: "web",
  Task: "agent", Agent: "agent",
  AskUserQuestion: "ask",
  ExitPlanMode: "plan",
  TodoWrite: "progress", TaskCreate: "progress", TaskUpdate: "progress", TaskList: "progress", TaskGet: "progress",
  // 实测：子 agent 交回结果时调用的内部工具，只是记账
  SubagentHandback: "progress",
};

export function toolKind(name: string | undefined | null): ToolKind {
  const n = name || "";
  if (Object.prototype.hasOwnProperty.call(TOOL_TABLE, n)) return TOOL_TABLE[n];
  if (n.startsWith("mcp__")) return "mcp";
  return "other";
}

// 画面上的五条支线。记账类和问你的工具不出站。
export const BRANCHES = ["net", "file", "term", "ext", "sub"] as const;
export type Branch = (typeof BRANCHES)[number];

export function branchOf(kind: ToolKind | undefined | null): Branch | null {
  switch (kind) {
    case "read": case "edit": case "search": return "file";
    case "shell": return "term";
    case "web": return "net";
    case "agent": return "sub";
    case "mcp": case "other": return "ext";
    default: return null;   // ask、plan、progress
  }
}
