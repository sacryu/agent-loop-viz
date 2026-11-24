// 防泄漏测试：每种事件的完整假数据，每个字符串字段都塞着唯一的标记串。
// 档位 0 的输出里一个标记串都不能出现，并且必须通过 shared/ 的 schema 严格校验（不允许多余字段）。
// 非本机的三个档位：明文里一个标记串都不能出现；用密钥解开附件后，出现的标记串和方案 6.2 的表完全对应。
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { aadOf, Level0Event, LocalEvent, RemoteEvent, slotsOf } from "@agent-loop/shared";
import {
  buildEvent, createGroup, deriveKeys, galaxyCommand, galaxyId, galaxyUrl, movedFrom, noteStale, statusCommand, isLocal, labelFromPrompt, lastSentence, lastStatus, loadIdentity, modelFromTranscript, parseTarget,
  fingerprint, helloGroups, leaveOrRejoin, leftGroups, markLeft, nodeProblem, recordStatus, rememberTarget, reportProblem, resolveTarget, blockMessage, markMoved, usageFromTranscript,
  PLUGIN_VERSION, scrubKeys, settings, shareLevel, toolObj, liveSessions, recentSessions, sweepEnded,
} from "../plugin/hooks/report.mjs";
import { fixtures, m, MARKS } from "./fixtures.ts";

const SALT = "0123456789abcdef0123456789abcdef";
const SCRIPT = resolve(__dirname, "../plugin/hooks/report.mjs");

function leaks(text: string): string[] {
  return MARKS.filter(x => text.includes(x));
}

describe("档位 0：白名单", () => {
  const projectDir = `C:\\Users\\${m("projUser")}\\${m("projectDir")}`;
  const evs = fixtures();

  it("覆盖了所有订阅的事件", () => {
    const names = new Set(evs.map(e => e.hook_event_name));
    for (const n of ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
      "PostToolBatch", "PermissionRequest", "PermissionDenied", "Notification", "Stop", "StopFailure", "SubagentStart",
      "SubagentStop", "PreCompact", "PostCompact"]) expect(names.has(n), n).toBe(true);
  });

  for (const hook of evs) {
    it(`${hook.hook_event_name} 不带出任何标记串，且严格符合 schema`, () => {
      const out = buildEvent(hook, { salt: SALT, level: 0, projectDir });
      expect(out).not.toBeNull();
      const text = JSON.stringify(out);
      expect(leaks(text)).toEqual([]);
      const r = Level0Event.safeParse(out);
      expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
      expect(RemoteEvent.safeParse(out).success).toBe(true);
      expect(out).not.toHaveProperty("raw");
    });
  }

  it("归类和布尔值是对的", () => {
    const by = (name: string, i = 0) => evs.filter(e => e.hook_event_name === name)[i];
    const b = (h: unknown) => buildEvent(h, { salt: SALT, level: 0, projectDir })!;
    expect(b(by("PreToolUse", 0)).kind).toBe("shell");
    expect(b(by("PreToolUse", 1)).kind).toBe("mcp");
    expect(b(by("PreToolUse", 2)).kind).toBe("other");
    expect(b(by("PreToolUse", 3))).toMatchObject({ kind: "agent", agent_type: "custom" });
    expect(b(by("UserPromptSubmit", 0)).task_note).toBe(false);
    expect(b(by("UserPromptSubmit", 1)).task_note).toBe(true);
    expect(b(by("PostToolUseFailure")).interrupt).toBe(true);
    expect(b(by("Stop")).bg).toBe(2);
    expect(b(by("StopFailure", 0)).err_kind).toBe("rate_limit");
    expect(b(by("SubagentStart", 0)).agent_type).toBe("custom");
    expect(b(by("SubagentStart", 1)).agent_type).toBe("Explore");
    expect(b(by("Notification", 0)).ntype).toBe("permission_prompt");
    expect(b(by("Notification", 1))).not.toHaveProperty("ntype");
    expect(b(by("SessionStart", 0))).not.toHaveProperty("source");
    expect(b(by("SessionStart", 0))).not.toHaveProperty("model");
    expect(b({ ...by("SessionStart", 1), model: "claude-opus-5-5[1m]" }).model).toBe("claude-opus-5-5[1m]");
  });

  it("派遣和起来的子 agent 用同一个类型哈希配对", () => {
    const pre = buildEvent({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Agent", tool_use_id: "t",
      tool_input: { description: "x" } }, { salt: SALT, level: 0 })!;
    const start = buildEvent({ hook_event_name: "SubagentStart", session_id: "s", agent_id: "a", agent_type: "general-purpose" },
      { salt: SALT, level: 0 })!;
    expect(pre.agent_type_h).toBe(start.agent_type_h);
    expect(pre.agent_type).toBe("general-purpose");
  });

  it("项目目录统一大小写和分隔符后再哈希；优先用启动目录", () => {
    const a = buildEvent({ hook_event_name: "Stop", session_id: "s", cwd: "C:\\X\\Proj\\" }, { salt: SALT, level: 0 })!;
    const b = buildEvent({ hook_event_name: "Stop", session_id: "s", cwd: "c:/x/proj" }, { salt: SALT, level: 0 })!;
    const c = buildEvent({ hook_event_name: "Stop", session_id: "s", cwd: "c:/x/proj/sub" }, { salt: SALT, level: 0, projectDir: "C:\\X\\Proj" })!;
    expect(a.proj).toBe(b.proj);
    expect(c.proj).toBe(a.proj);
  });

  it("不认识的事件、没有 session_id 的数据不发", () => {
    expect(buildEvent({ hook_event_name: "MessageDisplay", session_id: "s" }, { salt: SALT, level: 0 })).toBeNull();
    expect(buildEvent({ hook_event_name: "Stop" }, { salt: SALT, level: 0 })).toBeNull();
    expect(buildEvent("nope", { salt: SALT, level: 0 })).toBeNull();
  });
});

describe("地址、设置和档位", () => {
  it("只有回环地址算本机", () => {
    expect(isLocal("http://127.0.0.1:4317")).toBe(true);
    expect(isLocal("http://localhost:4317")).toBe(true);
    expect(isLocal("http://[::1]:4317")).toBe(true);
    for (const u of ["https://agent-loop.example", "http://127.0.0.2:4317", "http://localhost.evil.com", "http://192.168.1.2",
      "http://0.0.0.0:4317", "not a url", "http://127.0.0.1.nip.io"]) expect(isLocal(u), u).toBe(false);
  });
  it("没配置时用本机地址；邀请链接拆成地址和密钥", () => {
    expect(settings({}).target.url).toBe("http://127.0.0.1:4317");
    expect(settings({ CLAUDE_PLUGIN_OPTION_SERVER_URL: "http://127.0.0.1:4317/" }).target.url).toBe("http://127.0.0.1:4317");
    expect(settings({ CLAUDE_PLUGIN_OPTION_SERVER_URL: "${user_config.server_url}" }).target.url).toBe("http://127.0.0.1:4317");
    expect(parseTarget("")).toEqual({ url: "http://127.0.0.1:4317", k: null });
    const K = "k".repeat(43);
    expect(parseTarget(`https://loop.example.com/#k=${K}`)).toEqual({ url: "https://loop.example.com", k: K });
    expect(parseTarget(`https://loop.example.com/sub/#g=0123456789abcdef&k=${K}&mine`)).toEqual({ url: "https://loop.example.com/sub", k: K });
    expect(settings({ CLAUDE_PLUGIN_OPTION_SERVER_URL: `https://x.example/#k=${K}`, CLAUDE_PLUGIN_OPTION_SHARE: "full",
      CLAUDE_PLUGIN_OPTION_NAME: "  Yu  " })).toEqual({ target: { url: "https://x.example", k: K }, share: "full", me: "Yu" });
  });
  it("分享档位：没设或 auto 时本机完整、别处概要；认不出的值按概要", () => {
    expect(shareLevel("", true)).toBe(2);
    expect(shareLevel("auto", false)).toBe(1);
    expect(shareLevel("anonymous", true)).toBe(0);
    expect(shareLevel("summary", true)).toBe(1);
    expect(shareLevel("FULL", false)).toBe(2);
    expect(shareLevel("everything", false)).toBe(1);
    expect(shareLevel("${user_config.share}", true)).toBe(2);
  });
  it("本机、档位 2：明文的小附件、大附件，加原样数据", () => {
    const hook = fixtures().find(e => e.hook_event_name === "PreToolUse")!;
    const out = buildEvent(hook, { salt: SALT, level: 2, local: true })!;
    expect(out.raw).toEqual(hook);
    expect(out.detail).toMatchObject({ name: "Bash" });
    expect(out.detail_full).toEqual((hook as any).tool_input);
    expect(LocalEvent.safeParse(out).success).toBe(true);
    expect(RemoteEvent.safeParse(out).success).toBe(false);
    expect(Level0Event.safeParse(out).success).toBe(false);
  });
  it("邀请密钥不会跟着附件出去：接入命令、粘进来的链接、回答里复述的链接都抹掉", () => {
    const key = "q2Vr0YI4Zx3m7J-L_uYbqzT9c1a8RkQeWnV6pHsAdQ0", link = `https://loop.example.com/#k=${key}`;
    const hooks = [
      { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_use_id: "t",
        tool_input: { command: `claude plugin install agent-loop@agent-loop --config "server_url=${link}"` } },
      { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_use_id: "t", tool_response: { stdout: `saved ${link}&g=x` } },
      { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: `join this: ${link}` },
      { hook_event_name: "Stop", session_id: "s", last_assistant_message: `Done, using ?k=${key}` },
    ];
    for (const hook of hooks) {
      const text = JSON.stringify(buildEvent(hook, { salt: SALT, level: 2, local: true }));
      expect(text, hook.hook_event_name).not.toContain(key);
      expect(text).toContain("k=…");
    }
    expect(JSON.stringify(scrubKeys(hooks[0]))).toContain("server_url=https://loop.example.com/#k=…");
    const plain = { hook_event_name: "Stop", session_id: "s", last_assistant_message: "k=short" };
    expect(scrubKeys(plain)).toBe(plain);   // 没有密钥：原样返回
  });
  it("本机、档位 0：和以前的档位 0 一样，什么附件都没有", () => {
    for (const hook of fixtures()) {
      const out = buildEvent(hook, { salt: SALT, level: 0, local: true })!;
      expect(Level0Event.safeParse(out).success).toBe(true);
    }
  });
});

