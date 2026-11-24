#!/usr/bin/env node
// 把 tools/demo/scenes.mjs 里的剧本展开成事件，写进 web/src/demo/script.json（演示站在浏览器里播放它）。
// 事件经过插件的 buildEvent（本机、完整档位），所以和真插件发的是同一种格式，带明文附件；原样数据（raw）去掉。
//   npm run demo:script
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvent, galaxyId } from "../../plugin/hooks/report.mjs";
import { GALAXIES } from "./scenes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../../web/src/demo/script.json");
const h = s => createHash("sha256").update(s).digest("hex");

/** 固定种子的伪随机数：每次展开结果一样 */
function rng(seed) { let x = parseInt(h(seed).slice(0, 8), 16) || 1; return () => ((x = (x * 1103515245 + 12345) >>> 0) % 100000) / 100000; }

function expandSession(gi, si, ses, gid) {
  const rand = rng(`demo-${gi}-${si}`), between = (a, b) => a + (b - a) * rand();
  const sid = `demo-session-${gi}-${si}`, base = { session_id: sid, cwd: ses.proj, transcript_path: "", permission_mode: "default" };
  const evs = [];   // { at（毫秒，相对这段对话的开始）, hook }
  let t = 0, nTool = 0, nPrompt = 0, nAgent = 0;
  const push = (at, hook) => evs.push({ at: Math.round(at), hook: { ...base, ...hook } });

  /** 跑一个工具：返回结束的时刻 */
  const tool = (start, [name, input, secs, output, opts = {}], extra = {}) => {
    const id = `toolu_demo_${gi}_${si}_${nTool++}`;
    push(start, { ...extra, hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: id });
    let s = start;
    if (opts.ask) { push(s + 150, { ...extra, hook_event_name: "PermissionRequest", tool_name: name, tool_input: input, tool_use_id: id }); s += opts.ask * 1000; }
    const end = s + secs * 1000;
    if (opts.fail) push(end, { ...extra, hook_event_name: "PostToolUseFailure", tool_name: name, tool_input: input, tool_use_id: id, error: opts.fail, duration_ms: end - start });
    else push(end, { ...extra, hook_event_name: "PostToolUse", tool_name: name, tool_input: input, tool_use_id: id, tool_response: output, duration_ms: end - start });
    return end;
  };

  for (const round of ses.rounds) {
    base.prompt_id = `prompt_demo_${gi}_${si}_${nPrompt++}`;
    push(t, { hook_event_name: "UserPromptSubmit", prompt: round.prompt });
    t += between(1500, 3500);
    for (const lap0 of round.laps) {
      // [{ agent… }] 和 { agent… } 一样：派一个子 agent
      const lap = Array.isArray(lap0) && lap0.length === 1 && !Array.isArray(lap0[0]) && lap0[0].agent ? lap0[0] : lap0;
      if (Array.isArray(lap)) {
        let end = t;
        lap.forEach((spec, i) => { end = Math.max(end, tool(t + i * 40, spec)); });
        push(end + 40, { hook_event_name: "PostToolBatch", tool_calls: [] });
        t = end + between(900, 3200);
      } else {   // 派一个子 agent
        const aid = `agent_demo_${gi}_${si}_${nAgent++}`, tid = `toolu_demo_${gi}_${si}_${nTool++}`, extra = { agent_id: aid, agent_type: lap.agent };
        push(t, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: lap.agent, description: lap.desc, prompt: lap.desc }, tool_use_id: tid });
        let s = t + 300;
        push(s, { hook_event_name: "SubagentStart", ...extra });
        s += between(1200, 2500);
        for (const spec of lap.steps) {
          s = tool(s, spec, extra);
          push(s + 30, { hook_event_name: "PostToolBatch", ...extra, tool_calls: [] });
          s += between(800, 2200);
        }
        push(s, { hook_event_name: "SubagentStop", ...extra, last_assistant_message: "Done." });
        push(s + 200, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: {}, tool_use_id: tid, tool_response: { status: "completed" }, duration_ms: s + 200 - t });
        push(s + 260, { hook_event_name: "PostToolBatch", tool_calls: [] });
        t = s + between(1200, 2800);
      }
    }
    if (round.bg) {   // 回答完了，还留着一个命令在后台跑
      push(t, { hook_event_name: "Stop", last_assistant_message: round.answer, background_tasks: [{ id: "bg", type: "shell", status: "running" }] });
      t += round.bg * 1000;
      base.prompt_id = `prompt_demo_${gi}_${si}_${nPrompt++}`;
      push(t, { hook_event_name: "UserPromptSubmit", prompt: "<task-notification><task-id>bg</task-id>" });
      t += between(1200, 2400);
    }
    push(t, { hook_event_name: "Stop", last_assistant_message: round.answer, background_tasks: [] });
    t += (ses.gap ?? 15) * 1000;
  }

  // 标题：真插件从会话记录里读 Claude Code 起的标题，这里用剧本里写的。token 数在下面另编，这里给 0
  const ctx = { salt: h("demo-salt").slice(0, 32), level: 2, local: true, gid, projectDir: ses.proj,
    readUsage: () => ({ ctx: 0, out: 0, ...(ses.title ? { title: ses.title } : {}) }) };
  const out = e => { const ev = buildEvent(e.hook, ctx); delete ev.raw; return ev; };
  // token 数：真插件从会话记录里读，这里编。上下文每一圈涨一点，输出逐圈累加；循环一次输出再接着加（play.ts 加上 outPer）
  const ctx0 = Math.round(between(16_000, 24_000));
  let ctxTok = ctx0, outTok = 0;
  const cycle = evs.sort((a, b) => a.at - b.at).map(e => {
    const ev = { ...out(e), model: e.hook.hook_event_name === "Stop" ? ses.model : undefined };
    if ((ev.ev === "PostToolBatch" || ev.ev === "Stop") && !ev.agent) {
      ctxTok += Math.round(between(600, 4500)); outTok += Math.round(between(150, 1400));
      ev.ctx_tok = ctxTok; ev.out_tok = outTok;
    }
    return { at: e.at, ev };
  });
  return {
    start: ses.start * 1000,
    first: { ...out({ at: 0, hook: { ...base, prompt_id: undefined, hook_event_name: "SessionStart", source: "startup", model: ses.model } }), ctx_tok: ctx0 },
    cycle,
    period: Math.round(t),
    outPer: outTok,
  };
}

const script = GALAXIES.map((gal, gi) => {
  const id = galaxyId(h(`demo-galaxy-${gi}`));   // 只是剧本里的占位：页面每次打开换成随机编号
  return { id, sessions: gal.sessions.map((ses, si) => expandSession(gi, si, ses, id)) };
});
// 去掉 undefined 字段
const json = JSON.stringify({ v: 1, galaxies: script });
writeFileSync(OUT, json + "\n");
console.log(`演示剧本：${script.length} 个星系、${script.reduce((a, g) => a + g.sessions.length, 0)} 段对话、${script.reduce((a, g) => a + g.sessions.reduce((b, s) => b + s.cycle.length, 0), 0)} 条事件 → ${OUT}（${(json.length / 1024).toFixed(0)} KB）`);
