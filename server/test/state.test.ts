// 状态机的验收测试：从 Python 版 tests/test_state.py 移植，凡是不涉及文字、会话记录、进程登记的用例都在这里。
// 原来断言主句文字的地方，改成断言状态、阶段、等待的种类、支线这些不含文字的东西。
import { describe, expect, it } from "vitest";
import { Harness } from "./helpers.ts";

describe("一轮的完整过程（TestLoop）", () => {
  it("full_round", () => {
    const h = new Harness();
    h.ev("SessionStart", { source: "startup" });
    expect(h.view()).toMatchObject({ status: "idle", round: 0 });
    h.ev("UserPromptSubmit", { prompt: "p1", task_note: false });
    expect(h.view()).toMatchObject({ status: "working", phase: "think" });
    h.advance(3000);
    h.ev("PreToolUse", { kind: "shell", tool: "t1" });
    expect(h.view()).toMatchObject({ phase: "act", running: 1 });
    h.advance(2000);
    h.ev("PostToolUse", { kind: "shell", tool: "t1" });
    h.ev("PostToolBatch");
    let v = h.view()!;
    expect([v.laps, v.phase, v.ticks.length]).toEqual([1, "think", 1]);
    expect(v.ticks[0].ms).toBe(5000);
    h.advance(1000);
    h.ev("Stop", { bg: 0 });
    v = h.view()!;
    expect([v.status, v.laps]).toEqual(["done", 2]);
    expect(v.steps.map(x => [x.kind, x.lap, x.round, x.end != null])).toEqual([["shell", 1, 1, true]]);
  });

  it("parallel_and_tool_error", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    for (const i of [0, 1, 2]) h.ev("PreToolUse", { kind: "read", tool: `t${i}` });
    expect(h.view()!.running).toBe(3);
    h.ev("PostToolUseFailure", { kind: "read", tool: "t1" });
    h.ev("PostToolUse", { kind: "read", tool: "t0" });
    h.ev("PostToolUse", { kind: "read", tool: "t2" });
    h.ev("PostToolBatch");
    const v = h.view()!;
    expect(v.ticks[0].err).toBe(true);
    expect(v.status).toBe("working");   // 工具报错不改变会话状态
    expect(v.steps.find(x => x.id === "t1")!.err).toBe(true);
  });

  it("permission_then_allowed", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "shell", tool: "t1" });
    h.ev("PreToolUse", { kind: "read", tool: "t2" });
    h.ev("PermissionRequest", { kind: "shell" });   // 没有 tool_use_id：按类别配对
    expect(h.view()).toMatchObject({ status: "waiting", wait_kind: "permission" });
    expect(h.g.sessions.get("s1")!.waitBranch).toBe("term");
    h.ev("PostToolUse", { kind: "read", tool: "t2" });   // 并行的另一个工具结束，不应该退出等待
    expect(h.view()!.status).toBe("waiting");
    h.ev("Notification", { ntype: "permission_prompt" });
    expect(h.view()!.status).toBe("waiting");
    h.ev("PostToolUse", { kind: "shell", tool: "t1" });
    expect(h.view()!.status).toBe("working");
    h.ev("PostToolBatch");
    expect(h.view()!.ticks[0].waited).toBe(true);
  });

  it("unrelated_subagent_stop_keeps_waiting", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "agent", tool: "t1", agent_type: "Explore", agent_type_h: "hExplore" });
    h.ev("SubagentStart", { agent: "a1", agent_type: "Explore", agent_type_h: "hExplore" });
    h.ev("PreToolUse", { kind: "shell", tool: "t2" });
    h.ev("PermissionRequest", { kind: "shell" });
    expect(h.view()!.status).toBe("waiting");
    h.ev("SubagentStop", { agent: "a1" });   // 别的子 agent 跑完，授权框还开着
    expect(h.view()!.status).toBe("waiting");
    h.ev("PostToolUse", { kind: "shell", tool: "t2" });
    expect(h.view()!.status).toBe("working");
  });

  it("waiting_subagent_stop_exits_wait", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    for (const aid of ["a1", "a2"]) h.ev("SubagentStart", { agent: aid, agent_type: "custom", agent_type_h: "hg" });
    h.ev("PermissionRequest", { kind: "shell", agent: "a1" });
    h.ev("SubagentStop", { agent: "a2" });
    expect(h.view()).toMatchObject({ status: "waiting", wait_sub: true });
    h.ev("SubagentStop", { agent: "a1" });   // 在等的那个子 agent 自己结束了
    expect(h.view()!.status).toBe("working");
  });

  it("approved_agent_tool_exits_wait_on_subagent_start", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "agent", tool: "t1", agent_type_h: "hgp" });
    h.ev("PermissionRequest", { kind: "agent", tool: "t1" });
    expect(h.view()!.status).toBe("waiting");
    h.ev("SubagentStart", { agent: "a1", agent_type: "Explore", agent_type_h: "hExplore" });   // 启动了 = 你批准了
    expect(h.view()!.status).toBe("working");
  });

  it("manual_reject_exits_wait_on_any_event", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "edit", tool: "t1" });
    h.ev("PermissionRequest", { kind: "edit" });
    h.ev("Stop", { bg: 0 });
    expect(h.view()!.status).toBe("done");
  });

  it("ask_user_question_waits", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "ask", tool: "q1" });
    expect(h.view()).toMatchObject({ status: "waiting", wait_kind: "ask" });
    h.ev("PostToolUse", { kind: "ask", tool: "q1" });
    expect(h.view()!.status).toBe("working");
    h.ev("PreToolUse", { kind: "plan", tool: "q2" });
    expect(h.view()).toMatchObject({ status: "waiting", wait_kind: "plan" });
  });

  it("esc_interrupt_via_tool_failure", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "shell", tool: "t1" });
    h.ev("PostToolUseFailure", { kind: "shell", tool: "t1", interrupt: true });
    expect(h.view()).toMatchObject({ status: "idle", running: 0 });
  });

  it("stop_failure", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("StopFailure", { err_kind: "rate_limit" });
    expect(h.view()).toMatchObject({ status: "error", err_kind: "rate_limit" });
  });

  it("background_tasks_keep_working", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("Stop", { bg: 2 });
    let v = h.view()!;
    expect([v.status, v.bg]).toEqual(["working", 2]);
    expect(v.bg_since).not.toBeNull();
    expect(h.g.sessions.get("s1")!.statusCode()).toBe("b");
    // 后台任务跑完、模型接着回答完：不再显示在等
    h.ev("Stop", { bg: 0 });
    v = h.view()!;
    expect([v.status, v.bg, v.bg_since]).toEqual(["done", 0, null]);
  });

  it("background_task_notification_wakes_model", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("Stop", { bg: 2 });
    const first = h.view()!.bg_since;
    h.advance(5000);
    // b1 跑完：通知并进同一轮，模型接着想，不再是「只在等后台」
    h.ev("UserPromptSubmit", { prompt: "p1", task_note: true });
    let v = h.view()!;
    expect([v.status, v.phase, v.bg, v.bg_since, v.round]).toEqual(["working", "think", 0, null, 1]);
    expect(v.phase_since).toBe(h.t);
    h.advance(2000);
    h.ev("Stop", { bg: 1 });
    v = h.view()!;
    expect([v.bg, v.bg_since]).toEqual([1, h.t]);
    expect(v.bg_since).not.toBe(first);
  });

  it("通知换了 prompt_id 也并进当前这一轮（实测：后台任务和后台子 agent 交回结果时 prompt_id 是新的）", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("Stop", { bg: 2 });
    h.ev("UserPromptSubmit", { prompt: "p2", task_note: true });
    expect(h.view()).toMatchObject({ round: 1, status: "working", bg: 0 });
    h.ev("Stop", { bg: 1, prompt: "p2" });
    expect(h.view()).toMatchObject({ round: 1, bg: 1 });
    h.ev("UserPromptSubmit", { prompt: "p3", task_note: true });
    h.ev("Stop", { bg: 0, prompt: "p3" });
    expect(h.view()).toMatchObject({ round: 1, status: "done" });
    // 做完以后再来的通知把模型叫醒：新的一轮
    h.ev("UserPromptSubmit", { prompt: "p4", task_note: true });
    expect(h.view()).toMatchObject({ round: 2, status: "working" });
  });

  it("background_wait_ends_when_model_acts", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("Stop", { bg: 1 });
    h.ev("PreToolUse", { kind: "read", tool: "t1" });
    const v = h.view()!;
    expect([v.status, v.phase, v.bg, v.bg_since]).toEqual(["working", "act", 0, null]);
  });

  it("compact", () => {
    const h = new Harness();
    h.ev("SessionStart", { source: "startup" });
    h.ev("PreCompact");
    expect(h.view()).toMatchObject({ compacting: true, status: "working" });
    h.ev("PostCompact");
    expect(h.view()).toMatchObject({ status: "idle", compacting: false });
    // 自动压缩以 SessionStart(source=compact) 结束
    h.ev("PreCompact");
    h.ev("SessionStart", { source: "compact" });
    expect(h.view()).toMatchObject({ status: "idle", compacting: false });
  });

  it("ticks 只数真正干活的工具，记账工具不算", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "progress", tool: "t0" });
    h.ev("PreToolUse", { kind: "read", tool: "t1" });
    h.ev("PreToolUse", { kind: "search", tool: "t2" });
    for (const t of ["t0", "t1", "t2"]) h.ev("PostToolUse", { tool: t });
    h.ev("PostToolBatch");
    h.ev("Stop", { bg: 0 });
    const ticks = h.view()!.ticks;
    expect([ticks[0].n, ticks[1].n]).toEqual([2, 0]);   // 最后一圈只有回答
  });

  it("subagent_only_drives_satellite", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "agent", tool: "t1", agent_type_h: "hExplore" });
    h.ev("SubagentStart", { agent: "a1", agent_type: "Explore", agent_type_h: "hExplore" });
    h.ev("PreToolUse", { kind: "search", tool: "x1", agent: "a1" });
    h.ev("PostToolUse", { kind: "search", tool: "x1", agent: "a1" });
    h.ev("PostToolBatch", { agent: "a1" });
    let v = h.view()!;
    expect([v.phase, v.laps]).toEqual(["act", 0]);
    expect(v.subagents[0]).toMatchObject({ phase: "think", tool_id: "t1", type: "Explore" });
    expect(v.steps_total).toBe(1);   // 子 agent 的步骤不算主对话的
    expect(v.steps.filter(x => x.agent === "a1").length).toBe(1);
    // 只处理见过 SubagentStart 的 agent_id
    h.ev("SubagentStop", { agent: "zzz" });
    h.ev("SubagentStop", { agent: "a1" });
    expect(h.view()!.subagents[0].ended).not.toBeNull();
    h.tick(3000);
    expect(h.view()!.subagents).toEqual([]);
  });

  it("subagent_knows_its_spawning_call", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "agent", tool: "t1", agent_type_h: "hgeneral" });
    h.ev("PreToolUse", { kind: "agent", tool: "t2", agent_type_h: "hExplore" });
    h.ev("SubagentStart", { agent: "a1", agent_type: "Explore", agent_type_h: "hExplore" });   // 类型对得上的优先
    h.ev("SubagentStart", { agent: "a2", agent_type: "custom", agent_type_h: "hgeneral" });
    h.ev("SubagentStart", { agent: "a3", agent_type: "Explore", agent_type_h: "hExplore" });   // 都认领了：算最近那一次
    const subs = Object.fromEntries(h.view()!.subagents.map(x => [x.id, x.tool_id]));
    expect(subs).toEqual({ a1: "t2", a2: "t1", a3: "t2" });
    expect(h.view()!.subagents.every(x => x.started)).toBe(true);
  });

  it("subagent_without_type_is_general_purpose（派遣没写类型时脚本按 general-purpose 算哈希）", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "agent", tool: "t1", agent_type_h: "hExplore" });
    h.ev("PreToolUse", { kind: "agent", tool: "t2", agent_type_h: "hgp" });
    h.ev("SubagentStart", { agent: "a1", agent_type: "general-purpose", agent_type_h: "hgp" });
    h.ev("SubagentStart", { agent: "a2", agent_type: "Explore", agent_type_h: "hExplore" });
    expect(Object.fromEntries(h.view()!.subagents.map(x => [x.id, x.tool_id]))).toEqual({ a1: "t2", a2: "t1" });
  });

  it("subagent_permission_alerts_main", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("SubagentStart", { agent: "a1", agent_type: "custom", agent_type_h: "hg" });
    h.ev("PermissionRequest", { kind: "shell", agent: "a1" });
    const v = h.view()!;
    expect([v.status, v.subagents[0].status, v.wait_sub]).toEqual(["waiting", "waiting", true]);
    h.ev("PostToolUse", { tool: "x", agent: "a1" });
    expect(h.view()!.status).toBe("working");
  });

  it("no_post_tool_batch_fallback", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "read", tool: "t1" });
    h.ev("PostToolUse", { kind: "read", tool: "t1" });
    h.tick(2000);
    expect([h.view()!.laps, h.view()!.phase]).toEqual([1, "think"]);
  });

  it("missed_prompt_submit_uses_prompt_id", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("Stop", { bg: 0 });
    h.ev("PreToolUse", { kind: "read", tool: "t1", prompt: "p2" });
    const v = h.view()!;
    expect([v.status, v.round, v.laps]).toEqual(["working", 2, 1]);   // 圈数是累计的：上一轮的 1 圈
    expect(h.g.sessions.get("s1")!.laps).toBe(0);                      // 这一轮还没有跑完的圈
  });

  it("records_counts_fill_in_after_server_restart", () => {
    // 服务器重启过：第一次见到这个会话就是第二次提问，记录里已经有 5 圈、7 步
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p2", laps: 5, steps: 7 });
    expect([h.view()!.laps, h.view()!.steps_total]).toEqual([5, 7]);
    h.ev("PreToolUse", { kind: "read", tool: "t1" });
    h.ev("PostToolUse", { kind: "read", tool: "t1" });
    h.ev("PostToolBatch");
    h.ev("Stop", { bg: 0, laps: 7, steps: 8 });   // 记录里还差最后一条没写进去也只是下限
    expect([h.view()!.laps, h.view()!.steps_total]).toEqual([7, 8]);
    // 服务器数得比记录多（比如 Stop 时最后一条还没写进记录）：不往回减
    h.ev("UserPromptSubmit", { prompt: "p3", laps: 6, steps: 8 });
    expect([h.view()!.laps, h.view()!.steps_total]).toEqual([7, 8]);
  });

  it("records_counts_ignored_mid_round", () => {
    // 工作中途并进来的提问（排队的消息、后台任务通知）：记录里有正在跑的这一圈，不能拿来补
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "read", tool: "t1" });
    h.ev("UserPromptSubmit", { prompt: "p1", laps: 1, steps: 1 });
    h.ev("PostToolUse", { kind: "read", tool: "t1" });
    h.ev("PostToolBatch");
    expect(h.view()!.laps).toBe(1);
  });
});