describe("附件的短字段（照搬 Python 版 humanize.py）", () => {
  it("对话标签：第一句的开头，在标点处截断", () => {
    expect(labelFromPrompt("帮我修一下登录页的 bug，顺便看看样式")).toBe("帮我修一下登录页的 bug");
    expect(labelFromPrompt("1. 先跑测试，然后提交")).toBe("1. 先跑测试");
    expect(labelFromPrompt("Please refactor the server so that groups are isolated")).toBe("Please refactor…");
    expect(labelFromPrompt("看 http://x.com/a 这个")).toBe("看 http://x.com/a 这个");
    expect(labelFromPrompt("[Image #1] 这是什么")).toBe("这是什么");
    expect(labelFromPrompt("")).toBe("");
  });
  it("回答的最后一句", () => {
    expect(lastSentence("改好了。\n\n- 测试都过了\n- **可以提交**了！")).toBe("可以提交了！");
    expect(lastSentence("Done. All tests pass.")).toBe("All tests pass.");
  });
  it("一步的对象", () => {
    expect(toolObj("Bash", { command: "npm   run\n check" })).toBe("npm run check");
    expect(toolObj("Read", { file_path: "C:\\code\\web\\draw.ts" })).toBe("web/draw.ts");
    expect(toolObj("WebFetch", { url: "https://docs.example.com/a?b" })).toBe("docs.example.com");
    expect(toolObj("Agent", { description: "Find usages\nmore", subagent_type: "Explore" })).toBe("Find usages");
    expect(toolObj("AskUserQuestion", { questions: [{ question: "Which one?" }] })).toBe("Which one?");
    expect(toolObj("mcp__github__get_issue", { id: 1 })).toBe("");
    expect(toolObj("Grep", { pattern: "x".repeat(100) }).length).toBe(60);
    // 很长的文件名：留结尾，长度在协议的上限以内（本机的服务器按 schema 严格校验，超了整条事件都会被拒）
    const long = toolObj("Read", { file_path: "/a/" + "d".repeat(300) + "/" + "f".repeat(300) + ".ts" });
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith(".ts")).toBe(true);
  });
  it("模型名从会话记录末尾取，只认 Claude 的模型名", () => {
    const d = mkdtempSync(join(tmpdir(), "al-tr-"));
    const f = join(d, "t.jsonl");
    writeFileSync(f, [JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5-5" } }),
      JSON.stringify({ type: "user", message: {} }), JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5" } }),
      JSON.stringify({ type: "assistant", message: { model: "<synthetic>" } }), ""].join("\n"));
    expect(modelFromTranscript(f)).toBe("claude-opus-5-5");
    expect(modelFromTranscript(join(d, "nope.jsonl"))).toBeUndefined();
    const hook = { hook_event_name: "Stop", session_id: "s", transcript_path: f };
    expect(buildEvent(hook, { salt: SALT, level: 0, readModel: modelFromTranscript })!.model).toBe("claude-opus-5-5");
    rmSync(d, { recursive: true, force: true });
  });
  it("模型名在读 token 数时顺带取：记录末尾全是工具输出也取得到，<synthetic> 和子 agent 的不算", () => {
    const d = mkdtempSync(join(tmpdir(), "al-model-"));
    const f = join(d, "t.jsonl"), cache = join(d, "c.json");
    const usage = { input_tokens: 1, output_tokens: 1 };
    const a = (id: string, model: string, extra = {}) => JSON.stringify({ type: "assistant", ...extra, message: { id, model, usage } });
    const toolOut = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(10_000) }] } });
    // 主对话一条回答，后面跟着 100KB 的工具输出：末尾 64KB 里没有 assistant 行
    writeFileSync(f, [a("m1", "claude-opus-5-5"), ...Array(10).fill(toolOut), ""].join("\n"));
    expect(modelFromTranscript(f)).toBeUndefined();
    expect(usageFromTranscript(f, cache)?.model).toBe("claude-opus-5-5");
    const calls: unknown[] = [];
    const readModel = (p: unknown) => { calls.push(p); return modelFromTranscript(p); };
    const rd = { salt: SALT, level: 0 as const, readModel, readUsage: (p: unknown) => usageFromTranscript(p, cache) };
    for (const ev of ["SessionStart", "Stop"]) {
      const e = buildEvent({ hook_event_name: ev, session_id: "s", transcript_path: f }, rd)!;
      expect(e.model, ev).toBe("claude-opus-5-5");
      expect(Level0Event.safeParse(e).success).toBe(true);
    }
    expect(calls).toEqual([]);   // 不再读第二遍
    // hook 数据给了模型名就用它
    expect(buildEvent({ hook_event_name: "Stop", session_id: "s", transcript_path: f, model: "claude-sonnet-5-5" }, rd)!.model).toBe("claude-sonnet-5-5");
    // <synthetic> 回答、子 agent 的回答都不改模型名；接着缓存读也还记得
    appendFileSync(f, [a("x", "<synthetic>"), a("sub", "claude-haiku-5-5", { isSidechain: true }), toolOut, ""].join("\n"));
    expect(usageFromTranscript(f, cache)?.model).toBe("claude-opus-5-5");
    appendFileSync(f, [toolOut, ""].join("\n"));
    expect(usageFromTranscript(f, cache)?.model).toBe("claude-opus-5-5");
    expect(usageFromTranscript(f)?.model).toBe("claude-opus-5-5");
    // 主对话换了模型
    appendFileSync(f, [a("m2", "claude-sonnet-5-5"), ""].join("\n"));
    expect(usageFromTranscript(f, cache)?.model).toBe("claude-sonnet-5-5");
    // 缓存里的模型名也要校验
    writeFileSync(cache, JSON.stringify({ ...JSON.parse(readFileSync(cache, "utf8")), model: "my-gateway-model" }));
    expect(usageFromTranscript(f, cache)).not.toHaveProperty("model");
    // 旧版本的缓存（没有模型名）：从头再读一遍
    writeFileSync(cache, JSON.stringify({ ...JSON.parse(readFileSync(cache, "utf8")), v: 3, model: undefined }));
    expect(usageFromTranscript(f, cache)?.model).toBe("claude-sonnet-5-5");
    // 子 agent 的 Stop 不读 usage：还是从记录末尾取
    expect(buildEvent({ hook_event_name: "Stop", session_id: "s", agent_id: "a", transcript_path: f }, rd)!.model).toBe("claude-sonnet-5-5");
    expect(calls).toEqual([f]);
    // 主对话还没有回答：退回读记录末尾（这里也没有）
    const g = join(d, "empty.jsonl");
    writeFileSync(g, [JSON.stringify({ type: "user", message: { content: "hi" } }), ""].join("\n"));
    expect(buildEvent({ hook_event_name: "SessionStart", session_id: "s2", transcript_path: g }, { ...rd, readUsage: (p: unknown) => usageFromTranscript(p) })).not.toHaveProperty("model");
    expect(calls).toEqual([f, g]);
    rmSync(d, { recursive: true, force: true });
  });
  it("对话的标题从会话记录读：Claude Code 起的，/rename 改过的优先；变了才在每圈结束时带", async () => {
    const d = mkdtempSync(join(tmpdir(), "al-title-"));
    const f = join(d, "t.jsonl"), cache = join(d, "c.json");
    const ai = (t: string) => JSON.stringify({ type: "ai-title", aiTitle: t, sessionId: "s" });
    // 用户的话里提到 ai-title 不算
    writeFileSync(f, [JSON.stringify({ type: "user", message: { content: '{"type":"ai-title","aiTitle":"no"}' } }), ""].join("\n"));
    expect(usageFromTranscript(f, cache)).toBeUndefined();
    appendFileSync(f, [ai("Fix tide offset"), ""].join("\n"));
    expect(usageFromTranscript(f, cache)).toEqual({ ctx: 0, out: 0, laps: 0, steps: 0, title: "Fix tide offset", titleNew: true });
    appendFileSync(f, [ai("Fix tide offset"), ""].join("\n"));
    expect(usageFromTranscript(f, cache)).toEqual({ ctx: 0, out: 0, laps: 0, steps: 0, title: "Fix tide offset" });   // 重写了一遍，没变
    appendFileSync(f, [JSON.stringify({ type: "custom-title", customTitle: "My name", sessionId: "s" }), ai("Other"), ""].join("\n"));
    expect(usageFromTranscript(f, cache)).toEqual({ ctx: 0, out: 0, laps: 0, steps: 0, title: "My name", titleNew: true });
    // 旧版本的缓存（没有标题）：从头再读一遍
    writeFileSync(cache, JSON.stringify({ path: f, off: readFileSync(f).length, out: 0, ctx: 0, ids: [] }));
    expect(usageFromTranscript(f, cache)?.title).toBe("My name");

    const hook = (ev: string, extra = {}) => ({ hook_event_name: ev, session_id: "s", transcript_path: f, prompt: "hi", ...extra });
    const read = (titleNew: boolean) => () => ({ ctx: 0, out: 0, title: "My name", ...(titleNew ? { titleNew: true as const } : {}) });
    const local = { salt: SALT, level: 1 as const, local: true };
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"]) expect(buildEvent(hook(ev), { ...local, readUsage: read(false) })!.title, ev).toEqual({ label: "My name" });
    expect(buildEvent(hook("PostToolBatch"), { ...local, readUsage: read(false) })!.title).toBeUndefined();
    expect(buildEvent(hook("PostToolBatch"), { ...local, readUsage: read(true) })!.title).toEqual({ label: "My name" });
    expect(buildEvent(hook("PreToolUse", { tool_name: "Read" }), { ...local, readUsage: read(true) })!.title).toBeUndefined();
    expect(buildEvent(hook("Stop", { agent_id: "a" }), { ...local, readUsage: read(true) })!.title).toBeUndefined();   // 子 agent 不带
    // 档位 0 不带；非本机加密，槽 title、键为空
    const l0 = buildEvent(hook("Stop"), { salt: SALT, level: 0, local: true, readUsage: read(true) })!;
    expect(l0.title).toBeUndefined();
    expect(Level0Event.safeParse(l0).success).toBe(true);
    const r = buildEvent(hook("Stop"), { salt: SALT, level: 1, key: deriveKeys(K)!.content, readUsage: read(true) })!;
    expect(r.title).toBeUndefined();
    expect(RemoteEvent.safeParse(r).success).toBe(true);
    expect(await open(K, r.enc_title!, aadOf("title", r.sid, ""))).toEqual({ label: "My name" });
    rmSync(d, { recursive: true, force: true });
  });
  it("token 数从会话记录读：同一条回答只算一次，子 agent 不算，接着上次读到的地方往下读", () => {
    const d = mkdtempSync(join(tmpdir(), "al-tok-"));
    const f = join(d, "t.jsonl"), cache = join(d, "c.json");
    const a = (id: string, inp: number, out: number, extra = {}) => JSON.stringify({ type: "assistant", ...extra,
      message: { id, model: "claude-opus-5-5", usage: { input_tokens: inp, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: out } } });
    writeFileSync(f, [a("m1", 5, 100), a("m1", 5, 100), JSON.stringify({ type: "user", message: { content: "usage" } }),
      a("sub", 9, 7777, { isSidechain: true }), a("m2", 20, 50), ""].join("\n"));
    expect(usageFromTranscript(f, cache)).toEqual({ ctx: 1020, out: 150, laps: 2, steps: 0, model: "claude-opus-5-5" });
    // 接着写：m2 的又一条记录（不重复算）、m3，还有一行没写完
    appendFileSync(f, [a("m2", 20, 50), a("m3", 30, 25), '{"type":"assis'].join("\n"));
    expect(usageFromTranscript(f, cache)).toEqual({ ctx: 1030, out: 175, laps: 3, steps: 0, model: "claude-opus-5-5" });
    expect(JSON.parse(readFileSync(cache, "utf8")).off).toBeLessThan(readFileSync(f).length);
    // 不用缓存从头读，结果一样
    expect(usageFromTranscript(f)).toEqual({ ctx: 1030, out: 175, laps: 3, steps: 0, model: "claude-opus-5-5" });
    expect(usageFromTranscript(join(d, "nope.jsonl"))).toBeUndefined();
    const ev = buildEvent({ hook_event_name: "Stop", session_id: "s", transcript_path: f }, { salt: SALT, level: 0, readUsage: p => usageFromTranscript(p) })!;
    expect(ev).toMatchObject({ ctx_tok: 1030, out_tok: 175 });
    expect(Level0Event.safeParse(ev).success).toBe(true);
    // 子 agent 的事件不带
    expect(buildEvent({ hook_event_name: "PostToolBatch", session_id: "s", agent_id: "x", transcript_path: f }, { salt: SALT, level: 0, readUsage: p => usageFromTranscript(p) })).not.toHaveProperty("ctx_tok");
    rmSync(d, { recursive: true, force: true });
  });
  it("圈数、步数从会话记录读：一次回答一圈，工具按编号数，<synthetic> 和子 agent 不算；每圈结束时不带", () => {
    const d = mkdtempSync(join(tmpdir(), "al-laps-"));
    const f = join(d, "t.jsonl"), cache = join(d, "c.json");
    const usage = { input_tokens: 1, output_tokens: 1 };
    const a = (id: string, block: object, extra = {}) => JSON.stringify({ type: "assistant", ...extra,
      message: { id, model: "claude-opus-5-5", content: [block], usage } });
    const tu = (id: string) => ({ type: "tool_use", id, name: "Read", input: {} });
    writeFileSync(f, [
      a("m1", { type: "thinking", thinking: "" }), a("m1", tu("t1")), a("m1", tu("t2")), a("m1", tu("t2")),   // 第 1 圈：两个工具
      a("sub", tu("t9"), { isSidechain: true }),
      JSON.stringify({ type: "assistant", message: { id: "x", model: "<synthetic>", content: [{ type: "text", text: "API Error" }], usage } }),
      a("m2", { type: "text", text: "done" }), ""].join("\n"));
    expect(usageFromTranscript(f, cache)).toMatchObject({ laps: 2, steps: 2 });
    appendFileSync(f, [a("m3", tu("t3")), ""].join("\n"));
    expect(usageFromTranscript(f, cache)).toMatchObject({ laps: 3, steps: 3 });
    const rd = { salt: SALT, level: 0 as const, readUsage: (p: unknown) => usageFromTranscript(p) };
    for (const name of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      const ev = buildEvent({ hook_event_name: name, session_id: "s", transcript_path: f, prompt: "hi" }, rd)!;
      expect(ev).toMatchObject({ laps: 3, steps: 3 });
      expect(Level0Event.safeParse(ev).success).toBe(true);
    }
    expect(buildEvent({ hook_event_name: "PostToolBatch", session_id: "s", transcript_path: f }, rd)).not.toHaveProperty("laps");
    rmSync(d, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------ 加密

const K = "q2Vr0YI4Zx3m7J-L_uYbqzT9c1a8RkQeWnV6pHsAdQ0";   // 固定的 32 字节密钥（base64url），互通测试用
const subtle = globalThis.crypto.subtle;

/** 用 WebCrypto（浏览器里的同一套 API）解开密文：浏览器端解密的写法 */
async function open(k: string, sealed: string, aad: string): Promise<unknown> {
  const K = Uint8Array.from(Buffer.from(k.replace(/-/g, "+").replace(/_/g, "/") + "=", "base64"));
  const base = await subtle.importKey("raw", K, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0),
    info: new TextEncoder().encode("agent-loop/content/v1") }, base, 256);
  const key = await subtle.importKey("raw", bits, "AES-GCM", false, ["decrypt"]);
  const buf = Buffer.from(sealed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: buf.subarray(0, 12), additionalData: new TextEncoder().encode(aad) }, key, buf.subarray(12));
  return JSON.parse(new TextDecoder().decode(pt));
}

