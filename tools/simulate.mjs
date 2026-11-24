#!/usr/bin/env node
// 开发用：模拟几个安装（星系）里的 Claude Code 会话，把假的 hook 数据经过插件的 report.mjs 处理后发给服务器。
// 和真插件走同一份代码（buildEvent、加密、口令），所以服务器和页面看到的和真的一样。内容全是编的。
//
//   node tools/simulate.mjs                          # 1 个星系，发到 http://127.0.0.1:4317（本机模式，明文附件）
//   node tools/simulate.mjs --galaxies 5 --sessions 4
//   node tools/simulate.mjs --url "https://loop.example.com/#k=<K>"   # 星系群：附件加密，带口令
//   node tools/simulate.mjs --share anonymous        # 只发匿名字段
//   node tools/simulate.mjs --print                  # 只把要发的事件打印出来
import { randomBytes } from "node:crypto";
import { buildEvent, deriveKeys, galaxyId, isLocal, parseTarget, send, shareLevel } from "../plugin/hooks/report.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; };
const target = parseTarget(opt("url", "http://127.0.0.1:4317"));
const NG = +opt("galaxies", 1), NS = +opt("sessions", 3), SPEED = +opt("speed", 1);
const PRINT = args.includes("--print");
const local = isLocal(target.url);
const keys = target.k ? deriveKeys(target.k) : null;
const level = shareLevel(opt("share", ""), local);
if (!local && !keys) { console.error("非本机地址要一条邀请链接（--url \"https://…/#k=…\"）"); process.exit(1); }

const pick = a => a[Math.floor(Math.random() * a.length)];
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = ms => new Promise(r => setTimeout(r, ms / SPEED));
const id = () => randomBytes(8).toString("hex");
const NAMES = ["Orion", "Vega", "Lyra", "Atlas", "Juno", "Kepler"];
const PROJECTS = ["C:\\work\\atlas", "C:\\work\\storefront", "/home/me/ledger", "/home/me/field-notes", "C:\\code\\playground"];
const FILES = ["src/app.ts", "src/server.ts", "src/routes/cart.ts", "web/draw.ts", "README.md", "test/cart.test.ts", "lib/money.ts", "package.json"];
const PROMPTS = ["Fix the rounding bug in the cart total", "给结算页加一个优惠码输入框", "Why is the build slow? Profile it",
  "把登录页的样式改成暗色", "Add tests for the money helpers", "Refactor the router into smaller files", "解释一下这个报错，然后修好它"];
const ANSWERS = ["All tests pass now.", "改好了，测试都过了。", "The slow part was the image pipeline; it's cached now.", "Done. I left a note in the README."];

function toolCall() {
  const f = pick(FILES), name = pick(["Read", "Read", "Edit", "Grep", "Glob", "Bash", "Bash", "WebFetch", "mcp__github__get_issue", "TodoWrite"]);
  const input = {
    Read: { file_path: `/repo/${f}` }, Edit: { file_path: `/repo/${f}`, old_string: "const total = a + b", new_string: "const total = round(a + b)" },
    Grep: { pattern: pick(["roundTo", "TODO", "fetchCart", "export function"]), path: "src" }, Glob: { pattern: "src/**/*.ts" },
    Bash: { command: pick(["npm test", "npm run build", "git status", "node scripts/profile.mjs --flame"]), description: "run it" },
    WebFetch: { url: "https://developer.mozilla.org/en-US/docs/Web/API", prompt: "summarize" },
    mcp__github__get_issue: { owner: "me", repo: "shop", issue_number: 42 }, TodoWrite: { todos: [] },
  }[name];
  const response = {
    Read: { type: "text", file: { filePath: `/repo/${f}`, content: "export function total(a, b) {\n  return a + b;\n}\n" } },
    Bash: { stdout: "PASS  test/cart.test.ts\nTests: 12 passed", stderr: "", interrupted: false },
    Grep: { mode: "content", content: `src/cart.ts:12: ${input.pattern ?? ""}`, numFiles: 1 },
    Glob: { filenames: FILES.filter(x => x.startsWith("src")), numFiles: 3 },
  }[name] ?? { ok: true };
  return { name, input, response };
}

async function emit(g, hook) {
  const ev = buildEvent(hook, { salt: g.salt, level, local, key: keys?.content, gid: galaxyId(g.secret), me: g.me, projectDir: hook.cwd });
  if (!ev) return;
  if (PRINT) { console.log(JSON.stringify(ev).slice(0, 300)); return; }
  try { await send(target.url, g.secret, ev, 2000, keys?.access); } catch { /* 服务器没开 */ }
}