describe("支线和等待（TestDispatchMap）", () => {
  it("running_tools_branch", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "read", tool: "t1" });
    h.ev("PreToolUse", { kind: "shell", tool: "t2" });
    h.ev("PreToolUse", { kind: "progress", tool: "t3" });
    h.ev("PreToolUse", { kind: "mcp", tool: "t4" });
    expect(h.view()!.tools.map(([id, x]) => [id, x.kind])).toEqual([["t1", "read"], ["t2", "shell"], ["t3", "progress"], ["t4", "mcp"]]);
    // 子 agent 里的工具不算主对话的
    h.ev("SubagentStart", { agent: "a1", agent_type: "Explore" });
    h.ev("PreToolUse", { kind: "web", tool: "s1", agent: "a1" });
    expect(h.view()!.running).toBe(4);
  });

  it("signal_branch_while_waiting", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "web", tool: "t1" });
    h.ev("PermissionRequest", { kind: "web" });
    expect(h.g.sessions.get("s1")!.waitBranch).toBe("net");
    expect(h.view()!.status).toBe("waiting");
    h.ev("PostToolUse", { kind: "web", tool: "t1" });
    expect(h.view()!.wait_kind).toBeNull();
  });

  it("error kinds", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("StopFailure", { err_kind: "server" });
    expect(h.view()).toMatchObject({ status: "error", err_kind: "server" });
    expect(h.g.sessions.get("s1")!.statusCode()).toBe("e");
  });

  it("live_round_for_replay：步骤按圈、按轮记下来", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1" });
    h.ev("PreToolUse", { kind: "read", tool: "t1" });
    h.ev("PostToolUse", { kind: "read", tool: "t1", duration_ms: 40 });
    h.ev("PostToolBatch");
    h.ev("PreToolUse", { kind: "shell", tool: "t2" });
    const st = h.view()!.steps;
    expect(st.map(x => [x.id, x.kind, x.lap, x.round, x.end == null])).toEqual([["t1", "read", 1, 1, false], ["t2", "shell", 2, 1, true]]);
    expect(st[0].end! - st[0].start).toBe(40);   // 耗时优先用 duration_ms
  });
});