describe("非本机：附件一律加密", () => {
  const keys = deriveKeys(K)!;
  const projectDir = `C:\\Users\\${m("encUser")}\\${m("encProj")}`;
  const me = m("galaxyName");

  it("密钥派生：口令和星系群编号", () => {
    expect(keys.access).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keys.group).toMatch(/^[0-9a-f]{32}$/);
    expect(keys.content.length).toBe(32);
    expect(deriveKeys("too-short")).toBeNull();
  });

  for (const level of [0, 1, 2] as const) {
    it(`档位 ${level}：明文里没有任何标记串；解开以后只有方案 6.2 表里的东西`, async () => {
      const seen = new Set<string>();
      for (const hook of fixtures()) {
        const out = buildEvent(hook, { salt: SALT, level, local: false, key: keys.content, me, projectDir })!;
        expect(leaks(JSON.stringify(out)), hook.hook_event_name as string).toEqual([]);
        const r = RemoteEvent.safeParse(out);
        expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
        if (level === 0) { expect(out.enc).toBeUndefined(); expect(out.enc_full).toBeUndefined(); continue; }
        if (level === 1) expect(out.enc_full).toBeUndefined();
        const slots = slotsOf(out);
        if (out.enc) { const s = slots.small!; for (const x of leaks(JSON.stringify(await open(K, out.enc, aadOf(s.slot, s.sid, s.k))))) seen.add(x); }
        if (out.enc_full) { const s = slots.full!; for (const x of leaks(JSON.stringify(await open(K, out.enc_full, aadOf(s.slot, s.sid, s.k))))) seen.add(x); }
        // 提问补发的名片：只能有星系名和项目目录名，解开的位置和 SessionStart 的名片一样
        expect(out.enc_card !== undefined, hook.hook_event_name as string).toBe(hook.hook_event_name === "UserPromptSubmit" && !hook.agent_id);
        if (out.enc_card) {
          const card = await open(K, out.enc_card, aadOf("card", "", out.proj));
          expect(card).toEqual({ me, proj: projectDir.split("\\").pop() });
          for (const x of leaks(JSON.stringify(card))) seen.add(x);
        }
      }
      if (level === 0) return;
      const kinds = new Set([...seen].map(x => /^ZQXMARK(.*)N\d+Z$/.exec(x)![1]));
      // 小附件（档位 1 起）能出现的：星系名、项目目录名、输入的话（开头）、工具的对象、报错第一行、子 agent 类型、回答的最后一句、MCP 工具名
      const small = ["galaxyName", "encProj", "userPrompt", "cmd", "fp", "pattern", "url", "toolError", "customAgent", "answer",
        "mcpServer", "mcpTool", "unknownTool", "desc"];
      // 大附件（档位 2）另外能出现的：工具完整的输入输出、通知文字、完整报错
      const full = ["path", "subPrompt", "subtype", "content", "stdout", "fileContent", "notifMsg", "errMessage"];
      const allowed = new Set(level === 1 ? small : [...small, ...full]);
      for (const k of kinds) expect(allowed.has(k), `档位 ${level} 不该带出 ${k}`).toBe(true);
      // 反过来：表里该有的都有
      // （输入的话在小附件里只留开头约 12 个字宽，标记串被截掉了，所以只在档位 2 的整句话里出现）
      for (const k of ["galaxyName", "encProj", "cmd", "toolError", "customAgent", "answer"]) expect(kinds.has(k), k).toBe(true);
      if (level === 2) for (const k of ["content", "stdout", "notifMsg", "userPrompt"]) expect(kinds.has(k), k).toBe(true);
      // 无论哪一档都不能出去的：会话编号、路径里的用户名、主机、邮箱、分支、标题、以后新增的字段、后台任务的内容
      for (const k of ["session", "user", "tp", "host", "email", "branch", "title", "future", "futureNested", "bgCmd", "cronPrompt",
        "taskid", "taskOut", "summary", "instructions", "subAnswer", "atp"]) expect(kinds.has(k), k).toBe(false);
    });
  }

  it("密文挪到别的槽就解不开（附加校验数据把它钉在原处）", async () => {
    const hook = fixtures().find(e => e.hook_event_name === "PreToolUse")!;
    const out = buildEvent(hook, { salt: SALT, level: 2, local: false, key: keys.content })!;
    const s = slotsOf(out).small!;
    await expect(open(K, out.enc!, aadOf(s.slot, s.sid, s.k))).resolves.toMatchObject({ name: "Bash" });
    await expect(open(K, out.enc!, aadOf("fail", s.sid, s.k))).rejects.toThrow();
    await expect(open(K, out.enc!, aadOf(s.slot, s.sid, "0000000000000000"))).rejects.toThrow();
  });

  it("Node 加密、WebCrypto 解密：固定的密钥和数据，两边结果一致", async () => {
    const { seal } = await import("../plugin/hooks/report.mjs");
    const value = { name: "Read", obj: "web/draw.ts", 中文: "可以" };
    const sealed = seal(deriveKeys(K)!.content, value, "agent-loop/2|step|abc|def");
    expect(await open(K, sealed, "agent-loop/2|step|abc|def")).toEqual(value);
    // 派生出来的口令每次都一样（两边、每次运行都要一致）
    expect(deriveKeys(K)!.access).toBe(deriveKeys(K)!.access);
  });
});