async function tool(g, s, extra = {}) {
  const { name, input, response } = toolCall();
  const tid = "toolu_" + id(), t0 = Date.now();
  await emit(g, { ...s.base, ...extra, hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: tid });
  if (Math.random() < 0.06 && !extra.agent_id) {   // 要你授权
    await emit(g, { ...s.base, hook_event_name: "PermissionRequest", tool_name: name, tool_input: input, tool_use_id: tid });
    await sleep(rand(3000, 9000));
  }
  await sleep(Math.random() < 0.08 ? rand(4000, 15000) : Math.exp(rand(Math.log(30), Math.log(2500))));
  const failed = Math.random() < 0.04;
  await emit(g, { ...s.base, ...extra, hook_event_name: failed ? "PostToolUseFailure" : "PostToolUse", tool_name: name, tool_input: input,
    tool_use_id: tid, duration_ms: Date.now() - t0, ...(failed ? { error: "Error: ENOENT: no such file or directory\n    at open" } : { tool_response: response }) });
  return tid;
}

async function subagent(g, s) {
  const aid = "a" + id(), type = pick(["Explore", "general-purpose", "code-reviewer"]);
  const tid = "toolu_" + id();
  await emit(g, { ...s.base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: type, description: "Find every caller of total()" }, tool_use_id: tid });
  await sleep(300);
  await emit(g, { ...s.base, hook_event_name: "SubagentStart", agent_id: aid, agent_type: type });
  for (let i = 0, n = Math.floor(rand(3, 9)); i < n; i++) {
    await tool(g, s, { agent_id: aid, agent_type: type });
    await emit(g, { ...s.base, hook_event_name: "PostToolBatch", agent_id: aid, agent_type: type, tool_calls: [] });
    await sleep(rand(200, 1500));
  }
  await emit(g, { ...s.base, hook_event_name: "SubagentStop", agent_id: aid, agent_type: type });
  await emit(g, { ...s.base, hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: {}, tool_use_id: tid, duration_ms: 5000 });
}

async function session(g, k) {
  const sid = randomBytes(16).toString("hex");
  const cwd = PROJECTS[(k + g.n) % PROJECTS.length];
  const s = { base: { session_id: sid, cwd, transcript_path: "/x/" + sid + ".jsonl", permission_mode: "default" } };
  await sleep(rand(0, 3000));
  await emit(g, { ...s.base, hook_event_name: "SessionStart", source: "startup", model: pick(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) });
  for (;;) {
    await sleep(rand(3000, 25000));   // 你在想下一句话
    s.base.prompt_id = "p" + id();
    await emit(g, { ...s.base, hook_event_name: "UserPromptSubmit", prompt: pick(PROMPTS) });
    for (let lap = 0, laps = Math.floor(rand(2, 14)); lap < laps; lap++) {
      await sleep(rand(600, 5000));   // 模型在想
      if (Math.random() < 0.1) await subagent(g, s);
      else await Promise.all(Array.from({ length: pick([1, 1, 1, 2, 3]) }, () => tool(g, s)));
      await emit(g, { ...s.base, hook_event_name: "PostToolBatch", tool_calls: [] });
    }
    await sleep(rand(500, 3000));
    if (Math.random() < 0.15) {
      await emit(g, { ...s.base, hook_event_name: "Stop", background_tasks: [{ id: "b1", type: "shell", status: "running" }] });
      await sleep(rand(5000, 12000));
      s.base.prompt_id = "p" + id();
      await emit(g, { ...s.base, hook_event_name: "UserPromptSubmit", prompt: "<task-notification><task-id>b1</task-id>" });
      await sleep(rand(800, 2500));
    }
    if (Math.random() < 0.05) await emit(g, { ...s.base, hook_event_name: "StopFailure", error: "rate_limit" });
    else await emit(g, { ...s.base, hook_event_name: "Stop", last_assistant_message: pick(ANSWERS), background_tasks: [] });
  }
}

const galaxies = Array.from({ length: NG }, (_, n) => ({ n, secret: randomBytes(32).toString("hex"), salt: randomBytes(16).toString("hex"), me: NAMES[n % NAMES.length] }));
console.log(`模拟 ${NG} 个星系、每个 ${NS} 个会话 → ${target.url}（${local ? "本机" : "星系群 " + keys.group}，档位 ${level}）`);
for (const g of galaxies) console.log(`  星系 ${galaxyId(g.secret)}  ${target.url}/#${target.k ? `k=${target.k}&` : ""}galaxy=${galaxyId(g.secret)}`);
for (const g of galaxies) for (let k = 0; k < NS; k++) session(g, k);