describe("会话的来去（TestSlots）", () => {
  it("SessionEnd 移除；迟到的事件不让它复活；--resume 照常显示", () => {
    const h = new Harness();
    h.ev("SessionStart", { sid: "a", source: "startup" });
    h.ev("SessionStart", { sid: "b", source: "startup" });
    h.ev("SessionEnd", { sid: "b" });
    expect(h.view("b")).toBeNull();
    h.ev("Stop", { sid: "b", bg: 0 });   // 退出前就发出的事件晚到了
    expect(h.view("b")).toBeNull();
    h.ev("SessionEnd", { sid: "a" });
    h.ev("SessionStart", { sid: "a", source: "resume" });
    expect(h.view("a")).not.toBeNull();
  });

  it("stale", () => {
    const h = new Harness();
    h.ev("SessionStart", { source: "startup" });
    h.ev("UserPromptSubmit", { prompt: "p" });
    h.tick(31 * 60_000);
    const v = h.view()!;
    expect([v.status, v.stale]).toEqual(["idle", true]);
    expect(h.g.sessions.get("s1")!.statusCode()).toBe("s");
  });

  it("stale_never_hides_waiting", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p" });
    h.ev("PreToolUse", { kind: "shell", tool: "t1" });
    h.ev("PermissionRequest", { kind: "shell" });
    h.tick(31 * 60_000);
    expect([h.view()!.status, h.view()!.stale]).toEqual(["waiting", false]);   // 对话框还开着，仍然需要你
  });

  it("stale_keeps_long_running_tool", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p" });
    h.ev("PreToolUse", { kind: "shell", tool: "t1" });
    h.tick(31 * 60_000);
    let v = h.view()!;
    expect([v.status, v.phase, v.stale, v.running]).toEqual(["working", "act", true, 1]);
    h.ev("PostToolUse", { kind: "shell", tool: "t1" });   // 长命令跑完，接得上
    h.ev("PostToolBatch");
    v = h.view()!;
    expect([v.status, v.phase, v.stale, v.laps]).toEqual(["working", "think", false, 1]);
  });

  it("两小时没有事件就移除；星系空了记下时间", () => {
    const h = new Harness();
    h.ev("SessionStart", { source: "startup" });
    h.tick(2 * 3600_000 + 1000);
    expect(h.view()).toBeNull();
    expect(h.g.emptySince).not.toBeNull();
  });

  it("在想却两分钟没有任何事件（拿不到 Esc 打断）：回到待命；有工具或后台任务在跑时不动", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p" });
    h.tick(119_000);
    expect(h.view()!.status).toBe("working");
    h.tick(2_000);
    expect(h.view()!.status).toBe("idle");
    h.ev("UserPromptSubmit", { prompt: "p2" });
    h.ev("PreToolUse", { kind: "shell", tool: "t1" });
    h.tick(5 * 60_000);
    expect(h.view()!.status).toBe("working");
    h.ev("PostToolUse", { kind: "shell", tool: "t1" });
    h.ev("Stop", { bg: 1 });
    h.tick(5 * 60_000);
    expect(h.view()).toMatchObject({ status: "working", bg: 1 });
  });

  it("项目按第一次出现排；同一项目里的对话按出现先后；/clear 时项目位置不变", () => {
    const h = new Harness();
    h.ev("SessionStart", { sid: "a", proj: "x" });
    h.advance(10);
    h.ev("SessionStart", { sid: "b", proj: "y" });
    h.advance(10);
    h.ev("SessionStart", { sid: "c", proj: "x" });
    expect(h.g.layout().map(p => [p.id, p.sids])).toEqual([["x", ["a", "c"]], ["y", ["b"]]]);
    h.ev("SessionEnd", { sid: "a" });
    h.ev("SessionEnd", { sid: "c" });
    h.ev("SessionStart", { sid: "a2", proj: "x", source: "clear" });
    expect(h.g.layout().map(p => p.id)).toEqual(["x", "y"]);
  });

  it("每个安装最多 50 个会话", () => {
    const h = new Harness();
    for (let i = 0; i < 60; i++) h.ev("SessionStart", { sid: `s${i}` });
    expect(h.g.sessions.size).toBe(50);
  });

  it("每个会话最多留 600 步", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p" });
    for (let i = 0; i < 700; i++) { h.ev("PreToolUse", { kind: "read", tool: `t${i}` }); h.ev("PostToolUse", { tool: `t${i}` }); }
    const v = h.view()!;
    expect(v.steps.length).toBeLessThanOrEqual(600);
    expect(v.steps_total).toBe(700);
    expect(v.steps[v.steps.length - 1].id).toBe("t699");
  });
});