describe("身份", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it("第一次生成，之后读同一份", () => {
    const d = mkdtempSync(join(tmpdir(), "al-id-")); dirs.push(d);
    const a = loadIdentity(d), b = loadIdentity(d);
    expect(a).toEqual(b);
    expect(a.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(a.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(galaxyId(a.secret)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("很多进程同时建，大家拿到的是同一份", async () => {
    const d = mkdtempSync(join(tmpdir(), "al-id-")); dirs.push(d);
    const run = () => new Promise<string>((res, rej) => {
      const p = spawn(process.execPath, [SCRIPT, "--galaxy", d, "http://127.0.0.1:1"]);
      let out = ""; p.stdout.on("data", x => (out += x)); p.on("error", rej); p.on("close", () => res(out.trim()));
    });
    const outs = await Promise.all(Array.from({ length: 12 }, run));
    expect(new Set(outs).size).toBe(1);
    // 服务器连不上、不知道版本：给旧页面也认的 #g=
    expect(outs[0]).toMatch(/^http:\/\/127\.0\.0\.1:1\/#g=[0-9a-f]{32}&mine$/);
    expect(outs[0].endsWith(`#g=${galaxyId(loadIdentity(d).secret)}&mine`)).toBe(true);
  });

  it("「我的星系」的网址：有邀请链接时带上密钥", () => {
    const d = mkdtempSync(join(tmpdir(), "al-id-")); dirs.push(d);
    const id = galaxyId(loadIdentity(d).secret);
    // 服务器够新（fresh）才用 galaxy=；不知道就用 0.2.10 以前的页面也认的 g=
    expect(galaxyUrl(d, `https://loop.example.com/#k=${K}`, true, true)).toBe(`https://loop.example.com/#k=${K}&galaxy=${id}&mine`);
    expect(galaxyUrl(d, "", true, true)).toBe(`http://127.0.0.1:4317/#galaxy=${id}&mine`);
    expect(galaxyUrl(d, `https://loop.example.com/#k=${K}`)).toBe(`https://loop.example.com/#k=${K}&g=${id}&mine`);
    expect(galaxyUrl(d, `https://loop.example.com/#k=${K}`, false)).toBe(`https://loop.example.com/#g=${id}&mine`);
  });
});

describe("脚本作为进程运行", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  async function capture(host: string, hooks: unknown[], extraEnv: Record<string, string> = {}, suffix = "") {
    const got: { body: any; auth: string | undefined; group: string | undefined; raw: string }[] = [];
    const srv = createServer((req: IncomingMessage, res) => {
      let b = ""; req.on("data", c => (b += c));
      req.on("end", () => {
        got.push({ body: JSON.parse(b), auth: req.headers.authorization, group: req.headers["x-group"] as string | undefined, raw: b });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>(r => srv.listen(0, host, r));
    const port = (srv.address() as any).port;
    const d = mkdtempSync(join(tmpdir(), "al-run-")); dirs.push(d);
    const outs: { stdout: string; stderr: string; code: number | null }[] = [];
    for (const h of hooks) {
      outs.push(await new Promise(res => {
        const p = spawn(process.execPath, [SCRIPT], {
          env: { ...process.env, CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: `http://${host}:${port}${suffix}`, ...extraEnv },
        });
        let stdout = "", stderr = "";
        p.stdout.on("data", x => (stdout += x)); p.stderr.on("data", x => (stderr += x));
        p.on("close", code => res({ stdout, stderr, code }));
        p.stdin.end(typeof h === "string" ? h : JSON.stringify(h));
      }));
    }
    srv.close();
    return { got, outs, dir: d };
  }

  it("非本机、没有邀请链接：一个字节都不发", async () => {
    const evs = fixtures();
    const { got, outs } = await capture("127.0.0.2", evs.slice(0, 5));
    expect(got.length).toBe(0);
    for (const o of outs) expect(o).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  it("非本机、选了 anonymous：发出去的请求严格是档位 0，没有标记串（经过 127.0.0.2，不算回环名单）", async () => {
    const evs = fixtures();
    const { got, outs, dir } = await capture("127.0.0.2", evs,
      { CLAUDE_PROJECT_DIR: `/home/${m("envProj")}`, CLAUDE_PLUGIN_OPTION_SHARE: "anonymous" }, `/#k=${K}`);
    expect(got.length).toBe(evs.length);
    for (const o of outs) expect(o).toEqual({ stdout: "", stderr: "", code: 0 });
    for (const g of got) {
      expect(g.body.level).toBe(0);
      expect(leaks(g.raw)).toEqual([]);
      expect(Level0Event.safeParse(g.body).success).toBe(true);
    }
    const secret = loadIdentity(dir).secret;
    expect(got.every(g => g.auth === `Bearer ${secret}` && g.group === deriveKeys(K)!.access)).toBe(true);
    // 请求里也没有 K 本身
    expect(got.some(g => g.raw.includes(K))).toBe(false);
  });

  it("非本机、默认档位：附件是密文，请求里没有标记串", async () => {
    const evs = fixtures();
    const { got } = await capture("127.0.0.2", evs, { CLAUDE_PROJECT_DIR: `/home/${m("envProj2")}`, CLAUDE_PLUGIN_OPTION_NAME: m("envName") }, `/#k=${K}`);
    expect(got.length).toBe(evs.length);
    expect(got.some(g => g.body.enc)).toBe(true);
    for (const g of got) {
      expect(g.body.level).toBe(1);
      expect(leaks(g.raw)).toEqual([]);
      expect(RemoteEvent.safeParse(g.body).success).toBe(true);
    }
  });

  it("本机、档位 2：明文附件加原样数据；记下地址给 /galaxy 用", async () => {
    const hook = { hook_event_name: "Stop", session_id: "abc", cwd: "/x", last_assistant_message: "hi" };
    const { got, dir } = await capture("127.0.0.1", [hook]);
    expect(got[0].body).toMatchObject({ level: 2, ev: "Stop", bg: 0, raw: hook, detail: { say: "hi" }, detail_full: "hi" });
    expect(readFileSync(join(dir, "server.json"), "utf8")).toContain("127.0.0.1");
  });

  it("坏数据、连不上服务器：什么都不输出，退出码 0", async () => {
    const run = (input: string, url: string) => new Promise<any>(res => {
      const d = mkdtempSync(join(tmpdir(), "al-run-")); dirs.push(d);
      const t0 = Date.now();
      const p = spawn(process.execPath, [SCRIPT], { env: { ...process.env, CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: url } });
      let out = ""; p.stdout.on("data", x => (out += x)); p.stderr.on("data", x => (out += x));
      p.on("close", code => res({ out, code, ms: Date.now() - t0 }));
      p.stdin.end(input);
    });
    expect(await run("{not json", "http://127.0.0.1:1")).toMatchObject({ out: "", code: 0 });
    expect(await run(JSON.stringify({ hook_event_name: "Stop", session_id: "s" }), "http://127.0.0.1:1")).toMatchObject({ out: "", code: 0 });
    // 不可路由的地址：2 秒超时后放弃
    const slow = await run(JSON.stringify({ hook_event_name: "Stop", session_id: "s" }), `http://10.255.255.1:9/#k=${K}`);
    expect(slow).toMatchObject({ out: "", code: 0 });
    expect(slow.ms).toBeLessThan(4000);
  });

  it("SessionEnd 在 Claude Code 给的约 1.5 秒内一定退出（服务器收下连接却一直不回）", async () => {
    const { createServer: tcp } = await import("node:net");
    const hang = tcp(() => { /* 不回 */ });
    await new Promise<void>(r => hang.listen(0, "127.0.0.2", r));
    const port = (hang.address() as any).port;
    const d = mkdtempSync(join(tmpdir(), "al-run-")); dirs.push(d);
    const t0 = Date.now();
    const code = await new Promise(res => {
      const p = spawn(process.execPath, [SCRIPT], { env: { ...process.env, CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: `http://127.0.0.2:${port}/#k=${K}` } });
      p.on("close", res);
      p.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s", reason: "other" }));
    });
    const ms = Date.now() - t0;
    hang.close();
    expect(code).toBe(0);
    expect(ms).toBeLessThan(1400);
  });
});

describe("上报不出去时告诉用户", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), "al-chk-")); dirs.push(d); return d; };
  const remote = "http://10.0.0.9:4317";
  /** 空的数据目录里的目标（没退出过、没换过群） */
  const R = (v: string) => resolveTarget(tmp(), v);

  it("设置有问题：非本机没有密钥、密钥不完整", () => {
    expect(reportProblem(R(remote), null)).toMatch(/no group key/);
    expect(reportProblem(R(`${remote}/#k=abc`), null)).toMatch(/incomplete/);
    expect(reportProblem(R(`${remote}/#k=${K}`), null)).toBeNull();
    expect(reportProblem(R(""), null)).toBeNull();   // 默认的本机地址、还没发过
  });

  it("地址漏了 http://：说清楚是少了协议，不说「连不上」；提示里不带密钥", () => {
    const p = reportProblem(R(`10.0.0.9:4317/#k=${K}`), { url: "10.0.0.9:4317", status: "unreachable" });
    expect(p).toMatch(/must start with http:\/\/ or https:\/\//);
    expect(p).not.toContain(K);
    expect(reportProblem(R(`HTTPS://loop.example.com/#k=${K}`), null)).toBeNull();
  });

  it("Node 太旧：说要 18 以上", () => {
    expect(nodeProblem("16.20.2")).toMatch(/Node\.js 18 or newer.*16\.20\.2/);
    expect(nodeProblem("18.0.0")).toBeNull();
    expect(nodeProblem(process.versions.node)).toBeNull();
  });

  it("上次的结果：只对同一个地址算数；成功、限流不提示；提示里不带密钥", () => {
    const t = R(`${remote}/#k=${K}`);
    expect(reportProblem(t, { url: remote, status: "unreachable" })).toMatch(/could not reach http:\/\/10\.0\.0\.9:4317/);
    expect(reportProblem(t, { url: remote, status: 403 })).toMatch(/HTTP 403/);
    expect(reportProblem(t, { url: remote, status: 401 })).toMatch(/HTTP 401/);
    expect(reportProblem(t, { url: remote, status: 400 })).toMatch(/update the plugin/);
    for (const s of [204, 429, 413, 503]) expect(reportProblem(t, { url: remote, status: s })).toBeNull();
    expect(reportProblem(t, { url: "http://other:1", status: "unreachable" })).toBeNull();
    expect(reportProblem(R(""), { url: "http://127.0.0.1:4317", status: "unreachable" })).toMatch(/npx agent-loop/);
    for (const s of ["unreachable", 401, 403, 400] as const) expect(reportProblem(t, { url: remote, status: s }) || "").not.toContain(K);
    expect(reportProblem(R(`${remote}/#k=abc`), null)).not.toContain("abc");
  });

  it("记下的结果读得回来，坏文件当没有", () => {
    const d = tmp();
    expect(lastStatus(d)).toBeNull();
    recordStatus(d, remote, "unreachable");
    expect(lastStatus(d)).toEqual({ url: remote, status: "unreachable" });
    recordStatus(d, remote, 204);
    expect(lastStatus(d)).toEqual({ url: remote, status: 204 });
    writeFileSync(join(d, "status.json"), "{bad");
    expect(lastStatus(d)).toBeNull();
  });

  const run = (args: string[], env: Record<string, string>, input = "") => new Promise<{ out: string; code: number | null }>(res => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } });
    let out = ""; p.stdout.on("data", x => (out += x)); p.stderr.on("data", x => (out += x));
    p.on("close", code => res({ out, code }));
    p.stdin.end(input);
  });
  const start = (source = "startup") => JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", source });

  it("--check：有问题时输出一行 systemMessage，没问题、压缩时什么都不输出", async () => {
    const d = tmp();
    const bad = await run(["--check"], { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: remote }, start());
    expect(bad.code).toBe(0);
    expect(JSON.parse(bad.out).systemMessage).toMatch(/no group key/);
    expect(await run(["--check"], { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: remote }, start("compact"))).toEqual({ out: "", code: 0 });
    expect(await run(["--check"], { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: `${remote}/#k=${K}` }, start())).toEqual({ out: "", code: 0 });
    expect(await run(["--check"], { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: remote }, "{bad")).toEqual({ out: "", code: 0 });
  });

  it("第一次在星系群里说话：把说明交给 Claude，每个群只讲一次；不带密钥；本机、设置有问题、退出过的不讲", async () => {
    const d = tmp(), link = `${remote}/#k=${K}`;
    const say = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "hi" });
    const env = { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: link, CLAUDE_PLUGIN_OPTION_NAME: "小王" };
    const first = await run(["--check"], env, say);
    expect(first.code).toBe(0);
    const o = JSON.parse(first.out).hookSpecificOutput;
    expect(o.hookEventName).toBe("UserPromptSubmit");
    expect(o.additionalContext).toContain(fingerprint(deriveKeys(K)!.group));
    expect(o.additionalContext).toMatch(/share = auto, which means summary/);
    expect(o.additionalContext).toContain('"小王"');
    expect(o.additionalContext).toContain("--values-stdin");
    expect(o.additionalContext).not.toContain(K);
    expect(helloGroups(d)).toEqual([deriveKeys(K)!.group]);
    expect(await run(["--check"], env, say)).toEqual({ out: "", code: 0 });   // 只讲一次
    // 会话开始时不讲（Claude 还不会开口）
    expect(await run(["--check"], { CLAUDE_PLUGIN_DATA: tmp(), CLAUDE_PLUGIN_OPTION_SERVER_URL: link }, start())).toEqual({ out: "", code: 0 });
    // 分享档位照实说
    const anon = JSON.parse((await run(["--check"], { CLAUDE_PLUGIN_DATA: tmp(), CLAUDE_PLUGIN_OPTION_SERVER_URL: link, CLAUDE_PLUGIN_OPTION_SHARE: "anonymous" }, say)).out);
    expect(anon.hookSpecificOutput.additionalContext).toMatch(/share = anonymous, which means anonymous/);
    // 本机、没有密钥、退出过、上次被拒收：不讲，也不记
    for (const [url, prep] of [
      ["", () => {}], [remote, () => {}],
      [link, (x: string) => markLeft(x, deriveKeys(K)!.group, true)],
      [link, (x: string) => recordStatus(x, remote, 403)],
    ] as const) {
      const x = tmp(); prep(x);
      expect(await run(["--check"], { CLAUDE_PLUGIN_DATA: x, CLAUDE_PLUGIN_OPTION_SERVER_URL: url }, say)).toEqual({ out: "", code: 0 });
      expect(helloGroups(x)).toEqual([]);
    }
  });

  it("接入命令（--welcome）：把正在跑的会话报上去，和 hook 同一颗行星；说明交给 Claude、只讲这一次；不带密钥", async () => {
    const got: any[] = [];
    const srv = createServer((req, res) => {
      let b = ""; req.on("data", x => (b += x));
      req.on("end", () => {
        if (req.url === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, local: false, open: true, version: PLUGIN_VERSION }));
        got.push({ path: req.url, group: req.headers["x-group"], ev: JSON.parse(b) }); res.writeHead(204).end();
      });
    });
    await new Promise<void>(r => srv.listen(0, "127.0.0.2", r));
    const url = `http://127.0.0.2:${(srv.address() as any).port}`, link = `${url}/#k=${K}`;
    // 假的 Claude Code 配置目录：会话记录、用户级设置里的 name、旧版本的插件
    const cfg = tmp(), proj = join(cfg, "projects", "C--work-demo"), sid = "0f8a1c2e-1111-2222-3333-444455556666";
    const { mkdirSync } = await import("node:fs");
    mkdirSync(proj, { recursive: true });
    mkdirSync(join(cfg, "plugins"), { recursive: true });
    writeFileSync(join(proj, `${sid}.jsonl`), [
      { type: "user", cwd: "C:\\work\\demo", message: { role: "user", content: "hi" } },
      { type: "assistant", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { output_tokens: 3 } } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ pluginConfigs: { "agent-loop@agent-loop": { options: { name: "小王" } } } }));
    writeFileSync(join(cfg, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "agent-loop@agent-loop": [{ version: "0.1.0" }] } }));
    markLeft(join(cfg, "plugins", "data", "agent-loop-agent-loop"), deriveKeys(K)!.group, true);   // 退出过，又拿邀请回来

    const env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PLUGIN_DATA: "" };
    const r = await run(["--welcome", link, "--no-open"], env);
    srv.close();
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(K);
    const d = join(cfg, "plugins", "data", "agent-loop-agent-loop");   // 插件装好以后 hook 用的数据目录
    const id = galaxyId(loadIdentity(d).secret);
    expect(r.out).toContain(`${url}/#galaxy=${id}&mine`);
    expect(r.out).toContain(fingerprint(deriveKeys(K)!.group));
    expect(r.out).toMatch(/\/reload-plugins/);
    expect(r.out).toMatch(/older than .*claude plugin update agent-loop@agent-loop/);
    expect(r.out).toContain('"小王"');
    expect(leftGroups(d)).toEqual([]);
    expect(helloGroups(d)).toEqual([deriveKeys(K)!.group]);
    // 发上去的：这个会话的 SessionStart，项目目录取自会话记录，和之后 hook 发的（CLAUDE_PROJECT_DIR 就是它）对得上
    expect(got.length).toBe(1);
    expect(got[0].path).toBe("/v1/events");
    expect(got[0].group).toBe(deriveKeys(K)!.access);
    const { secret, salt } = loadIdentity(d);
    const hookEv = buildEvent({ hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "x" }, { salt, level: 1, projectDir: "C:\\work\\demo" })!;
    expect(got[0].ev).toMatchObject({ ev: "SessionStart", sid: hookEv.sid, proj: hookEv.proj, model: "claude-opus-5-5", laps: 1 });
    expect(RemoteEvent.safeParse(got[0].ev).success).toBe(true);
    expect(JSON.stringify(got[0].ev)).not.toContain("小王");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    // 之后第一次说话时 hook 不再讲一遍
    const say = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "hi" });
    expect(await run(["--check"], { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: link }, say)).toEqual({ out: "", code: 0 });
  });

  /** 假的 Claude Code 配置目录，插件装好了（installed_plugins.json） */
  const installedCfg = (version = PLUGIN_VERSION) => {
    const cfg = tmp();
    mkdirSync(join(cfg, "plugins"), { recursive: true });
    writeFileSync(join(cfg, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "agent-loop@agent-loop": [{ version }] } }));
    return cfg;
  };
  const pluginData = (cfg: string) => join(cfg, "plugins", "data", "agent-loop-agent-loop");

  it("接入命令：链接不对就照实说，不发、不记；连不上就说连不上", async () => {
    const cfg = installedCfg(), env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: "s", CLAUDE_PLUGIN_DATA: "" };
    const bad = await run(["--welcome", `${remote}/#k=abc`, "--no-open"], env);
    expect(bad.out).toMatch(/^Problem: the invite link given to --welcome is not usable: .*43 characters/);
    expect(helloGroups(pluginData(cfg))).toEqual([]);
    const down = await run(["--welcome", `http://127.0.0.2:1/#k=${K}`, "--no-open"], env);
    expect(down.out).toMatch(/Problem: could not reach http:\/\/127\.0\.0\.2:1/);
    expect(down.out).not.toContain(K);
  });

  it("接入命令：没带链接（或者 --no-open 放在前面）不会悄悄退回本机地址", async () => {
    const cfg = installedCfg(), env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: "", CLAUDE_PLUGIN_DATA: "" };
    for (const args of [["--welcome"], ["--welcome", "--no-open"], ["--welcome", ""]]) {
      const r = await run(args, env);
      expect(r.out).toMatch(/^Problem: no invite link was given to --welcome/);
    }
    // --no-open 在前面：链接照样认得
    const r = await run(["--welcome", "--no-open", `${remote}/#k=${K}`], env);
    expect(r.out).toMatch(/^Agent Loop is set up: this computer reports to galaxy group/);
    expect(r.out).not.toContain(K);
  });

  it("接入命令：插件没装上就照实说，什么都不动", async () => {
    const cfg = tmp(), env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: "s", CLAUDE_PLUGIN_DATA: "" };
    const r = await run(["--welcome", `${remote}/#k=${K}`, "--no-open"], env);
    expect(r.out).toMatch(/^Problem: the Agent Loop plugin is not installed/);
    expect(r.out).not.toMatch(/reload-plugins/);
    expect(helloGroups(pluginData(cfg))).toEqual([]);
    expect(() => readFileSync(join(pluginData(cfg), "server.json"))).toThrow();
  });

  it("接入命令：读写不了自己的文件时照实说，不带安装密钥", async () => {
    const cfg = installedCfg(), d = pluginData(cfg);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "identity.json"), `{"secret":"${"ab".repeat(32)}", bad`);
    const r = await run(["--welcome", `${remote}/#k=${K}`, "--no-open"], { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: "s", CLAUDE_PLUGIN_DATA: "" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Problem: setting up Agent Loop failed/);
    expect(r.out).not.toContain("abab");
    expect(r.out).not.toContain(K);
  });

  it("接入命令换了群：旧设置的会话不再发、不把旧链接写回去，说话时提示 /reload-plugins；新开的会话拿着旧值就照常发", async () => {
    const hits: { group?: string; ev: any }[] = [];
    const srv = createServer((req, res) => {
      let b = ""; req.on("data", x => (b += x));
      req.on("end", () => { if (req.url !== "/healthz") hits.push({ group: req.headers["x-group"] as string | undefined, ev: b ? JSON.parse(b) : null }); res.writeHead(204).end(); });
    });
    await new Promise<void>(r => srv.listen(0, "127.0.0.2", r));
    const url = `http://127.0.0.2:${(srv.address() as any).port}`;
    const K2 = "B".repeat(43), A = `${url}/#k=${K}`, B = `${url}/#k=${K2}`;
    const cfg = installedCfg(), d = pluginData(cfg);
    const old = { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: A };
    const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "s" });
    await run([], old, stop);   // 在 A 群里
    expect(hits.map(h => h.group)).toEqual([deriveKeys(K)!.access]);

    const w = await run(["--welcome", B, "--no-open"], { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: "s", CLAUDE_PLUGIN_DATA: "" });
    expect(w.out).toMatch(/^Agent Loop is set up/);
    expect(hits.slice(1).map(h => h.group)).toEqual([deriveKeys(K2)!.access]);   // 同一个服务器：不用另外告诉旧群

    // 跑接入命令的这个会话、别的窗口里的旧会话：还拿着 A
    await run([], old, stop);
    await run([], old, JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", source: "clear" }));
    expect(hits.length).toBe(2);
    expect(JSON.parse(readFileSync(join(d, "server.json"), "utf8")).server_url).toBe(B);
    const say = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "hi" });
    const chk = JSON.parse((await run(["--check"], old, say)).out).systemMessage;
    expect(chk).toMatch(/old server_url .* \/reload-plugins/);
    expect(chk).not.toContain(K);

    // 跑接入命令的会话没 /reload-plugins 就关了：它已经作为 SessionStart 报进了 B，SessionEnd 要发给 B（不然 B 里留一颗两小时的行星）
    const end = JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s", reason: "prompt_input_exit" });
    await run([], old, end);
    expect(hits.length).toBe(3);
    expect(hits[2].group).toBe(deriveKeys(K2)!.access);
    expect(hits[2].ev.ev).toBe("SessionEnd");
    expect(hits[2].ev.sid).toBe(hits[1].ev.sid);
    expect(JSON.parse(readFileSync(join(d, "server.json"), "utf8")).server_url).toBe(B);
    hits.pop();

    // /reload-plugins 以后拿的是 B：照常发
    await run([], { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: B }, stop);
    expect(hits[2].group).toBe(deriveKeys(K2)!.access);
    // 用户又改回 A，新开了一个会话：去掉记号，照常发
    await run([], old, start());
    await run([], old, stop);
    srv.close();
    expect(hits.slice(3).map(h => h.group)).toEqual([deriveKeys(K)!.access, deriveKeys(K)!.access]);
    expect(await run(["--check"], old, start("clear"))).toEqual({ out: "", code: 0 });
  });

  it("旧群在别的服务器上：接入命令告诉它这个星系走了", async () => {
    const paths: string[] = [];
    const mk = async () => {
      const s = createServer((req, res) => { paths.push(`${(s.address() as any).port}${req.url}`); req.resume(); res.writeHead(204).end(); });
      await new Promise<void>(r => s.listen(0, "127.0.0.2", r));
      return { s, url: `http://127.0.0.2:${(s.address() as any).port}`, port: (s.address() as any).port };
    };
    const a = await mk(), b = await mk();
    const cfg = installedCfg(), d = pluginData(cfg);
    await run([], { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: `${a.url}/#k=${K}` }, JSON.stringify({ hook_event_name: "Stop", session_id: "s" }));
    await run(["--welcome", `${b.url}/#k=${"B".repeat(43)}`, "--no-open"], { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: "s", CLAUDE_PLUGIN_DATA: "" });
    a.s.close(); b.s.close();
    expect(paths).toEqual([`${a.port}/v1/events`, `${a.port}/v1/leave`, `${b.port}/v1/events`, `${b.port}/healthz`]);
  });

  const setMtime = (f: string, t: number) => utimesSync(f, t / 1000, t / 1000);
  /** 插件读过 token 数的会话留下的 usage 缓存：文件名是哈希后的编号（这里随便起），内容里记着会话记录的路径 */
  const usageCache = (data: string, name: string, path: unknown, t: number) => {
    mkdirSync(join(data, "usage"), { recursive: true });
    const f = join(data, "usage", `${name}.json`);
    writeFileSync(f, JSON.stringify({ v: 4, path, off: 3 }));
    setMtime(f, t);
    return f;
  };
  /** 假的 Claude Code 配置目录：sessions/ 里的登记（会话编号 → 进程号）、projects/ 里的会话记录（会话编号 → 多久以前动过）；
   *  给了插件数据目录 data 就在它的 usage/ 里给每个会话记录留一份缓存（和记录同时动过） */
  const fakeClaude = (cfg: string, reg: Record<string, number>, transcripts: Record<string, number>, now = Date.now(), data?: string) => {
    mkdirSync(join(cfg, "sessions"), { recursive: true });
    for (const [sid, pid] of Object.entries(reg)) writeFileSync(join(cfg, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: sid, kind: "interactive" }));
    mkdirSync(join(cfg, "projects", "C--work-demo"), { recursive: true });
    for (const [sid, ago] of Object.entries(transcripts)) {
      const f = join(cfg, "projects", "C--work-demo", `${sid}.jsonl`);
      writeFileSync(f, "{}" + String.fromCharCode(10));
      setMtime(f, now - ago);
      if (data) usageCache(data, `h${sid}`, f, now - ago);
    }
  };
  const MIN = 60_000;

  it("替结束了却没送出 SessionEnd 的会话补发：不在登记里、登记的进程没了的才算；刚动过、两小时以前的、自己都不算", async () => {
    const cfg = tmp(), dir = tmp(), now = Date.now();
    const pids: Record<number, boolean> = { 101: true, 102: true, 103: false };
    fakeClaude(cfg, { self: 101, idle: 102, killed: 103 },
      { self: 5 * MIN, idle: 40 * MIN, killed: 10 * MIN, exited: 20 * MIN, fresh: 10_000, old: 3 * 3600_000 }, now, dir);
    const sent: string[] = [];
    const sweep = (t: number, self = "self") => sweepEnded({ dir, cfg, self, now: t, isAlive: p => !!pids[p], end: async sid => { sent.push(sid); } });
    // killed：窗口点 × 关了（登记还在，进程没了）；exited：正常退出（登记删了）但 SessionEnd 没送到
    expect((await sweep(now)).sort()).toEqual(["exited", "killed"]);
    // 一分钟内不再扫；之后再扫不重复发。fresh 刚才动过不到一分钟（可能刚开、还没登记），现在安静了、还是没登记：补发
    expect(await sweep(now + 30_000)).toEqual([]);
    expect(await sweep(now + 2 * MIN)).toEqual(["fresh"]);
    expect(await sweep(now + 4 * MIN)).toEqual([]);
    expect(sent.sort()).toEqual(["exited", "fresh", "killed"]);
    // 补发过的会话又被 --resume 打开、又没留 SessionEnd 就没了：记录又动过，再补一次
    setMtime(join(cfg, "projects", "C--work-demo", "exited.jsonl"), now + 2 * MIN);
    expect(await sweep(now + 6 * MIN)).toEqual(["exited"]);
  });

  it("补发的候选只从 usage 缓存来：缓存两小时没动过、读不懂、记录没了、编号不合法的都不算", () => {
    const cfg = tmp(), dir = tmp(), now = Date.now();
    fakeClaude(cfg, {}, { a: 10 * MIN, b: 20 * MIN, noCache: 10 * MIN }, now);
    const rec = (sid: string) => join(cfg, "projects", "C--work-demo", `${sid}.jsonl`);
    usageCache(dir, "ha", rec("a"), now - 10 * MIN);
    usageCache(dir, "hb", rec("b"), now - 3 * 3600_000);   // 缓存两小时以前就没动过：不看（记录本身是 20 分钟前）
    usageCache(dir, "ha2", rec("a"), now - 5 * MIN);       // 同一个会话两份缓存（换过盐）：只算一次
    usageCache(dir, "gone", rec("gone"), now - 5 * MIN);   // 记录不存在
    usageCache(dir, "nopath", undefined, now - 5 * MIN);
    usageCache(dir, "numpath", 42, now - 5 * MIN);
    usageCache(dir, "notjsonl", join(cfg, "projects", "C--work-demo", "x.txt"), now - 5 * MIN);
    usageCache(dir, "badsid", join(cfg, "projects", "C--work-demo", "a b.jsonl"), now - 5 * MIN);
    writeFileSync(join(cfg, "projects", "C--work-demo", "a b.jsonl"), "");
    setMtime(join(cfg, "projects", "C--work-demo", "a b.jsonl"), now - 10 * MIN);
    writeFileSync(join(dir, "usage", "broken.json"), "{\"path\":");
    writeFileSync(join(dir, "usage", "null.json"), "null");
    writeFileSync(join(dir, "usage", "other.tmp"), JSON.stringify({ path: rec("b") }));
    expect(recentSessions(dir, now)).toEqual([{ sid: "a", mtime: now - 10 * MIN }]);   // noCache：插件没报过，不算
    // 插件自己写的缓存认得出来
    const d2 = tmp(), f = rec("b");
    writeFileSync(f, JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 2 } } }) + String.fromCharCode(10));
    setMtime(f, now - 30 * MIN);
    mkdirSync(join(d2, "usage"));
    expect(usageFromTranscript(f, join(d2, "usage", "x.json"))?.out).toBe(2);
    expect(recentSessions(d2, now)).toEqual([{ sid: "b", mtime: now - 30 * MIN }]);
  });

  it("补发 SessionEnd 很保守：没有登记、登记里没有自己、有登记读不懂，都不扫", async () => {
    const now = Date.now(), isAlive = () => true;
    const quiet = async (setup: (cfg: string, dir: string) => void, self = "self") => {
      const cfg = tmp(), dir = tmp(), sent: string[] = [];
      setup(cfg, dir);
      expect(await sweepEnded({ dir, cfg, self, now, isAlive, end: async sid => { sent.push(sid); } })).toEqual([]);
      expect(sent).toEqual([]);
    };
    // 这个版本的 Claude Code 不登记会话
    await quiet((cfg, dir) => {
      const f = join(cfg, "projects", "p", "x.jsonl");
      mkdirSync(join(cfg, "projects", "p"), { recursive: true }); writeFileSync(f, ""); setMtime(f, now - 10 * MIN);
      usageCache(dir, "hx", f, now - 10 * MIN);
    });
    // 登记了别的会话，没有自己（还没登记上、或者格式变了）
    await quiet((cfg, dir) => fakeClaude(cfg, { other: 7 }, { gone: 10 * MIN }, now, dir));
    // 有一条登记读不懂（正在写）：那个会话可能还开着
    await quiet((cfg, dir) => { fakeClaude(cfg, { self: 7 }, { gone: 10 * MIN }, now, dir); writeFileSync(join(cfg, "sessions", "8.json"), "{\"pid\":8,"); });
    await quiet((cfg, dir) => { fakeClaude(cfg, { self: 7 }, { gone: 10 * MIN }, now, dir); writeFileSync(join(cfg, "sessions", "9.json"), JSON.stringify({ pid: "9", id: "x" })); });
    // 其余的文件（.key、别的）不管
    const cfg = tmp();
    fakeClaude(cfg, { self: 7 }, {}, now);
    writeFileSync(join(cfg, "sessions", "7.abc.key"), "x");
    expect(liveSessions(cfg, () => true)).toEqual(new Set(["self"]));
    expect(liveSessions(cfg, () => false)).toEqual(new Set());
    expect(liveSessions(tmp())).toBeNull();
    expect(recentSessions(tmp(), now)).toEqual([]);
  });

  it("hook：会话开始、服务器收下了，替关掉的会话给现在的群补发 SessionEnd（用这个会话自己的进程当「还活着」）", async () => {
    const hits: { group?: string; ev: any }[] = [];
    let code = 204;
    const srv = createServer((req, res) => {
      let b = ""; req.on("data", x => (b += x));
      req.on("end", () => { hits.push({ group: req.headers["x-group"] as string | undefined, ev: b ? JSON.parse(b) : null }); res.writeHead(code).end(); });
    });
    await new Promise<void>(r => srv.listen(0, "127.0.0.2", r));
    const url = `http://127.0.0.2:${(srv.address() as any).port}`;
    const cfg = tmp(), d = tmp();
    // 自己：登记的是测试进程（活着）；gone：登记的进程早没了
    const dead = await new Promise<number>(r => { const p = spawn(process.execPath, ["-e", ""]); p.on("exit", () => r(p.pid!)); });
    fakeClaude(cfg, { me: process.pid, gone: dead }, { me: 5 * MIN, gone: 10 * MIN }, Date.now(), d);
    const env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: `${url}/#k=${K}` };
    const say = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "me", prompt: "hi" });
    // 服务器没收下：不扫
    code = 503;
    await run([], env, say);
    expect(hits.map(h => h.ev.ev)).toEqual(["UserPromptSubmit"]);
    code = 204;
    await run([], env, say);
    // 工具调用之类的不扫
    await run([], env, JSON.stringify({ hook_event_name: "Stop", session_id: "me" }));
    srv.close();
    expect(hits.map(h => h.ev.ev)).toEqual(["UserPromptSubmit", "UserPromptSubmit", "SessionEnd", "Stop"]);
    const end = hits[2];
    expect(end.group).toBe(deriveKeys(K)!.access);
    expect(RemoteEvent.safeParse(end.ev).success).toBe(true);
    // 和那个会话自己发的 SessionEnd 是同一个（加盐哈希后的）编号
    const { salt } = loadIdentity(d);
    expect(end.ev.sid).toBe(buildEvent({ hook_event_name: "SessionEnd", session_id: "gone" }, { salt, level: 0 })!.sid);
    expect(end.ev.sid).not.toBe(hits[1].ev.sid);
  });

  it("命令正文里的 ${CLAUDE_PLUGIN_DATA} 没被替换：用 hook 的同一个数据目录", async () => {
    const cfg = installedCfg(), d = pluginData(cfg);
    rememberTarget(d, `http://127.0.0.2:1/#k=${K}`);
    const id = galaxyId(loadIdentity(d).secret);
    const env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_PLUGIN_DATA: "" };
    expect((await run(["--galaxy", "${CLAUDE_PLUGIN_DATA}", "", "--no-open"], env)).out).toContain(`#g=${id}&mine`);
    await run(["--leave", "${CLAUDE_PLUGIN_DATA}", "--no-open"], env);
    expect(leftGroups(d)).toEqual([deriveKeys(K)!.group]);
  });

  it("连不上本机的服务：记下来，下次会话开始时提示；SessionEnd 的结果不记", async () => {
    const d = tmp(), env = { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: "http://127.0.0.1:1" };
    expect(await run([], env, JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s", reason: "other" }))).toEqual({ out: "", code: 0 });
    expect(lastStatus(d)).toBeNull();
    expect(await run([], env, JSON.stringify({ hook_event_name: "Stop", session_id: "s" }))).toEqual({ out: "", code: 0 });
    expect(lastStatus(d)).toEqual({ url: "http://127.0.0.1:1", status: "unreachable" });
    expect(JSON.parse((await run(["--check"], env, start())).out).systemMessage).toMatch(/npx agent-loop/);
  });

  it("服务器拒收（403）：记下状态码", async () => {
    const srv = createServer((req, res) => { req.resume(); res.writeHead(403).end(); });
    await new Promise<void>(r => srv.listen(0, "127.0.0.2", r));
    const url = `http://127.0.0.2:${(srv.address() as any).port}`;
    const d = tmp();
    await run([], { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: `${url}/#k=${K}` }, JSON.stringify({ hook_event_name: "Stop", session_id: "s" }));
    srv.close();
    expect(lastStatus(d)).toEqual({ url, status: 403 });
  });

  it("/galaxy：设错了也照实说出问题（hook 没发也记下了地址），不带密钥", async () => {
    const d = tmp();
    await run([], { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: remote }, JSON.stringify({ hook_event_name: "Stop", session_id: "s" }));
    const g = await run(["--galaxy", d, "", "--no-open"], {});
    expect(g.out).toMatch(/^http:\/\/10\.0\.0\.9:4317\/#g=[0-9a-f]{32}&mine\nProblem: .*no group key/);
  });

  it("地址漏了 http://：什么都不发，/galaxy 照实说出问题", async () => {
    let hits = 0;
    const srv = createServer((req, res) => { hits++; req.resume(); res.writeHead(204).end(); });
    await new Promise<void>(r => srv.listen(0, "127.0.0.2", r));
    const d = tmp(), bare = `127.0.0.2:${(srv.address() as any).port}`;
    await run([], { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: `${bare}/#k=${K}` }, JSON.stringify({ hook_event_name: "Stop", session_id: "s" }));
    srv.close();
    expect(hits).toBe(0);
    expect((await run(["--galaxy", d, "", "--no-open"], {})).out).toMatch(/Problem: .*must start with http/);
  });

  it("改设置以前开的旧会话（拿着不带密钥的旧值）不会冲掉已经记下的好地址", async () => {
    const d = tmp(), good = `${remote}/#k=${K}`;
    rememberTarget(d, good);
    await run([], { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: remote }, JSON.stringify({ hook_event_name: "Stop", session_id: "s" }));
    expect(JSON.parse(readFileSync(join(d, "server.json"), "utf8")).server_url).toBe(good);
  });

  it("退出过的星系群：记下来读得回来，坏文件当没有；会话开始时说明，不带密钥", () => {
    const d = tmp(), g = deriveKeys(K)!.group;
    expect(leftGroups(d)).toEqual([]);
    markLeft(d, g, true); markLeft(d, g, true);
    expect(leftGroups(d)).toEqual([g]);
    const p = reportProblem(resolveTarget(d, `${remote}/#k=${K}`), null)!;
    expect(p).toMatch(/you left galaxy group .*\/agent-loop:rejoin/);
    expect(p).toContain(fingerprint(g));
    expect(p).not.toContain(K);
    expect(reportProblem(resolveTarget(d, ""), null)).toBeNull();   // 本机地址不受影响
    markLeft(d, g, false);
    expect(leftGroups(d)).toEqual([]);
    writeFileSync(join(d, "left.json"), "{bad");
    expect(leftGroups(d)).toEqual([]);
  });

  it("/agent-loop:leave：告诉服务器、记下来，之后所有会话都不发；/agent-loop:rejoin 以后照常", async () => {
    const hits: { path: string; auth?: string; group?: string }[] = [];
    const srv = createServer((req, res) => {
      hits.push({ path: req.url || "", auth: req.headers.authorization, group: req.headers["x-group"] as string | undefined });
      req.resume(); res.writeHead(204).end();
    });
    await new Promise<void>(r => srv.listen(0, "127.0.0.2", r));
    const url = `http://127.0.0.2:${(srv.address() as any).port}`, link = `${url}/#k=${K}`;
    const d = tmp(), env = { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: link };
    const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "s" });
    await run([], env, stop);
    expect(hits.map(h => h.path)).toEqual(["/v1/events"]);

    // 命令里拿不到插件的设置：地址从 hook 记下的 server.json 读
    const out = (await run(["--leave", d, "--no-open"], {})).out;
    expect(out).toMatch(/^Left galaxy group .* removed from the group on the server/);
    expect(out).toContain(fingerprint(deriveKeys(K)!.group));
    expect(out).not.toContain(K);
    expect(hits[1]).toEqual({ path: "/v1/leave", auth: `Bearer ${loadIdentity(d).secret}`, group: deriveKeys(K)!.access });
    expect(leftGroups(d)).toEqual([deriveKeys(K)!.group]);

    // 设置里还是那条邀请链接（比如别的窗口里的旧会话）：什么都不发，会话开始时说明
    await run([], env, stop);
    await run([], env, JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s", reason: "other" }));
    expect(hits.length).toBe(2);
    expect(JSON.parse((await run(["--check"], env, start())).out).systemMessage).toMatch(/you left galaxy group/);
    expect((await run(["--galaxy", d, "", "--no-open"], {})).out).toMatch(/^No galaxy address: you left galaxy group/);
    expect((await run(["--leave", d, "--no-open"], {})).out).toMatch(/^Left galaxy group/);   // 再退一次也没事（服务器连得上时补一刀）

    expect((await run(["--rejoin", d], {})).out).toMatch(/^Rejoined galaxy group/);
    expect((await run(["--rejoin", d], {})).out).toMatch(/^Already in galaxy group/);
    await run([], env, stop);
    srv.close();
    expect(hits.map(h => h.path)).toEqual(["/v1/events", "/v1/leave", "/v1/leave", "/v1/events"]);
    expect(await run(["--check"], env, start())).toEqual({ out: "", code: 0 });
  });

  it("/galaxy：退出过这个群时不开浏览器、不给 #galaxy=…&mine，说清楚退出了和两条出路，不带密钥", async () => {
    const d = tmp(), link = `${remote}/#k=${K}`, group = deriveKeys(K)!.group;
    const opened: string[] = [];
    const open = (u: string) => { opened.push(u); return true; };
    markLeft(d, group, true);
    const out = await galaxyCommand(d, link, open);
    expect(opened).toEqual([]);
    expect(out).not.toMatch(/#(galaxy|g)=/);
    expect(out).not.toContain("&mine");
    expect(out).not.toContain(K);
    expect(out).toMatch(/^No galaxy address: you left galaxy group/);
    expect(out).toContain(fingerprint(group));
    expect(out).toContain("/agent-loop:rejoin");
    expect(out).toContain("/plugin configure agent-loop@agent-loop");
    expect(out).toContain("http://127.0.0.1:4317");
    // 命令行里也一样：地址从 server.json 读，不带 --no-open 也不打开
    rememberTarget(d, link);
    const cli = (await run(["--galaxy", d], {})).out;
    expect(cli).toMatch(/^No galaxy address:/);
    expect(cli).not.toMatch(/#(galaxy|g)=/);
    // rejoin 以后照常：开浏览器（带密钥），输出里的地址不带密钥
    markLeft(d, group, false);
    const back = await galaxyCommand(d, link, open);
    expect(opened).toEqual([`${remote}/#k=${K}&g=${galaxyId(loadIdentity(d).secret)}&mine`]);
    expect(back).toMatch(/#g=[0-9a-f]{32}&mine\n\(opened in your browser/);
    expect(back).not.toContain(K);
  });

  it("resolveTarget：每种不能报的情况；只读；moved 只有 hook 算、新开的会话不算", () => {
    const d = tmp(), g = deriveKeys(K)!.group, link = `${remote}/#k=${K}`, home = `http://127.0.0.1:4317/#k=${K}`;
    const say = { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "hi" };
    const startup = { hook_event_name: "SessionStart", session_id: "s", source: "startup" };
    expect(resolveTarget(d, link)).toEqual({ url: remote, k: K, keys: deriveKeys(K), local: false, group: g, block: null });
    expect(resolveTarget(d, parseTarget(link))).toEqual(resolveTarget(d, link));
    expect(resolveTarget(d, "")).toMatchObject({ url: "http://127.0.0.1:4317", local: true, group: null, block: null });
    expect(resolveTarget(d, "http://127.0.0.1:4317/#k=abc")).toMatchObject({ local: true, keys: null, block: null });   // 本机：不完整的 #k= 不管
    expect(resolveTarget(d, home)).toMatchObject({ local: true, group: g, block: null });
    expect(resolveTarget(d, `10.0.0.9:4317/#k=${K}`).block).toBe("scheme");
    expect(resolveTarget(d, remote).block).toBe("nokey");
    expect(resolveTarget(d, `${remote}/#k=abc`)).toMatchObject({ keys: null, group: null, block: "badkey" });
    markLeft(d, g, true);
    expect(resolveTarget(d, link).block).toBe("left");
    expect(resolveTarget(d, home).block).toBe("left");   // D2：本机地址带着 #k= 也查 left.json
    expect(resolveTarget(d, "").block).toBeNull();
    markMoved(d, `g:${g}`, true);
    markMoved(d, `u:${remote}`, true);
    expect(resolveTarget(d, link, say).block).toBe("moved");      // 换走了的旧设置比退出过先
    expect(resolveTarget(d, link, startup).block).toBe("left");   // 新开的会话不算 moved
    expect(resolveTarget(d, link).block).toBe("left");            // 命令里没有 hook：不算 moved
    expect(resolveTarget(d, remote, say).block).toBe("moved");    // 没有密钥的按地址记
    expect(resolveTarget(d, remote, startup).block).toBe("nokey");
    // 只读：不写文件（新开的会话去掉 moved 记号是 hook 主路径自己做的）
    const before = JSON.stringify([readFileSync(join(d, "left.json"), "utf8"), readFileSync(join(d, "moved.json"), "utf8")]);
    resolveTarget(d, link, startup); resolveTarget(d, remote, startup);
    expect(JSON.stringify([readFileSync(join(d, "left.json"), "utf8"), readFileSync(join(d, "moved.json"), "utf8")])).toBe(before);
    // 每种都有一句话，不带密钥
    for (const [v, hook, b] of [[link, say, "moved"], [`10.0.0.9:4317/#k=${K}`, undefined, "scheme"], [remote, undefined, "nokey"],
      [`${remote}/#k=abc`, undefined, "badkey"], [link, undefined, "left"]] as const) {
      const t = resolveTarget(d, v, hook);
      expect(t.block).toBe(b);
      const msg = blockMessage(b, t);
      expect(msg.length).toBeGreaterThan(20);
      expect(msg).not.toContain(K);
      expect(msg).not.toContain("abc");
      expect(reportProblem(t, null)).toContain(msg);
    }
  });

  it("本机地址 + #k= + 退出过（D2）：hook 不发，--check、/agent-loop:galaxy、/agent-loop:status 说同一句；rejoin 回得去", async () => {
    let hits = 0;
    const srv = createServer((req, res) => { hits++; req.resume(); res.writeHead(204).end(); });
    await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
    const link = `http://127.0.0.1:${(srv.address() as any).port}/#k=${K}`, group = deriveKeys(K)!.group;
    const d = tmp(), env = { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_SERVER_URL: link };
    const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "s" });
    await run([], env, stop);
    expect(hits).toBe(1);
    markLeft(d, group, true);
    await run([], env, stop);
    await run([], env, JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s", reason: "other" }));
    expect(hits).toBe(1);
    const msg = blockMessage("left", resolveTarget(d, link));
    expect(msg).toContain(fingerprint(group));
    expect(msg).toContain("To report to this computer instead, set server_url back to http://127.0.0.1:4317 with /plugin configure agent-loop@agent-loop.");
    expect(JSON.parse((await run(["--check"], env, start())).out).systemMessage).toBe(`Agent Loop is not reporting: ${msg}`);
    const galaxy = (await run(["--galaxy", d, "", "--no-open"], {})).out;
    expect(galaxy.trim()).toBe(`No galaxy address: ${msg}`);
    const status = (await run(["--status", d], {})).out;
    expect(status).toContain("State: not reporting (see Problem)");
    expect(status).toContain(`Problem: Agent Loop is not reporting: ${msg}`);
    for (const out of [galaxy, status]) expect(out).not.toContain(K);
    // 本机地址也能 rejoin（不然上面叫人跑的 /agent-loop:rejoin 回不去）
    expect((await run(["--rejoin", d], {})).out).toMatch(/^Rejoined galaxy group/);
    await run([], env, stop);
    srv.close();
    expect(hits).toBe(2);
    expect(await run(["--check"], env, start())).toEqual({ out: "", code: 0 });
    // 没退出过的本机地址照旧不算在群里
    expect((await run(["--leave", d, "--no-open"], {})).out).toMatch(/^Not in a galaxy group: server_url is http:\/\/127\.0\.0\.1:\d+\. Nothing to leave\./);
    expect(leftGroups(d)).toEqual([]);
  });

  it("/agent-loop:leave：连不上服务器也记下来，照实说；不在星系群里就说没什么可退的", async () => {
    const d = tmp();
    rememberTarget(d, `http://127.0.0.2:1/#k=${K}`);
    const out = (await run(["--leave", d, "--no-open"], {})).out;
    expect(out).toMatch(/could not be told \(unreachable\)/);
    expect(leftGroups(d)).toEqual([deriveKeys(K)!.group]);
    expect(out).toContain("To report to this computer instead, set server_url back to http://127.0.0.1:4317 with /plugin configure agent-loop@agent-loop.");
    const d2 = tmp();
    rememberTarget(d2, "http://127.0.0.1:4317");
    expect((await run(["--leave", d2, "--no-open"], {})).out).toMatch(/^Not in a galaxy group/);
    expect(leftGroups(d2)).toEqual([]);
    const d3 = tmp();
    rememberTarget(d3, `${remote}/#k=abc`);
    const bad = (await run(["--leave", d3, "--no-open"], {})).out;
    expect(bad).toMatch(/^Not in a galaxy group.*incomplete/);
    expect(bad).not.toContain("abc");
  });

  /** 假的服务器：/healthz 按 health 答（字符串原样给，模拟代理、登录页），事件按 events 答（默认 204）。记下收到的请求 */
  const fakeServer = async (health: unknown, events = 204) => {
    const hits: { path: string; group?: string; ev?: any }[] = [];
    const srv = createServer((req, res) => {
      let b = ""; req.on("data", x => (b += x));
      req.on("end", () => {
        hits.push({ path: req.url || "", group: req.headers["x-group"] as string | undefined, ev: b ? JSON.parse(b) : undefined });
        if (req.url === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end(typeof health === "string" ? health : JSON.stringify(health));
        res.writeHead(req.url === "/v1/events" ? events : 204).end();
      });
    });
    await new Promise<void>(r => srv.listen(0, "127.0.0.2", r));
    return { hits, url: `http://127.0.0.2:${(srv.address() as any).port}`, close: () => srv.close() };
  };
  it("/agent-loop:leave：服务器够新时在浏览器里打开 #left=<指纹>，页面清掉这个群；网址里没有密钥", async () => {
    const group = deriveKeys(K)!.group;
    /** 假的服务器：/healthz 按 health 答，/v1/leave 按 leaveStatus 答。退出一次，记下打开的网址和收到的请求 */
    const leave = async (health: unknown, leaveStatus = 204) => {
      const hits: string[] = [];
      const srv = createServer((req, res) => {
        hits.push(req.url || ""); req.resume();
        if (req.url === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end(typeof health === "string" ? health : JSON.stringify(health));
        res.writeHead(leaveStatus).end();
      });
      await new Promise<void>(r => srv.listen(0, "127.0.0.2", r));
      const url = `http://127.0.0.2:${(srv.address() as any).port}`, opened: string[] = [];
      const out = await leaveOrRejoin("leave", tmp(), `${url}/#k=${K}`, u => { opened.push(u); return true; });
      srv.close();
      return { out, opened, url, hits };
    };
    const ok = await leave({ ok: true, local: false, open: true, version: PLUGIN_VERSION });
    expect(ok.opened).toEqual([`${ok.url}/#left=${group.slice(0, 16)}`]);
    expect(ok.hits).toEqual(["/v1/leave", "/healthz"]);
    expect(ok.out).toMatch(/Opened the group's page in your browser/);
    expect(ok.out).toContain('"Clear cache"');
    expect(ok.out).not.toContain(K);
    expect(ok.opened[0]).not.toContain(K);
    // 服务器没收下退出（旧服务器没有 /v1/leave）：页面上照实说还会留一阵
    const kept = await leave({ ok: true, local: false, open: true, version: PLUGIN_VERSION }, 404);
    expect(kept.opened).toEqual([`${kept.url}/#left=${group.slice(0, 16)}&kept`]);
    // 页面不认 #left= 的旧服务器（不答版本、版本旧）：不打开（打开了反而接着显示这个群），说清楚去页面上「清除缓存」
    for (const h of [{ ok: true, local: false, open: true }, { ok: true, local: false, open: true, version: "0.2.11" }, "<html>"]) {
      const old = await leave(h);
      expect(old.opened).toEqual([]);
      expect(old.out).toMatch(/cannot clear the group from a browser by itself.*"Clear cache"/);
    }
    // 连不上：页面也打不开，不开
    const d = tmp(), opened: string[] = [];
    const gone = await leaveOrRejoin("leave", d, `http://127.0.0.2:1/#k=${K}`, u => { opened.push(u); return true; });
    expect(opened).toEqual([]);
    expect(gone).toMatch(/could not be told \(unreachable\)/);
  });

  /** 建群用的选项：存设置、开浏览器都换成记下来，不碰真的 Claude Code 设置和浏览器 */
  const createOpts = (cfg: string, saveError: string | null = null) => {
    const saved: string[] = [], opened: string[] = [];
    return {
      saved, opened,
      o: { cfg, dir: pluginData(cfg), sid: "0f8a1c2e-1111-2222-3333-444455556666", cwd: "C:\\work\\demo",
        open: (u: string) => { opened.push(u); return true; }, save: async (v: string) => { saved.push(v); return saveError; } },
    };
  };
  const keyOf = (link: string) => parseTarget(link).k!;
  const OPEN = { ok: true, local: false, open: true, version: PLUGIN_VERSION };

  it("/agent-loop:create：本机生成密钥、存进 server_url、把这个会话报到新群、浏览器里打开邀请（&created）；输出里没有密钥", async () => {
    const s = await fakeServer(OPEN);
    const cfg = installedCfg(), { saved, opened, o } = createOpts(cfg);
    rememberTarget(o.dir, `${s.url}/#k=${K}`);   // 现在在别的群里：不给地址就建在同一个服务器上
    const out = await createGroup("", o);
    s.close();
    expect(saved.length).toBe(1);
    const k2 = keyOf(saved[0]), g2 = deriveKeys(k2)!;
    expect(saved[0]).toBe(`${s.url}/#k=${k2}`);
    expect(k2).not.toBe(K);
    // 输出进对话：新旧两个密钥都不能有
    expect(out).not.toContain(k2);
    expect(out).not.toContain(K);
    expect(out).toMatch(/^Agent Loop created a new galaxy group /);
    expect(out).toContain(fingerprint(g2.group));
    expect(out).toContain(`${s.url}/#galaxy=${galaxyId(loadIdentity(o.dir).secret)}&mine`);
    expect(out).toMatch(/invite link .* in the panel that opened in the browser/);
    expect(out).toMatch(/\/reload-plugins/);
    // 浏览器拿到的才带密钥，带着 &created
    expect(opened).toEqual([`${s.url}/#k=${k2}&galaxy=${galaxyId(loadIdentity(o.dir).secret)}&mine&created`]);
    // 先问收不收新群，再把这个会话报到新群（用新群的口令）
    expect(s.hits.map(h => h.path)).toEqual(["/healthz", "/v1/events"]);
    expect(s.hits[1].group).toBe(g2.access);
    expect(s.hits[1].ev.ev).toBe("SessionStart");
    // 和接入命令一样的记号：旧群的旧会话别再发，/galaxy 用新地址，hook 不再讲一遍说明
    expect(movedFrom(o.dir)).toEqual([`g:${deriveKeys(K)!.group}`]);
    expect(JSON.parse(readFileSync(join(o.dir, "server.json"), "utf8")).server_url).toBe(saved[0]);
    expect(helloGroups(o.dir)).toEqual([g2.group]);
    // 每次建的都是新的
    const again = createOpts(cfg);
    const s2 = await fakeServer(OPEN);
    await createGroup(s2.url, again.o);
    s2.close();
    expect(keyOf(again.saved[0])).not.toBe(k2);
    expect(again.saved[0].startsWith(`${s2.url}/#k=`)).toBe(true);
  });

  it("/agent-loop:create：服务器不收新群、连不上、是本机的服务、存不进设置：照实说，什么都不改", async () => {
    const unchanged = async (given: string, health: unknown, saveError: string | null, why: RegExp, remembered = "") => {
      const s = await fakeServer(health);
      const cfg = installedCfg(), { saved, opened, o } = createOpts(cfg, saveError);
      if (remembered) rememberTarget(o.dir, remembered);
      const out = await createGroup(given.replace("<srv>", s.url), o);
      s.close();
      expect(out).toMatch(/^Problem: no galaxy group was created: /);
      expect(out).toMatch(why);
      expect(out).toMatch(/Nothing was changed/);
      expect(opened).toEqual([]);
      expect(s.hits.filter(h => h.path === "/v1/events")).toEqual([]);
      expect(movedFrom(o.dir)).toEqual([]);
      for (const v of saved) expect(out).not.toContain(keyOf(v));
      if (remembered) expect(JSON.parse(readFileSync(join(o.dir, "server.json"), "utf8")).server_url).toBe(remembered);
      return saved;
    };
    // 白名单的服务器：要找管理员
    expect(await unchanged("<srv>", { ...OPEN, open: false }, null, /only accepts galaxy groups its admin has registered/)).toEqual([]);
    // 0.2.10 以前的服务器（不答 version）：页面不认 &created，邀请链接没处显示
    expect(await unchanged("<srv>", { ok: true, local: false }, null, /runs an older Agent Loop server \(before 0\.2\.11\).*update the server to 0\.2\.11/)).toEqual([]);
    expect(await unchanged("<srv>", { ...OPEN, version: "0.2.10" }, null, /older Agent Loop server \(0\.2\.10\)/)).toEqual([]);
    // 答了但不是 JSON（代理、登录页）：不是「连不上」
    expect(await unchanged("<srv>", "<html>login</html>", null, /did not answer like an Agent Loop server/)).toEqual([]);
    // 本机的服务（npx agent-loop）：没有群
    expect(await unchanged("<srv>", { ok: true, local: true }, null, /single computer/)).toEqual([]);
    // 不像 Agent Loop 的服务器
    expect(await unchanged("<srv>", { hello: 1 }, null, /did not answer like an Agent Loop server/)).toEqual([]);
    // 连不上
    expect(await unchanged("http://127.0.0.2:1", {}, null, /could not reach http:\/\/127\.0\.0\.2:1/)).toEqual([]);
    // 现在报给本机、又没说建在哪：要给地址
    expect(await unchanged("", {}, null, /reports to a server on this computer .*Usage: \/agent-loop:create https:\/\//)).toEqual([]);
    expect(await unchanged("http://localhost:4317", {}, null, /is this computer/)).toEqual([]);
    expect(await unchanged("loop.example.com", {}, null, /must start with https:\/\/ or http:\/\//)).toEqual([]);
  });

  it("/agent-loop:create：服务器不收新群的第一次上报（群数满了、建群太多）：不动 server_url；存不进设置：把星系从新群里撤出来", async () => {
    for (const [code, why] of [[503, /is full \(HTTP 503\)/], [429, /limiting new galaxy groups .*HTTP 429/], [403, /registered \(HTTP 403\)/]] as const) {
      const s = await fakeServer(OPEN, code);
      const cfg = installedCfg(), { saved, opened, o } = createOpts(cfg);
      const before = `${s.url}/#k=${K}`;
      rememberTarget(o.dir, before);
      const out = await createGroup("", o);
      s.close();
      expect(out).toMatch(/^Problem: no galaxy group was created: /);
      expect(out).toMatch(why);
      expect(saved).toEqual([]);   // 没去动 server_url
      expect(opened).toEqual([]);
      expect(movedFrom(o.dir)).toEqual([]);
      expect(JSON.parse(readFileSync(join(o.dir, "server.json"), "utf8")).server_url).toBe(before);
      expect(s.hits.map(h => h.path)).toEqual(["/healthz", "/v1/events"]);
      expect(lastStatus(o.dir)).toBeNull();   // 试探的结果不记：不能让会话开始时的检查拿它说现在的群
    }
    // 存不进设置：新群已经收下了这个会话，撤出来；旧的地址原样留着
    const s = await fakeServer(OPEN);
    const cfg = installedCfg(), { saved, opened, o } = createOpts(cfg, "could not find the claude command on PATH");
    const before = `http://127.0.0.2:9/#k=${K}`;
    rememberTarget(o.dir, before);
    const out = await createGroup(s.url, o);
    s.close();
    expect(out).toMatch(/^Problem: no galaxy group was created: .*could not be saved .*could not find the claude command/);
    expect(saved.length).toBe(1);
    expect(out).not.toContain(keyOf(saved[0]));
    expect(opened).toEqual([]);
    expect(s.hits.map(h => h.path)).toEqual(["/healthz", "/v1/events", "/v1/leave"]);
    expect(s.hits[2].group).toBe(deriveKeys(keyOf(saved[0]))!.access);
    expect(movedFrom(o.dir)).toEqual([]);
    expect(JSON.parse(readFileSync(join(o.dir, "server.json"), "utf8")).server_url).toBe(before);
  });

  it("/agent-loop:create：插件没装上就不建；命令正文里的 $ARGUMENTS 没被替换当作没给地址", async () => {
    const s = await fakeServer({ ok: true, local: false, open: true });
    const cfg = tmp(), { saved, o } = createOpts(cfg);
    const out = await createGroup(s.url, o);
    s.close();
    expect(out).toMatch(/^Problem: no galaxy group was created: the Agent Loop plugin is not installed/);
    expect(saved).toEqual([]);
    // 命令行：现在报给本机，$ARGUMENTS 原样传进来，不当成地址（在存设置之前就停下，不会去调真的 claude）
    const cfg2 = installedCfg(), d = pluginData(cfg2);
    rememberTarget(d, "http://127.0.0.1:4317");
    const r = await run(["--create", d, "$ARGUMENTS", "--no-open"], { CLAUDE_CONFIG_DIR: cfg2, CLAUDE_PLUGIN_DATA: "" });
    expect(r.out).toMatch(/^Problem: no galaxy group was created: this computer reports to a server on this computer/);
    // 命令文件把 "$ARGUMENTS" 整个当一个参数：地址后面跟着 --no-open 也认得出地址
    const r2 = await run(["--create", d, "http://localhost:4317 --no-open"], { CLAUDE_CONFIG_DIR: cfg2, CLAUDE_PLUGIN_DATA: "" });
    expect(r2.out).toMatch(/^Problem: no galaxy group was created: http:\/\/localhost:4317 is this computer/);
  });

  it("/galaxy：服务器答了够新的版本才给 #galaxy=，0.2.10 以前的服务器（不答版本）给它的页面认得的 #g=", async () => {
    const d = tmp(), id = galaxyId(loadIdentity(d).secret);
    for (const [health, key] of [[OPEN, "galaxy"], [{ ok: true, local: false }, "g"], [{ ...OPEN, version: "0.2.10" }, "g"]] as const) {
      const s = await fakeServer(health), opened: string[] = [];
      const out = await galaxyCommand(d, `${s.url}/#k=${K}`, u => { opened.push(u); return true; });
      s.close();
      expect(opened).toEqual([`${s.url}/#k=${K}&${key}=${id}&mine`]);
      expect(out.startsWith(`${s.url}/#${key}=${id}&mine\n`)).toBe(true);
      expect(out).not.toContain(K);
    }
  });

  it("/agent-loop:status：报给哪里、在不在群里、上次发得怎么样、名字、分享多少、插件版本；不带密钥", async () => {
    const cfg = installedCfg("0.1.0"), d = pluginData(cfg), link = `${remote}/#k=${K}`, group = deriveKeys(K)!.group;
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ pluginConfigs: { "agent-loop@agent-loop": { options: { name: "小王", share: "anonymous" } } } }));
    rememberTarget(d, link);
    recordStatus(d, remote, 204);
    const ok = statusCommand(d, link, cfg);
    expect(ok).not.toContain(K);
    expect(ok).toContain(`Reports to: galaxy group ${fingerprint(group)} on ${remote}`);
    expect(ok).toContain("State: reporting");
    expect(ok).toContain("Last report: accepted");
    expect(ok).toContain(`Galaxy: ${galaxyId(loadIdentity(d).secret)}, named "小王"`);
    expect(ok).toContain("Sharing: anonymous (anonymous for this server)");
    expect(ok).toMatch(/Plugin: .*installed: 0\.1\.0; run `claude plugin update agent-loop@agent-loop`/);
    expect(ok).not.toMatch(/Problem:/);
    // 服务器满了、限流：reportProblem 不管，可也不能说「在报」
    recordStatus(d, remote, 503);
    const full = statusCommand(d, link, cfg);
    expect(full).toMatch(/State: not reporting right now: the last report did not get through/);
    expect(full).toContain("Last report: refused (HTTP 503)");
    // 换过群以后还有旧设置的会话在跑：提醒 /reload-plugins；半小时以前的不提
    recordStatus(d, remote, 204);
    noteStale(d, 1_000_000);
    expect(statusCommand(d, link, cfg, 1_000_000 + 5 * 60_000)).toMatch(/State: reporting\nOld sessions: 5 min ago .*\/reload-plugins/);
    expect(statusCommand(d, link, cfg, 1_000_000 + 31 * 60_000)).not.toMatch(/Old sessions/);
    // 被拒过
    recordStatus(d, remote, 403);
    expect(statusCommand(d, link, cfg)).toMatch(/State: not reporting[\s\S]*Last report: refused \(HTTP 403\)[\s\S]*Problem: .*refused/);
    // 退出过：State 说不在报，Problem 说清楚（和 hook 会话开始时的提示是同一句），只说一遍；最近有旧设置的会话也不提
    markLeft(d, group, true);
    noteStale(d);
    const left = statusCommand(d, link, cfg);
    expect(left).toContain("State: not reporting (see Problem)");
    expect(left).toContain(`Problem: Agent Loop is not reporting: ${blockMessage("left", resolveTarget(d, link))}`);
    expect(left).toMatch(/Problem: .*you left galaxy group .*\/agent-loop:leave.*\/agent-loop:rejoin/);
    expect(left.match(/you left/g)).toHaveLength(1);
    expect(left).not.toMatch(/Old sessions/);
    expect(left).not.toContain(K);
    // 本机、没发过、默认设置
    const cfg2 = installedCfg(), d2 = pluginData(cfg2);
    const here = statusCommand(d2, "", cfg2);
    expect(here).toContain("Reports to: a server on this computer (http://127.0.0.1:4317)");
    expect(here).toContain("Last report: nothing sent to this server yet");
    expect(here).toContain("named with an auto-generated catalog number");
    expect(here).toContain("Sharing: auto (full for this server)");
    expect(here).toContain(`Plugin: ${PLUGIN_VERSION}\n`.trim());
    // 命令行：地址从 server.json 读
    const r = await run(["--status", d], {});
    expect(r.out).toMatch(/^Reports to: galaxy group /);
    expect(r.out).not.toContain(K);
  });
});
