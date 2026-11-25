// report.mjs 不能从 shared/ 导入，表是抄过去的：这里保证两份一致。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as shared from "@agent-loop/shared";
import * as report from "../plugin/hooks/report.mjs";
import * as cli from "../cli/bin.mjs";

const root = resolve(__dirname, "..");

describe("插件和 shared/ 的表一致", () => {
  it("工具归类", () => {
    expect(report.TOOL_TABLE).toEqual(shared.TOOL_TABLE);
    for (const n of ["Read", "Bash", "mcp__x__y", "Nope", "", "SubagentHandback"]) expect(report.toolKind(n)).toBe(shared.toolKind(n));
  });
  it("事件名、来源、通知类型、内置子 agent 类型、模型名格式", () => {
    expect(report.EVENT_NAMES).toEqual([...shared.EVENT_NAMES]);
    expect(report.SESSION_SOURCES).toEqual([...shared.SESSION_SOURCES]);
    expect(report.NOTIFICATION_TYPES).toEqual([...shared.NOTIFICATION_TYPES]);
    expect(report.BUILTIN_AGENT_TYPES).toEqual([...shared.BUILTIN_AGENT_TYPES]);
    expect(report.MODEL_RE.source).toBe(shared.MODEL_RE.source);
    expect(report.PROTOCOL_VERSION).toBe(shared.PROTOCOL_VERSION);
    // 编号的长度：插件、命令行、shared 三份一样
    expect(report.ID_HEX).toBe(shared.ID_HEX);
    expect(cli.ID_HEX).toBe(shared.ID_HEX);
    expect(shared.ID_RE.source).toBe(`^[0-9a-f]{${shared.ID_HEX}}$`);
  });
  it("hooks.json 订阅的正是协议里的事件，全部用 node 加参数调用", () => {
    const h = JSON.parse(readFileSync(resolve(root, "plugin/hooks/hooks.json"), "utf8")).hooks;
    // Alive 不是 Claude Code 的 hook：插件替别的会话报的（见 report.mjs 的 sweepEnded）
    expect(Object.keys(h).sort()).toEqual(shared.EVENT_NAMES.filter(x => x !== "Alive").sort());
    for (const [ev, groups] of Object.entries<any>(h)) {
      const c = groups[0].hooks[0];
      expect(c).toMatchObject({ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/report.mjs"] });
      // SessionEnd 是同步加短超时（会话退出时异步进程会被杀掉），其余都是异步
      if (ev === "SessionEnd") { expect(c.async).toBeUndefined(); expect(c.timeout).toBeLessThanOrEqual(3); }
      else expect(c.async).toBe(true);
      // SessionStart、UserPromptSubmit 多一个同步的检查（异步 hook 的输出不显示给用户、也不进上下文）
      expect(groups.length).toBe(1);
      expect(groups[0].hooks.length).toBe(ev === "SessionStart" || ev === "UserPromptSubmit" ? 2 : 1);
    }
    for (const ev of ["SessionStart", "UserPromptSubmit"]) {
      expect(h[ev][0].hooks[1]).toEqual({ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/report.mjs", "--check"], timeout: 5 });
    }
  });
  it("附件的槽、附加校验数据、大小上限", () => {
    const evs = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure",
      "SubagentStart", "Notification", "Stop", "SessionEnd", "PostToolBatch"];
    for (const ev of evs) for (const extra of [{}, { tool: "t", agent: "a", prompt: "p" }]) {
      const e = { ev, sid: "s", proj: "p0", ...extra };
      expect(report.slotsOf(e), ev).toEqual(shared.slotsOf(e));
    }
    expect(report.aadOf("step", "s", "k")).toBe(shared.aadOf("step", "s", "k"));
    expect(report.SMALL_MAX_BYTES).toBe(shared.SMALL_MAX_BYTES);
    expect(report.FULL_MAX_BYTES).toBe(shared.FULL_MAX_BYTES);
  });
  it("插件设置：默认地址两处一致；邀请链接是敏感设置；分享档位的选项", () => {
    const p = JSON.parse(readFileSync(resolve(root, "plugin/.claude-plugin/plugin.json"), "utf8"));
    expect(p.userConfig.server_url.default).toBe(report.DEFAULT_SERVER_URL);
    expect(p.userConfig.server_url.sensitive).toBe(true);
    expect(p.userConfig.share.options).toEqual(report.SHARE_OPTIONS);
    expect(Object.keys(p.userConfig).sort()).toEqual(["name", "server_url", "share"]);
    // 插件的版本：plugin.json、report.mjs（放在请求头里）、shared（服务器拿来比）三处一样
    expect(report.PLUGIN_VERSION).toBe(p.version);
    expect(shared.PLUGIN_VERSION).toBe(p.version);
    // 提示更新的门槛不能比最新版还新（不然装了最新版的人也被提示）
    expect(shared.pluginOutdated(shared.PLUGIN_VERSION, shared.PLUGIN_NAG_BELOW)).toBe(false);
    // 插件建群的版本：页面（要多新的插件）和插件（要多新的服务器）用的是同一个
    expect(report.CREATE_SINCE).toBe(shared.CREATE_SINCE);
    expect(report.LEFT_SINCE).toBe(shared.LEFT_SINCE);
    const mk = JSON.parse(readFileSync(resolve(root, ".claude-plugin/marketplace.json"), "utf8"));
    expect(mk.plugins[0].name).toBe(p.name);
    expect(mk.plugins[0].source).toBe("./plugin");
  });
  it("插件版本的比较", () => {
    expect(shared.pluginOutdated("", "0.2.1")).toBe(true);
    expect(shared.pluginOutdated("junk", "0.2.1")).toBe(true);
    expect(shared.pluginOutdated("0.2.0", "0.2.1")).toBe(true);
    expect(shared.pluginOutdated("0.1.9", "0.2.1")).toBe(true);
    expect(shared.pluginOutdated("0.2.1", "0.2.1")).toBe(false);
    expect(shared.pluginOutdated("0.10.0", "0.2.1")).toBe(false);
    expect(shared.pluginOutdated("1.0.0", "0.2.1")).toBe(false);
  });
  it("错误归类", () => {
    expect(report.errorKind("overloaded_error")).toBe("server");
    expect(report.errorKind({ type: "authentication_error" })).toBe("auth");
    expect(report.errorKind("authentication_failed")).toBe("auth");
    expect(report.errorKind("billing_error")).toBe("billing");
    expect(report.errorKind("max_output_tokens")).toBe("max_output");
    expect(report.errorKind("rate_limit")).toBe("rate_limit");
    expect(report.errorKind("server_error")).toBe("server");
    expect(report.errorKind("weird")).toBe("other");
  });
});