describe("吸收进当前一轮的输入（TestAbsorbedPrompt）", () => {
  it("task_notification_mid_turn_keeps_round", () => {
    const h = new Harness();
    h.ev("SessionStart", { source: "startup" });
    h.ev("UserPromptSubmit", { prompt: "p1" });
    for (let i = 0; i < 3; i++) {
      h.advance(1000); h.ev("PreToolUse", { kind: "shell", tool: `t${i}` });
      h.advance(1000); h.ev("PostToolUse", { kind: "shell", tool: `t${i}` });
      h.ev("PostToolBatch");
    }
    const before = h.view()!;
    expect([before.round, before.laps]).toEqual([1, 3]);
    h.ev("UserPromptSubmit", { prompt: "p1", task_note: true });
    const v = h.view()!;
    expect([v.round, v.laps, v.ticks.length, v.round_since]).toEqual([1, 3, 3, before.round_since]);
    h.ev("Stop", { bg: 0 });
    h.ev("UserPromptSubmit", { prompt: "p2" });
    expect(h.view()!.round).toBe(2);
  });
});

describe("乱序的残余", () => {
  it("结束先于开始到达：记成已结束的一步，不当成在跑", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p" });
    h.ev("PostToolUse", { kind: "read", tool: "t1", duration_ms: 30 });
    h.ev("PreToolUse", { kind: "read", tool: "t1" });
    const v = h.view()!;
    expect(v.running).toBe(0);
    expect(v.steps.map(x => [x.id, x.end != null])).toEqual([["t1", true]]);
  });
  it("没见过的会话照常新建（服务器重启后）；没见过的子 agent 的工具事件不报错", () => {
    const h = new Harness();
    h.ev("PostToolUse", { sid: "new", kind: "shell", tool: "zz" });
    h.ev("PreToolUse", { sid: "new", kind: "shell", tool: "q", agent: "ghost" });
    h.ev("SubagentStop", { sid: "new", agent: "ghost" });
    expect(h.view("new")).not.toBeNull();
  });
});

describe("大附件：哪些地方能点开", () => {
  it("中途从概要改成完整：之前的步骤点不开，之后的能点开", () => {
    const h = new Harness();
    h.ev("UserPromptSubmit", { prompt: "p1", level: 1, enc: "c2VhbGVk" });
    h.ev("PreToolUse", { kind: "read", tool: "t1", level: 1, enc: "c2VhbGVk" });
    h.ev("PostToolUse", { kind: "read", tool: "t1", level: 1 });
    h.ev("PreToolUse", { kind: "read", tool: "t2", level: 2, enc: "c2VhbGVk", enc_full: "c2VhbGVk" });
    h.ev("Stop", { prompt: "p1", bg: 0, level: 2, enc: "c2VhbGVk", enc_full: "c2VhbGVk" });
    const v = h.view()!;
    expect(v.steps.map(x => [!!x.fin, !!x.fout])).toEqual([[false, false], [true, false]]);
    expect([v.ask?.f, v.ans?.f]).toEqual([undefined, true]);
  });
});
