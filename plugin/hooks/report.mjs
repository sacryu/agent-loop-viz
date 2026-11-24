// Agent Loop 插件的上报脚本：这是唯一会把数据发出本机的代码。
//
// Claude Code 每触发一个 hook 事件，就以 `node report.mjs` 起一次这个脚本，把事件数据从标准输入传进来。
// 脚本用白名单的方式挑出允许的字段，重新拼成一条事件，发到服务器，然后退出。不记任何状态。
//
// 隐私规则（详见仓库里的 docs/privacy.md）：
//   - 每条事件都有匿名字段：类别、耗时、加盐哈希后的编号。盐在本机随机生成，永不上传。
//   - 分享多少由你在插件设置里选（share）：anonymous 只有匿名字段；summary 另附小附件（星系名、项目名、对话标题、
//     每一步的工具名和对象、报错第一行、回答最后一句）；full 再附大附件（整句话、工具完整的输入输出、完整的回答和报错）。
//     没选时本机用 full，非本机用 summary。
//   - 发往本机（主机名严格是 127.0.0.1、localhost、::1）时附件是明文，数据不出电脑。
//   - 发往别处时附件一律用 AES-256-GCM 加密，密钥从邀请链接（#k=…）里派生，只在你的插件和看的人的浏览器里。
//     没有邀请链接（没有密钥）就什么都不发。
//   - 用 /agent-loop:leave 退出过的星系群也什么都不发（记在插件数据目录的 left.json 里，/agent-loop:rejoin 去掉）。
//   - 用接入命令换了群以后，还拿着旧设置的会话也不发（moved.json，/reload-plugins 以后就是新设置了）。
//   - 附件里出现的邀请密钥（k=…）一律抹掉，不会跟着别的内容发出去。
//   - 替已经结束、却没把 SessionEnd 送到的会话补发一条 SessionEnd（只有加盐哈希后的会话编号，见 sweepEnded）。
//
// 这个文件不能依赖任何包，也不能从仓库其他目录导入（插件装到你机器上时只有 plugin/ 这一个目录）。
// 任何失败都吞掉：不往标准输出写任何东西，退出码永远是 0。需要 Node 18 以上（自带 fetch）。

import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

/** 默认发往本机（plugin.json 里 userConfig.server_url 的默认值要一起改，测试会检查两处一致）。
 *  本机没有服务在听时静默失败，没有任何可见影响 */
export const DEFAULT_SERVER_URL = "http://127.0.0.1:4317";
/** 插件在 Claude Code 里的名字（插件@市场）：命令行、设置、给用户的提示都用它 */
export const PLUGIN_ID = "agent-loop@agent-loop";
export const PROTOCOL_VERSION = 2;
/** 插件自己的版本，每次上报放在请求头 x-agent-loop-plugin 里，页面据此提示更新。
 *  和 plugin.json 的 version、shared/src/version.ts 的 PLUGIN_VERSION 一致（测试检查） */
export const PLUGIN_VERSION = "0.2.14";
/** 第一个由插件建群（/agent-loop:create）的版本：从这一版起页面认 #galaxy=、&created。插件和私有部署分开升级，
 *  所以打开页面前先问服务器的版本（/healthz 的 version），旧的服务器给 #g=，也不在那里建群。
 *  和 shared/src/version.ts 的 CREATE_SINCE 一致（测试检查） */
export const CREATE_SINCE = "0.2.11";
/** 第一个认 /agent-loop:leave 打开的 #left= 的页面（清掉浏览器里这个群的密钥、显示已经退出）的版本。
 *  和 shared/src/version.ts 的 LEFT_SINCE 一致（测试检查） */
export const LEFT_SINCE = "0.2.12";
export const SEND_TIMEOUT_MS = 2000;
/** SessionEnd 是同步 hook（实测：会话退出时异步进程会被杀掉）。Claude Code 给 SessionEnd 的
 *  总时间约 1.5 秒，超过就取消并在终端打一行提示；Node 启动的时间也算在里面，所以发送超时要短 */
export const SESSION_END_TIMEOUT_MS = 600;
/** 本机、档位 2 附带的原样数据过大时，把长字符串截短 */
const RAW_MAX_BYTES = 200_000;
/** 小附件、大附件明文的上限（字节，JSON）。和 shared/ 的 SMALL_MAX_BYTES、FULL_MAX_BYTES 一致 */
export const SMALL_MAX_BYTES = 600;
export const FULL_MAX_BYTES = 32 * 1024;
/** 星系编号、星系群编号的长度（十六进制字符数，128 位）。和 shared/src/attach.ts 的 ID_HEX 一致。
 *  这两个编号是公开的，服务器靠它们认人，所以比别的哈希（16 个字符）长 */
export const ID_HEX = 32;

// ---- 和 shared/ 保持一致的表（test/plugin-sync.test.ts 检查）

/** @typedef {"read"|"edit"|"search"|"shell"|"web"|"agent"|"ask"|"plan"|"progress"|"mcp"|"other"} ToolKind */
/** @typedef {"rate_limit"|"server"|"auth"|"billing"|"max_output"|"other"} ErrKind */
/** @typedef {0|1|2} Level */

/** @type {Record<string, ToolKind>} */
export const TOOL_TABLE = {
  Read: "read", NotebookRead: "read", LS: "read",
  Edit: "edit", MultiEdit: "edit", Write: "edit", NotebookEdit: "edit",
  Grep: "search", Glob: "search",
  Bash: "shell", PowerShell: "shell", BashOutput: "shell", KillBash: "shell", KillShell: "shell",
  WebFetch: "web", WebSearch: "web",
  Task: "agent", Agent: "agent",
  AskUserQuestion: "ask",
  ExitPlanMode: "plan",
  TodoWrite: "progress", TaskCreate: "progress", TaskUpdate: "progress", TaskList: "progress", TaskGet: "progress",
  SubagentHandback: "progress",
};

export const EVENT_NAMES = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PostToolBatch", "PermissionRequest", "PermissionDenied", "Notification", "Stop", "StopFailure",
  "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
];
export const SESSION_SOURCES = ["startup", "resume", "clear", "compact", "fork"];
export const NOTIFICATION_TYPES = [
  "permission_prompt", "idle_prompt", "auth_success", "elicitation_dialog", "elicitation_complete",
  "elicitation_response", "agent_needs_input", "agent_completed",
];
export const BUILTIN_AGENT_TYPES = ["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide"];
/** 模型名只认 Claude 的模型名（claude-… 或几个别名），别的（比如自建网关上起的名字）一律不传 */
export const MODEL_RE = /^(claude-[a-z0-9.-]{1,60}(\[1m\])?|opus|sonnet|haiku|fable)$/;
/** 能当模型名发出去的：字符串、不超过 80 个字符、过 MODEL_RE @param {unknown} v @returns {v is string} */
const isModel = v => typeof v === "string" && v.length <= 80 && MODEL_RE.test(v);
export const SHARE_OPTIONS = ["auto", "anonymous", "summary", "full"];
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * 上传的事件。和 shared/src/protocol.ts 的 schema 一一对应。
 * @typedef {{
 *   v: 2, level: Level, ev: string, ts: number, sid: string, proj: string,
 *   agent?: string, prompt?: string, tool?: string, kind?: ToolKind, duration_ms?: number,
 *   interrupt?: boolean, source?: string, ntype?: string, bg?: number, err_kind?: ErrKind,
 *   agent_type?: string, agent_type_h?: string, task_note?: boolean, model?: string, ctx_tok?: number, out_tok?: number, laps?: number, steps?: number,
 *   detail?: Detail, detail_full?: unknown, enc?: string, enc_full?: string, card?: Detail, enc_card?: string,
 *   title?: Detail, enc_title?: string, raw?: unknown
 * }} OutEvent
 */

/** 小附件的明文（和 shared/ 的 Detail 一致） @typedef {{ me?: string, proj?: string, label?: string, name?: string,
 *  obj?: string, err?: string, type?: string, say?: string }} Detail */

/** @param {unknown} name @returns {ToolKind} */
export function toolKind(name) {
  const n = typeof name === "string" ? name : "";
  if (Object.prototype.hasOwnProperty.call(TOOL_TABLE, n)) return TOOL_TABLE[n];
  if (n.startsWith("mcp__")) return "mcp";
  return "other";
}

/**
 * StopFailure 的 error（rate_limit、server_error、authentication_failed……）归类。照搬 Python 版的 error_kind。
 * @param {unknown} err @returns {ErrKind}
 */
export function errorKind(err) {
  let raw;
  if (err && typeof err === "object") raw = Object.values(err).map(String).join(" ");
  else raw = String(err ?? "");
  const s = raw.toLowerCase();
  if ((s.includes("rate") && s.includes("limit")) || s.includes("429")) return "rate_limit";
  if (s.includes("overload") || s.includes("529") || s.includes("busy") || s.includes("server") || /\b5\d\d\b/.test(s)) return "server";
  if (s.includes("auth") || s.includes("login") || s.includes("401") || s.includes("403") || s.includes("token expired")) return "auth";
  if (s.includes("billing") || s.includes("credit") || s.includes("payment") || s.includes("quota")) return "billing";
  if (s.includes("max_output") || s.includes("max_tokens") || s.includes("output token") || s.includes("too long")) return "max_output";
  return "other";
}

/**
 * 是不是本机地址：主机名严格是 127.0.0.1、localhost、::1。只有本机地址才发明文附件
 * @param {string} url @returns {boolean}
 */
export function isLocal(url) {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * 分享档位：设置里的 share 加上是不是本机。没设、或者设成 auto：本机 2（完整），非本机 1（概要）；认不出的值按 1
 * @param {string | undefined} share @param {boolean} local @returns {Level}
 */
export function shareLevel(share, local) {
  const v = (share || "").trim().toLowerCase();
  if (!v || v === "auto" || v.startsWith("${")) return local ? 2 : 1;
  if (v === "anonymous") return 0;
  if (v === "full") return 2;
  return 1;
}

/** @param {string} salt @param {string} value */
export function hash16(salt, value) {
  return createHash("sha256").update(salt + value).digest("hex").slice(0, 16);
}

/** sha256 的前 32 个十六进制字符：公开的星系编号 = idOf(secret)，星系群编号 = idOf(口令)，服务器也这样算 @param {string} v */
const idOf = v => createHash("sha256").update(v).digest("hex").slice(0, ID_HEX);

/** 公开的星系编号 @param {string} secret */
export const galaxyId = secret => idOf(secret);

/** 项目目录哈希前统一大小写和分隔符 @param {string} dir */
export function normDir(dir) {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** @param {unknown} v @returns {v is string} */
const str = v => typeof v === "string" && v.length > 0;

/** 太大时把长字符串截短（数组最多留 200 项） @param {unknown} v @param {number} n @returns {unknown} */
export function clipDeep(v, n) {
  if (typeof v === "string") return v.length > n ? v.slice(0, n) + `…(+${v.length - n})` : v;
  if (Array.isArray(v)) return v.slice(0, 200).map(x => clipDeep(x, n));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipDeep(x, n)]));
  return v;
}

const bytes = (/** @type {unknown} */ v) => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");

// ---- 附件里的短字段：只负责挑字段和截断，不负责造句（句子由浏览器按看的人的语言拼）

/** 东亚宽字符算 1，其余算 0.55（照搬 Python 版 humanize.py 的 char_width） @param {string} ch */
const charW = ch => /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\ud800-\udbff]/.test(ch) ? 1 : 0.55;
/** @param {string} s */
const textW = s => { let w = 0; for (const c of s) w += charW(c); return w; };
/** 压掉空白，超出 n 个字符时截断加省略号 @param {unknown} v @param {number} n */
export function clip(v, n) {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}
/** 第一行非空的文字 @param {unknown} v */
export function firstLine(v) {
  if (typeof v !== "string") return "";
  for (const line of v.trim().split(/\r?\n/)) if (line.trim()) return line.trim();
  return "";
}

// 只在分句的标点处截断。括号、引号、书名号不算
const PUNCT = new Set("，。！？；：、,!?;:");
/** @param {string} t @param {number} i */
function isBreak(t, i) {
  const c = t[i];
  if (c === ":") return i + 1 === t.length || t[i + 1] === " ";   // http://、C:\、12:30 里的冒号不算
  if (PUNCT.has(c)) return true;
  return c === "." && (i + 1 === t.length || t[i + 1] === " ");   // 英文句点只在句末算
}

/**
 * 对话的标签：输入的第一句的开头，最多约 12 个汉字宽，在标点处截断。照搬 Python 版 humanize.py 的 label_from_prompt
 * @param {unknown} text @param {number} [width] @returns {string}
 */
export function labelFromPrompt(text, width = 12) {
  let t = (typeof text === "string" ? text : "").replace(/\[(Image #\d+|图片)\]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "";
  // 先取第一个分句；太短的开头（「1.」「好的，」）认不出对话，跳过这个标点接着找
  for (let i = 1; i < t.length; i++) if (isBreak(t, i) && textW(t.slice(0, i).trim()) >= 3) { t = t.slice(0, i); break; }
  t = t.trim();
  if (textW(t) <= width) return t;
  // 还是太长：在宽度内最后一个空格处断开（英文），否则硬截
  let w = 0, cut = "";
  for (const c of t) { w += charW(c); if (w > width - 1) break; cut += c; }
  const sp = cut.lastIndexOf(" ");
  if (sp >= 4) cut = cut.slice(0, sp);
  return cut.trimEnd() + "…";
}

/** 对话标签的宽度（汉字算 1，其余算 0.55） */
export const LABEL_WIDTH = 20;

/** 回答的最后一句（去掉 Markdown 记号） @param {unknown} text */
export function lastSentence(text) {
  if (typeof text !== "string") return "";
  /** @type {string[]} */
  const out = [];
  for (let line of text.replace(/[`*#>\[\]]+/g, "").split(/\r?\n/)) {
    line = line.replace(/^[\s\-•]+|[\s\-•]+$/g, "");
    if (!line) continue;
    for (const part of line.split(/(?<=[。！？!?])|(?<=\.)\s+/)) if (part.trim()) out.push(part.trim());
  }
  return out.length ? out[out.length - 1] : "";
}

/** 路径的最后两段：web/draw.ts @param {unknown} p */
export function lastTwo(p) {
  const parts = (typeof p === "string" ? p : "").split(/[\\/]+/).filter(Boolean);
  const s = parts.slice(-2).join("/");
  return s.length > 120 ? "…" + s.slice(-119) : s;   // 太长时留结尾：文件名比目录要紧
}

/**
 * 一步的对象（照搬 Python 版 tool_phrase 取的东西，不带动词）。其余工具（含 MCP）没有对象：真实工具名已经够了
 * @param {string} name @param {any} inp @returns {string}
 */
export function toolObj(name, inp) {
  const i = inp && typeof inp === "object" ? inp : {};
  switch (name) {
    case "Bash": case "PowerShell": return clip(i.command, 60);
    case "Read": case "Edit": case "MultiEdit": case "Write": return lastTwo(i.file_path);
    case "NotebookEdit": return lastTwo(i.notebook_path || i.file_path);
    case "Grep": case "Glob": return clip(i.pattern, 60);
    case "WebFetch": try { return clip(new URL(String(i.url)).hostname, 120); } catch { return clip(i.url, 60); }
    case "WebSearch": return clip(i.query, 60);
    case "Agent": case "Task": return clip(firstLine(i.description) || i.subagent_type, 60);
    case "AskUserQuestion": {
      const q = Array.isArray(i.questions) && i.questions[0] && typeof i.questions[0] === "object" ? i.questions[0].question : "";
      return clip(firstLine(q), 60);
    }
    case "Skill": return clip(i.skill || i.command, 60);
    default: return "";
  }
}

/** 去掉空字段；还超过上限就把最长的那个字段一截一截地剪短 @param {Detail} d @returns {Detail | null} */
export function fitSmall(d) {
  /** @type {Record<string, string>} */
  const o = {};
  for (const [k, v] of Object.entries(d)) if (typeof v === "string" && v) o[k] = v;
  if (!Object.keys(o).length) return null;
  for (let guard = 0; bytes(o) > SMALL_MAX_BYTES && guard < 200; guard++) {
    const k = Object.keys(o).sort((a, b) => o[b].length - o[a].length)[0];
    const s = o[k];
    if (s.length <= 4) { delete o[k]; continue; }
    o[k] = s.slice(0, Math.floor(s.length * 0.8)).trimEnd() + "…";
  }
  return Object.keys(o).length ? o : null;
}

/** 大附件：超过上限时把长字符串越截越短；还是太大就不发 @param {unknown} v @returns {unknown} */
export function fitFull(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (bytes(v) <= FULL_MAX_BYTES) return v;
  for (const n of [8000, 2000, 500, 120]) { const c = clipDeep(v, n); if (bytes(c) <= FULL_MAX_BYTES) return c; }
  return undefined;
}

/** 通知、报错的文字：字符串原样，对象取 message @param {unknown} v @returns {string} */
const textOf = v => typeof v === "string" ? v
  : v && typeof v === "object" && typeof (/** @type {any} */ (v)).message === "string" ? /** @type {any} */ (v).message : "";

/**
 * 小附件（档位 1 起）
 * @param {any} hook @param {string} name @param {{ me?: string, projectDir?: string, taskNote?: boolean }} ctx @returns {Detail | null}
 */
export function smallDetail(hook, name, ctx) {
  switch (name) {
    case "SessionStart": {
      const dir = str(ctx.projectDir) ? ctx.projectDir : str(hook.cwd) ? hook.cwd : "";
      return fitSmall({ me: clip(ctx.me, 40), proj: clip(lastTwo(dir).split("/").pop(), 80) });
    }
    // 宽度比 Python 版的 12 宽一些：它在这里还要当对话的标题；画面上放不下时浏览器会再截
    case "UserPromptSubmit": return ctx.taskNote ? null : fitSmall({ label: labelFromPrompt(hook.prompt, LABEL_WIDTH) });
    case "PreToolUse": case "PermissionRequest": {
      const tn = str(hook.tool_name) ? hook.tool_name.slice(0, 160) : "";
      return tn ? fitSmall({ name: tn, obj: toolObj(tn, hook.tool_input) }) : null;
    }
    case "PostToolUseFailure": return fitSmall({ err: clip(firstLine(textOf(hook.error)), 160) });
    case "SubagentStart": return fitSmall({ type: clip(hook.agent_type, 80) });
    case "Stop": return fitSmall({ say: clip(lastSentence(hook.last_assistant_message), 200) });
    default: return null;
  }
}

/**
 * 大附件（档位 2）
 * @param {any} hook @param {string} name @param {{ taskNote?: boolean }} ctx @returns {unknown}
 */
export function fullDetail(hook, name, ctx) {
  switch (name) {
    case "UserPromptSubmit": return ctx.taskNote ? undefined : fitFull(hook.prompt);
    case "PreToolUse": case "PermissionRequest": return fitFull(hook.tool_input);
    case "PostToolUse": {
      let r = hook.tool_response;
      // Edit、Write 的回应里有整份原文件：又大又和 tool_input 重复，不要
      if (r && typeof r === "object" && !Array.isArray(r) && "originalFile" in r) { r = { ...r }; delete r.originalFile; }
      return fitFull(r);
    }
    case "PostToolUseFailure": return fitFull(textOf(hook.error));
    case "Notification": return fitFull(textOf(hook.message));
    case "Stop": return fitFull(hook.last_assistant_message);
    default: return undefined;
  }
}

// ---- 加密

/** base64url 编码 @param {Buffer} b */
const b64u = b => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * 从邀请链接里的 K 派生出口令（发给服务器）和内容密钥（永不离开本机）。K 是 32 字节随机数的 base64url（43 个字符）。
 * 星系群编号 = sha256(口令) 的前 32 个十六进制字符，服务器自己也这样算
 * @param {string} k @returns {{ access: string, group: string, content: Buffer } | null}
 */
export function deriveKeys(k) {
  if (typeof k !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(k)) return null;
  const K = Buffer.from(k.replace(/-/g, "+").replace(/_/g, "/") + "=", "base64");
  if (K.length !== 32) return null;
  const hk = (/** @type {string} */ info) => Buffer.from(hkdfSync("sha256", K, Buffer.alloc(0), info, 32));
  const access = b64u(hk("agent-loop/access/v1"));
  return { access, group: idOf(access), content: hk("agent-loop/content/v1") };
}

/**
 * AES-256-GCM 加密：base64url(12 字节随机数 ‖ 密文 ‖ 16 字节校验)。aad 是 协议版本|槽|sid|键
 * @param {Buffer} key @param {unknown} value @param {string} aad
 */
export function seal(key, value, aad) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  return b64u(Buffer.concat([iv, c.update(JSON.stringify(value), "utf8"), c.final(), c.getAuthTag()]));
}

/**
 * 一条事件的附件放进哪个槽、用什么键。和 shared/src/attach.ts 的 slotsOf 一致（test/plugin-sync.test.ts 检查）
 * 名片（card）的附加校验数据里放星系编号 gid：服务器没法把你的名片挪到别人的星系上
 * @param {{ ev: string, sid: string, proj: string, tool?: string, agent?: string, prompt?: string }} ev @param {string} [gid]
 * @returns {{ small: { slot: string, sid: string, k: string } | null, full: { slot: string, sid: string, k: string } | null }}
 */
export function slotsOf(ev, gid = "") {
  const sid = ev.sid, tool = ev.tool, pr = ev.prompt ?? "";
  switch (ev.ev) {
    case "SessionStart": return { small: { slot: "card", sid: gid, k: ev.proj }, full: null };
    case "UserPromptSubmit": return { small: { slot: "ask", sid, k: pr }, full: { slot: "full-ask", sid, k: pr } };
    case "PreToolUse": case "PermissionRequest":
      return tool ? { small: { slot: "step", sid, k: tool }, full: { slot: "full-in", sid, k: tool } } : { small: null, full: null };
    case "PostToolUse": return { small: null, full: tool ? { slot: "full-out", sid, k: tool } : null };
    case "PostToolUseFailure":
      return tool ? { small: { slot: "fail", sid, k: tool }, full: { slot: "full-out", sid, k: tool } } : { small: null, full: null };
    case "SubagentStart": return { small: ev.agent ? { slot: "sub", sid, k: ev.agent } : null, full: null };
    case "Notification": return { small: null, full: { slot: "full-note", sid, k: pr } };
    case "Stop": return { small: { slot: "ans", sid, k: pr }, full: { slot: "full-ans", sid, k: pr } };
    default: return { small: null, full: null };
  }
}
/** 附加校验数据 @param {string} slot @param {string} sid @param {string} k */
export const aadOf = (slot, sid, k) => `agent-loop/${PROTOCOL_VERSION}|${slot}|${sid}|${k}`;

// ---- 模型名：hook 数据里没有（实测）。主对话的在 usageFromTranscript 里顺带取；
// 它取不到时（子 agent 的事件、记录里还没有主对话的回答）从会话记录末尾最后一条回答里取

/** @param {unknown} path @returns {string | undefined} */
export function modelFromTranscript(path) {
  if (!str(path)) return undefined;
  const lines = readLines(path, 64 * 1024, true);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    try {
      const o = JSON.parse(lines[i]);
      const mdl = o && o.type === "assistant" && o.message && o.message.model;
      if (isModel(mdl)) return mdl;
    } catch { /* 第一行可能被截断了 */ }
  }
  return undefined;
}

/** 文件开头（或者 fromEnd：末尾）最多 max 字节，按行拆开。读不了返回 []；头尾那行可能被截断了
 *  @param {string} path @param {number} max @param {boolean} [fromEnd] @returns {string[]} */
function readLines(path, max, fromEnd = false) {
  /** @type {number | undefined} */
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size, buf = Buffer.alloc(Math.min(size, max));
    readSync(fd, buf, 0, buf.length, fromEnd ? size - buf.length : 0);
    return buf.toString("utf8").split("\n");
  } catch { return []; /* 没有这个文件 */ } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

// ---- token 数和对话的标题：hook 数据里也没有，从会话记录里读
//
// ctx：最后一次回答时的上下文大小（输入 + 缓存读 + 缓存写）；out：主对话所有回答的输出 token 加起来。
// 同一条回答在记录里拆成好几条、每条带同一份 usage：按 message.id 只算一次。子 agent 的记录（isSidechain）不算。
// 标题：Claude Code 自己给对话起的（type "ai-title" 的行，第一句话发出后几秒才写进去，之后隔一阵重写一遍）；
// 用 /rename 改过的（type "custom-title"）优先。
// laps：主对话回答了几次（按 message.id 数，Claude Code 自己补的 <synthetic> 回答不算），一次回答就是一圈；
// steps：主对话调用了几次工具（tool_use）。服务器重启过、会话中途才接上时，页面上的累计圈数、步数靠这两个数补回来。
// model：到目前为止主对话最后一条真实回答（不是 <synthetic>）的模型名，SessionStart、Stop 时用，省得再读一遍记录末尾。
// 记录可能有几十 MB：记下读到了哪里（cacheFile），下次从那里接着读。

const USAGE_CHUNK = 1 << 20;
const MAX_TOK = 1e11;
const tokN = (/** @type {unknown} */ v) => (typeof v === "number" && isFinite(v) && v > 0 ? Math.floor(v) : 0);

const TITLE_MAX = 80;
const USAGE_CACHE_V = 4;   // 缓存里加了东西（2：标题，3：圈数、步数，4：模型名）：旧的缓存从头再读一遍，不然已经读过去的就数不到了

/**
 * @param {unknown} path @param {string} [cacheFile]
 * @returns {{ ctx: number, out: number, laps: number, steps: number, model?: string, title?: string, titleNew?: true } | undefined}
 *   titleNew：这次读到的标题和上次读到的不一样（包括第一次读到）
 */
export function usageFromTranscript(path, cacheFile) {
  if (!str(path)) return undefined;
  /** @type {{ v: number, path: string, off: number, out: number, ctx: number, ids: string[], laps: number, steps: number, tools: string[], model: string, ai: string, custom: string }} */
  let st = { v: USAGE_CACHE_V, path: /** @type {string} */ (path), off: 0, out: 0, ctx: 0, ids: [], laps: 0, steps: 0, tools: [], model: "", ai: "", custom: "" };
  if (cacheFile) {
    try {
      const c = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (c && c.v === USAGE_CACHE_V && c.path === path && Number.isInteger(c.off) && c.off >= 0 && Array.isArray(c.ids) && Array.isArray(c.tools)) {
        st = { ...st, ...c, out: tokN(c.out), ctx: tokN(c.ctx), laps: tokN(c.laps), steps: tokN(c.steps),
               model: isModel(c.model) ? c.model : "", ai: str(c.ai) ? c.ai : "", custom: str(c.custom) ? c.custom : "" };
      }
    } catch { /* 第一次 */ }
  }
  const titleBefore = st.custom || st.ai;
  /** @type {number | undefined} */
  let fd;
  const start = st.off;
  try {
    fd = openSync(/** @type {string} */ (path), "r");
    const size = fstatSync(fd).size;
    if (size < st.off) st = { ...st, off: 0, out: 0, ctx: 0, ids: [], laps: 0, steps: 0, tools: [], model: "", ai: "", custom: "" };   // 文件被换掉了：从头读
    const seen = new Set(st.ids), seenTools = new Set(st.tools);
    let pos = st.off, rest = Buffer.alloc(0);
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(USAGE_CHUNK, size - pos));
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const data = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      const nl = data.lastIndexOf(10);
      if (nl < 0) { rest = data; continue; }
      rest = Buffer.from(data.subarray(nl + 1));
      st.off = pos - rest.length;   // 只算到最后一个换行：最后一行可能还没写完
      for (const line of data.subarray(0, nl).toString("utf8").split("\n")) {
        if (line.startsWith('{"type":"ai-title"') || line.startsWith('{"type":"custom-title"')) {
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          const ai = o && o.type === "ai-title", t = ai ? o.aiTitle : o && o.type === "custom-title" ? o.customTitle : undefined;
          if (str(t)) st[ai ? "ai" : "custom"] = clip(t, TITLE_MAX);
          continue;
        }
        if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const m = o && o.type === "assistant" && !o.isSidechain && o.message;
        const u = m && m.usage;
        if (!u || typeof u !== "object") continue;
        const ctx = tokN(u.input_tokens) + tokN(u.cache_read_input_tokens) + tokN(u.cache_creation_input_tokens);
        if (ctx) st.ctx = Math.min(MAX_TOK, ctx);
        const real = m.model !== "<synthetic>";
        if (real && isModel(m.model)) st.model = m.model;
        // 同一条回答拆成好几行，每行一块内容：工具调用按它自己的编号数
        if (real && Array.isArray(m.content)) {
          for (const b of m.content) {
            if (!b || b.type !== "tool_use") continue;
            const tid = str(b.id) ? b.id : "";
            if (tid && seenTools.has(tid)) continue;
            if (tid) { seenTools.add(tid); st.tools.push(tid); if (st.tools.length > 64) st.tools.shift(); }
            st.steps += 1;
          }
        }
        const id = str(m.id) ? m.id : "";
        if (id && seen.has(id)) continue;
        if (id) { seen.add(id); st.ids.push(id); if (st.ids.length > 32) st.ids.shift(); }
        if (real) st.laps += 1;
        st.out = Math.min(MAX_TOK, st.out + tokN(u.output_tokens));
      }
    }
  } catch { return undefined; /* 没有这个文件 */ } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
  if (cacheFile && st.off !== start) {
    try { writeAtomic(cacheFile, JSON.stringify(st)); } catch { /* 写不了：下次从头读 */ }
  }
  const title = st.custom || st.ai;
  if (!st.ctx && !st.out && !st.laps && !st.model && !title) return undefined;
  return { ctx: st.ctx, out: st.out, laps: st.laps, steps: st.steps, ...(st.model ? { model: st.model } : {}), ...(title ? { title } : {}), ...(title && title !== titleBefore ? { titleNew: /** @type {true} */ (true) } : {}) };
}

/** 读到哪里的记录：数据目录下 usage/<哈希后的会话编号>.json，只在本机 @param {string} dir @param {string} sid */
function usageCacheFile(dir, sid) {
  const d = join(dir, "usage");
  try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return join(d, `${sid}.json`);
}

/** 删掉 30 天没动过的：会话结束不删（--resume 沿用原来的会话编号） @param {string} dir */
function pruneUsageCache(dir) {
  const d = join(dir, "usage"), old = Date.now() - 30 * 86400_000;
  try {
    for (const f of readdirSync(d)) {
      try { if (statSync(join(d, f)).mtimeMs < old) unlinkSync(join(d, f)); } catch { /* ignore */ }
    }
  } catch { /* 还没有 */ }
}

/** 邀请链接里的密钥（k= 后面 43 个字符） */
const KEY_IN_TEXT = /(\bk=)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

/**
 * 把 hook 数据里出现的邀请密钥抹掉（换成 k=…）。接入、换群时那几行命令、粘进来的邀请链接、回答里复述的链接都带着
 * 新群的密钥：不抹掉的话，档位 2 会把它（用旧群的密钥加密）发给旧群，旧群的人就能拿它进新群。没有就原样返回
 * @param {any} hook @returns {any}
 */
export function scrubKeys(hook) {
  return scrubbed(hook).hook;
}

/** scrubKeys，顺带给出抹完以后的 JSON 文本（序列化不了是 ""） @param {any} hook @returns {{ hook: any, text: string }} */
function scrubbed(hook) {
  let text;
  try { text = JSON.stringify(hook); } catch { return { hook, text: "" }; }
  if (!text || text.search(KEY_IN_TEXT) < 0) return { hook, text: text ?? "" };
  text = text.replace(KEY_IN_TEXT, "$1…");
  return { hook: JSON.parse(text), text };
}

/**
 * 从原始 hook 数据挑出允许的字段，重新拼一条事件。返回 null 表示这条不发。
 * 这是白名单：下面没写到的字段一律不出去，Claude Code 以后新增的字段默认也不会被传出去。
 * 附件按档位附上：本机是明文（detail、detail_full），非本机用 ctx.key 加密（enc、enc_full），没有 key 就不附。
 * @param {any} hook 原始 hook 数据
 * @param {{ salt: string, level: Level, local?: boolean, key?: Buffer, gid?: string, me?: string, projectDir?: string, now?: number,
 *           readModel?: (path: unknown) => string | undefined,
 *           readUsage?: (path: unknown, sid: string) => { ctx: number, out: number, laps?: number, steps?: number, model?: string, title?: string, titleNew?: true } | undefined }} ctx
 * @returns {OutEvent | null}
 */
export function buildEvent(hook, ctx) {
  if (!hook || typeof hook !== "object") return null;
  const clean = scrubbed(hook);
  hook = clean.hook;
  const name = hook.hook_event_name;
  if (!EVENT_NAMES.includes(name) || !str(hook.session_id)) return null;
  const H = (/** @type {string} */ v) => hash16(ctx.salt, v);
  const dir = str(ctx.projectDir) ? ctx.projectDir : str(hook.cwd) ? hook.cwd : "";

  /** @type {OutEvent} */
  const out = {
    v: PROTOCOL_VERSION, level: ctx.level, ev: name, ts: Math.floor(ctx.now ?? Date.now()),
    sid: H(hook.session_id), proj: H(normDir(dir)),
  };
  if (str(hook.agent_id)) out.agent = H(hook.agent_id);
  if (str(hook.prompt_id)) out.prompt = H(hook.prompt_id);
  if (str(hook.tool_use_id)) out.tool = H(hook.tool_use_id);
  if (TOOL_EVENTS.has(name)) out.kind = toolKind(hook.tool_name);
  if ((name === "PostToolUse" || name === "PostToolUseFailure") && typeof hook.duration_ms === "number"
      && isFinite(hook.duration_ms) && hook.duration_ms >= 0) out.duration_ms = Math.min(1e9, Math.round(hook.duration_ms));
  if (name === "PostToolUseFailure" && hook.is_interrupt === true) out.interrupt = true;
  if (name === "SessionStart" && SESSION_SOURCES.includes(hook.source)) out.source = hook.source;
  // 会话记录里的 token 数、圈数、步数、模型名、标题：只看主对话
  const u = (name === "SessionStart" || name === "Stop" || name === "PostToolBatch" || name === "UserPromptSubmit") && !out.agent && ctx.readUsage
    ? ctx.readUsage(hook.transcript_path, out.sid) : undefined;
  if (name === "SessionStart" || name === "Stop") {
    // 模型名：hook 数据给了就用；没给先用上面读到的；还没有（子 agent 的事件、主对话还没回答过）再读记录末尾
    if (isModel(hook.model)) out.model = hook.model;
    else if (u && isModel(u.model)) out.model = u.model;
    else if (ctx.readModel) { const mdl = ctx.readModel(hook.transcript_path); if (mdl) out.model = mdl; }
  }
  /** 对话的标题（会话记录里 Claude Code 起的）：附件，下面按档位附上 @type {string} */
  let title = "";
  if (u) {
    // token 数：只是两个数，和模型名一样原样发
    if (name !== "UserPromptSubmit") { if (u.ctx) out.ctx_tok = u.ctx; if (u.out) out.out_tok = u.out; }
    // 记录里已有的圈数、步数：也只是两个数。每圈结束时不带（那时记录里有正在跑的这一圈，服务器只在没有圈在跑时用它）
    if (name !== "PostToolBatch") { if (u.laps) out.laps = u.laps; if (u.steps) out.steps = u.steps; }
    // 标题：会话开始、每次提问、每次回答完都带上（服务器重启过也能补回来）；每一圈结束时只在它变了的时候带
    if (u.title && (name !== "PostToolBatch" || u.titleNew)) title = u.title;
  }
  if (name === "Notification" && NOTIFICATION_TYPES.includes(hook.notification_type)) out.ntype = hook.notification_type;
  if (name === "Stop") out.bg = Array.isArray(hook.background_tasks) ? Math.min(1000, hook.background_tasks.length) : 0;
  if (name === "StopFailure") out.err_kind = errorKind(hook.error);
  // 子 agent 的类型和它的哈希：派遣（PreToolUse）和起来的子 agent 算的必须一样，服务器靠它配对
  const agentType = (/** @type {string} */ t) => { out.agent_type = BUILTIN_AGENT_TYPES.includes(t) ? t : "custom"; out.agent_type_h = H("agent-type:" + t); };
  if ((name === "SubagentStart" || name === "SubagentStop") && str(hook.agent_type)) agentType(hook.agent_type);
  if (name === "PreToolUse" && out.kind === "agent" && !out.agent) {
    // 派子 agent：对要派的类型算同样的哈希。没写类型就是 general-purpose
    const inp = hook.tool_input && typeof hook.tool_input === "object" ? hook.tool_input : {};
    agentType(str(inp.subagent_type) ? inp.subagent_type : "general-purpose");
  }
  if (name === "UserPromptSubmit") {
    // 输入的话只留一个布尔值：是不是后台任务（或后台子 agent）跑完的通知
    const p = typeof hook.prompt === "string" ? hook.prompt.trimStart() : "";
    out.task_note = p.startsWith("<task-notification") || p.startsWith("<agent-message");
  }
  // ---- 附件
  if (ctx.level >= 1 && (ctx.local || ctx.key)) {
    const dctx = { me: ctx.me, projectDir: ctx.projectDir, taskNote: out.task_note === true };
    const slots = slotsOf(out, ctx.gid);
    const small = slots.small ? smallDetail(hook, name, dctx) : null;
    const full = ctx.level >= 2 && slots.full ? fullDetail(hook, name, dctx) : undefined;
    if (ctx.local) {
      if (small) out.detail = small;
      if (full !== undefined) out.detail_full = full;
    } else if (ctx.key) {
      if (small && slots.small) out.enc = seal(ctx.key, small, aadOf(slots.small.slot, slots.small.sid, slots.small.k));
      if (full !== undefined && slots.full) out.enc_full = seal(ctx.key, full, aadOf(slots.full.slot, slots.full.sid, slots.full.k));
    }
    // 每次提问补发名片（和 SessionStart 的小附件同一个槽、同样的内容）：会话开始那条事件没送到时
    // （服务器重启过、会话中途才设好插件），项目名和星系名靠它补上。子 agent 的事件不带
    if (name === "UserPromptSubmit" && !out.agent) {
      const card = smallDetail(hook, "SessionStart", dctx);
      if (card && ctx.local) out.card = card;
      else if (card && ctx.key) out.enc_card = seal(ctx.key, card, aadOf("card", ctx.gid ?? "", out.proj));
    }
    // 对话的标题：槽 title，键为空（一个会话只有一个标题）
    const t = title ? fitSmall({ label: title }) : null;
    if (t && ctx.local) out.title = t;
    else if (t && ctx.key) out.enc_title = seal(ctx.key, t, aadOf("title", out.sid, ""));
  }
  if (ctx.local && ctx.level === 2) out.raw = clean.text.length > RAW_MAX_BYTES ? clipDeep(hook, 2000) : hook;
  return out;
}

// ---- 插件数据目录里的小文件（server.json、left.json、moved.json、stale.json、sweep.json、status.json、hello.json）

/** 先写临时文件再换上去：同时跑的 hook 读不到写了一半的文件。写不了就抛出 @param {string} file @param {string} text */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** 读 <dir>/<name>，没有或读不懂返回 null @param {string} dir @param {string} name @returns {any} */
function readJson(dir, name) {
  try { return JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { return null; }
}

/** 写 <dir>/<name>（权限 0600）。写不了就抛出 @param {string} dir @param {string} name @param {unknown} value */
function writeJson(dir, name, value) {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, name), JSON.stringify(value) + "\n");
}

/** 星系群编号 */
const GROUP_RE = /^[0-9a-f]{32}$/;

/**
 * 存在 <dir>/<name> 的 { [field]: string[] } 里的一组记号（最多 max 个，新的在后面）：left.json、moved.json、hello.json
 * @param {string} name @param {string} field @param {number} max @param {(x: string) => boolean} ok
 */
function markList(name, field, max, ok) {
  /** @param {string} dir @returns {string[]} */
  const list = dir => {
    const g = readJson(dir, name)?.[field];
    return Array.isArray(g) ? g.filter(x => typeof x === "string" && ok(x)) : [];
  };
  return {
    list,
    /** 记下（on）或者去掉（!on）一个记号。没变就不写，返回 false；写不了就抛出 @param {string} dir @param {string} key @param {boolean} on */
    set(dir, key, on) {
      const was = list(dir);
      if (was.includes(key) === on) return false;
      const now = was.filter(x => x !== key);
      if (on) now.push(key);
      writeJson(dir, name, { [field]: now.slice(-max) });
      return true;
    },
  };
}

// ---- 身份

/**
 * 第一次运行时生成安装密钥和本机的盐。同时触发的几个 hook 进程可能一起来建：
 * 先写临时文件再用硬链接放到位（已存在就失败），保证谁也读不到写了一半的文件。
 * @param {string} dir
 * @returns {{ secret: string, salt: string }}
 */
export function loadIdentity(dir) {
  const file = join(dir, "identity.json");
  const read = () => {
    const d = JSON.parse(readFileSync(file, "utf8"));
    if (!/^[0-9a-f]{64}$/.test(d.secret) || !/^[0-9a-f]{32}$/.test(d.salt)) throw new Error("bad identity");
    return { secret: d.secret, salt: d.salt };
  };
  try { return read(); } catch { /* 还没有，或者正被别人写 */ }
  mkdirSync(dir, { recursive: true });
  const fresh = { secret: randomBytes(32).toString("hex"), salt: randomBytes(16).toString("hex") };
  const body = JSON.stringify(fresh) + "\n";
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    try {
      linkSync(tmp, file);
      return fresh;
    } catch (e) {
      if (/** @type {any} */ (e).code !== "EEXIST") {
        // 文件系统不支持硬链接：退回独占创建
        try {
          const fd = openSync(file, "wx", 0o600);
          writeSync(fd, body); closeSync(fd);
          return fresh;
        } catch { /* 别人先建好了 */ }
      }
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
  // 别人先建好了：读它的。独占创建的那条路可能还没写完，稍等再读
  for (let i = 0; i < 20; i++) {
    try { return read(); } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
  return read();
}

/** 插件数据目录：hook 里是 CLAUDE_PLUGIN_DATA；拿不到时（命令正文里的 ${CLAUDE_PLUGIN_DATA} 没被替换）用同一个目录 */
export function dataDir() {
  const env = process.env.CLAUDE_PLUGIN_DATA;
  return env && !env.startsWith("${") ? env : installedDataDir();
}

/**
 * 插件设置。Claude Code 以 CLAUDE_PLUGIN_OPTION_<KEY> 传进来；没设过时什么都不传（实测）。
 *   server_url：本机地址，或者一条邀请链接（https://<服务器>/#k=<K>）
 *   share：auto（默认）、anonymous、summary、full
 *   name：星系的名字，空着就用自动生成的星表编号
 * @param {Record<string, string | undefined>} [env]
 */
export function settings(env = process.env) {
  const opt = (/** @type {string} */ k) => { const v = (env[`CLAUDE_PLUGIN_OPTION_${k}`] || "").trim(); return v && !v.startsWith("${") ? v : ""; };
  return { target: parseTarget(opt("SERVER_URL")), share: opt("SHARE"), me: opt("NAME").slice(0, 40) };
}

/**
 * 把 server_url 拆成服务器地址和邀请链接里的 K。#k= 之后的部分只在本机用，不会发给服务器
 * @param {string} v @returns {{ url: string, k: string | null }}
 */
export function parseTarget(v) {
  const raw = (v || "").trim() || DEFAULT_SERVER_URL;
  const hash = raw.indexOf("#");
  const base = (hash >= 0 ? raw.slice(0, hash) : raw).replace(/\/+$/, "");
  const m = hash >= 0 ? /(?:^|[#&])k=([A-Za-z0-9_-]+)/.exec(raw.slice(hash)) : null;
  return { url: base || DEFAULT_SERVER_URL, k: m ? m[1] : null };
}

/**
 * 记下最近一次用的 server_url，给 /galaxy 用：server_url 是敏感设置（邀请链接里有密钥），存在系统的凭据存储里，
 * 命令正文里拿不到（实测）。文件在插件数据目录里，权限 0600，和安装密钥放在一起。变了才写
 * @param {string} dir @param {string} value
 */
export function rememberTarget(dir, value) {
  if (rememberedTarget(dir) === value) return;
  try { writeJson(dir, "server.json", { server_url: value }); } catch { /* 写不了：/galaxy 退回默认地址 */ }
}

/** @param {string} dir @returns {string} */
function rememberedTarget(dir) {
  const v = readJson(dir, "server.json")?.server_url;
  return typeof v === "string" ? v : "";
}

// ---- 退出星系群（/agent-loop:leave）
//
// server_url 是敏感设置，命令里改不了它。所以退出是在插件数据目录里记一笔（left.json，存星系群编号），
// 每个 hook 发送前都看：目标是退出过的群就不发。这样所有窗口里的会话立刻都停，不用重载；
// 改设置以前开的旧会话拿着旧的邀请链接，也不会把星系又带回群里。想回去用 /agent-loop:rejoin。

const LEFT = markList("left.json", "groups", 20, x => GROUP_RE.test(x));

/** 退出过的星系群编号 @param {string} dir @returns {string[]} */
export const leftGroups = LEFT.list;

/** 记下（on）或者去掉（!on）一个退出过的星系群。写不了就抛出 @param {string} dir @param {string} group @param {boolean} on */
export const markLeft = (dir, group, on) => void LEFT.set(dir, group, on);

/** 星系群的指纹：编号开头 16 个字符，四个一组（和页面上的一样，用来核对是哪个群） @param {string} group */
export const fingerprint = group => (group.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");

/** 告诉服务器这个星系退出了（只能移走自己）。返回 HTTP 状态码，连不上返回 "unreachable"
 *  @param {string} url @param {string} secret @param {string} access */
export async function sendLeave(url, secret, access) {
  try {
    const res = await fetch(url + "/v1/leave", {
      method: "POST", headers: { authorization: `Bearer ${secret}`, "x-group": access, "x-agent-loop-plugin": PLUGIN_VERSION },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await res.arrayBuffer().catch(() => {});
    return res.status;
  } catch { return "unreachable"; }
}

/**
 * /agent-loop:leave 和 /agent-loop:rejoin。输出会进对话、发给模型：只有服务器地址和指纹，不带密钥
 * 退出以后在浏览器里打开这个群的页面（#left=<群编号前 16 位>，服务器没收到时加 &kept）：页面认出浏览器里存着的是这个群的密钥
 * 就清掉，连同「我的星系」的记号，再显示已经退出了。网址里没有密钥（群编号的前 16 位就是页面上人人看得到的指纹）。
 * 服务器连不上时页面也打不开；比 LEFT_SINCE 旧的页面不认 #left=，打开了反而接着显示这个群：这两种都不开
 * @param {"leave" | "rejoin"} what @param {string} dir @param {string} value server_url 的值
 * @param {((url: string) => boolean) | null} [open] 打开浏览器；null 表示不打开（--no-open）
 * @returns {Promise<string>}
 */
export async function leaveOrRejoin(what, dir, value, open = null) {
  const target = resolveTarget(dir, value), keys = target.keys, left = target.block === "left";
  // 本机地址不算在群里；只有带着 #k= 又退出过（hook 照样不发，见 resolveTarget）时也认：不然 rejoin 回不去
  if (!keys || (target.local && !left)) return `Not in a galaxy group: server_url is ${target.url}${target.k && !keys ? " (with an incomplete invite link)" : ""}. Nothing to ${what === "leave" ? "leave" : "rejoin"}.`;
  const fp = fingerprint(keys.group);
  if (what === "rejoin") {
    if (!left) return `Already in galaxy group ${fp} on ${target.url}: this computer is reporting to it.`;
    markLeft(dir, keys.group, false);
    return `Rejoined galaxy group ${fp} on ${target.url}. Your galaxy shows up again with the next step in any session.`;
  }
  markLeft(dir, keys.group, true);
  const status = await sendLeave(target.url, loadIdentity(dir).secret, keys.access);
  const server = status === 204 ? "Your galaxy was removed from the group on the server, together with the full step details stored there."
    : `The server could not be told (${status === "unreachable" ? "unreachable" : `HTTP ${status}`}); your galaxy stays visible in the group until its sessions time out on the server (shown as possibly closed after 30 minutes, gone within about 2 hours). Run /agent-loop:leave again once the server is reachable to remove it right away.`;
  let page = 'Browsers that opened the invite link can still watch the group until they choose "Clear cache" under Invite on the page.';
  if (open && status !== "unreachable") {
    const v = serverVersion(await serverHealth(target.url));
    if (!newPage(v, LEFT_SINCE)) page = `This server's page (${v || `before ${LEFT_SINCE}`}) cannot clear the group from a browser by itself: in browsers that opened the invite link, choose "Clear cache" under Invite on the page.`;
    else if (open(`${target.url}/#left=${keys.group.slice(0, 16)}${status === 204 ? "" : "&kept"}`))
      page = 'Opened the group\'s page in your browser: it clears this group\'s key from that browser and shows that you left. Other browsers that opened the invite link can still watch the group until they choose "Clear cache" under Invite on the page.';
  }
  return `Left galaxy group ${fp} on ${target.url}. No session on this computer reports to it any more (no reload needed). ${server}\n` +
    `server_url still holds the invite link. ${BACK_HOME} To rejoin this group later, run /agent-loop:rejoin. ${page}`;
}

// ---- 换过群：旧设置的会话不再发（moved.json）
//
// 接入命令（--welcome）把 server_url 换成新的邀请链接，可已经开着的会话（包括跑这条命令的这个）在 /reload-plugins 以前
// 拿的还是旧值：它们的 hook 照样拿同一个安装密钥报给旧群，服务器每收到一条就把星系在两个群之间搬一次，还会把 server.json
// 改回旧链接。所以 --welcome 把旧的目标记下来，拿着它的 hook 不发、不记地址。
// 新开的会话（SessionStart 的 startup）拿的一定是当前的设置：它还是旧值，说明用户又改回去了，去掉记号照常发。

const MOVED = markList("moved.json", "from", 20, x => x.length <= 400);

/** 一个目标的记号：星系群用群编号，别的用地址 @param {{ url: string, k: string | null }} target */
export function targetKey(target) {
  const keys = target.k ? deriveKeys(target.k) : null;
  return markOf(target.url, keys ? keys.group : null);
}
/** @param {string} url @param {string | null} group */
const markOf = (url, group) => group ? `g:${group}` : `u:${url}`;

/** 换走了的目标（targetKey） @param {string} dir @returns {string[]} */
export const movedFrom = MOVED.list;

/** 记下（on）或者去掉（!on）一个换走了的目标。没变就不写；写不了就抛出 @param {string} dir @param {string} key @param {boolean} on */
export const markMoved = (dir, key, on) => void MOVED.set(dir, key, on);

const STALE_EVERY_MS = 30_000;
/** 记下「刚才还有旧设置的会话在跑」（hook 因为 resolveTarget 的 moved 没发）。/agent-loop:status 据此提醒 /reload-plugins。
 *  半分钟内记过就不再写 @param {string} dir @param {number} [now] */
export function noteStale(dir, now = Date.now()) {
  if (now - staleSeen(dir) < STALE_EVERY_MS) return;
  try { writeJson(dir, "stale.json", { at: now }); } catch { /* 写不了就算了 */ }
}
/** 上次看到旧设置的会话是什么时候（毫秒），没有是 0 @param {string} dir @returns {number} */
export function staleSeen(dir) {
  const t = readJson(dir, "stale.json")?.at;
  return typeof t === "number" && isFinite(t) ? t : 0;
}

/** @param {any} hook */
const isStartup = hook => !!hook && hook.hook_event_name === "SessionStart" && hook.source === "startup";

// ---- 这个目标能不能报
//
// hook 发不发、--check 和命令说什么，都从 resolveTarget 的 block 来，规则只有这一份：
//   moved  换走了的旧设置（moved.json）。只有 hook 算：新开的会话（SessionStart 的 startup）不算，命令里没有 hook 也不算
//   scheme 地址不是 http:// 或 https:// 开头
//   nokey  发往别处却没有邀请链接（#k=）
//   badkey 邀请链接不完整（密钥不是 43 个字符）
//   left   退出过这个星系群（left.json）。不管本机不本机：带着完整的 #k= 就派生密钥、查 left.json
// 本机地址没有 #k=（或者 #k= 不完整）时不算在哪个群里，照常发明文

/**
 * @typedef {null | "moved" | "scheme" | "nokey" | "badkey" | "left"} Block
 * @typedef {{ url: string, k: string | null, keys: ReturnType<typeof deriveKeys>, local: boolean, group: string | null, block: Block }} Resolved
 */

/**
 * 只读（不写文件）。value 是 server_url 的值，或者已经拆开的（parseTarget）；hook 只有 hook 里给
 * @param {string} dir @param {string | { url: string, k: string | null }} value @param {any} [hook] @returns {Resolved}
 */
export function resolveTarget(dir, value, hook) {
  const { url, k } = typeof value === "string" ? parseTarget(value) : value;
  const local = isLocal(url), keys = k ? deriveKeys(k) : null, group = keys ? keys.group : null;
  /** @type {Block} */
  let block = null;
  if (hook !== undefined && !isStartup(hook) && movedFrom(dir).includes(markOf(url, group))) block = "moved";
  else if (!hasScheme(url)) block = "scheme";
  else if (!local && !k) block = "nokey";
  else if (!local && !keys) block = "badkey";
  else if (group && leftGroups(dir).includes(group)) block = "left";
  return { url, k, keys, local, group, block };
}

/** 想改回本机时怎么改（几处提示都用这一句） */
const BACK_HOME = `To report to this computer instead, set server_url back to ${DEFAULT_SERVER_URL} with /plugin configure ${PLUGIN_ID}.`;
/** 设置不对时怎么改 */
const FIX_LINK = "Paste the whole invite link (…/#k=…) into the Agent Loop plugin's server_url setting, then run /reload-plugins.";

/**
 * 不能报时的那句话（英文，不带开头：hook 的提示前面加「Agent Loop is not reporting: 」，命令各有各的开头）。
 * 会显示在 Claude Code 里、进对话：只有服务器地址和指纹，不带密钥
 * @param {Exclude<Block, null>} block @param {Resolved} target @returns {string}
 */
export function blockMessage(block, target) {
  const { url } = target;
  switch (block) {
    case "moved":
      return `this session still has the old server_url (${url}) from before you joined another galaxy group, so it is not reporting. Run /reload-plugins to switch it over. (If you switched back to ${url} on purpose, open a new session.)`;
    // 漏了 http://：不替人补（补错成 http:// 会把口令明文发出去），照实说
    case "scheme": return `server_url must start with http:// or https:// (it is "${url}"). ${FIX_LINK}`;
    case "nokey": return `server_url points to ${url} but has no group key. ${FIX_LINK}`;
    case "badkey": return `the invite link in server_url is incomplete (the key after #k= must be 43 characters). ${FIX_LINK}`;
    case "left":
      return `you left galaxy group ${fingerprint(target.group ?? "")} on ${url} with /agent-loop:leave, so this computer sends nothing to it and your galaxy is not shown there. ` +
        `To go back to that group, run /agent-loop:rejoin. ${BACK_HOME}`;
  }
}

/**
 * 旧设置的会话结束了：把 SessionEnd 发给现在的目标（server.json 记着的）。
 * 跑 /agent-loop:create 或接入命令的会话已经作为 SessionStart 报进了新群，可它自己拿着旧设置、之后什么都不发；
 * 没有这条 SessionEnd，新群里这颗行星要等两小时才移除（半小时后才变暗），看着像多了一个会话。
 * 没报进新群的旧会话：服务器上没有这个会话，SessionEnd 直接忽略
 * @param {string} dir @param {any} hook @param {string} share @param {string} me
 */
async function endInCurrent(dir, hook, share, me) {
  const value = rememberedTarget(dir);
  if (!value) return;
  const target = resolveTarget(dir, value, hook);
  if (target.block) return;
  const r = reporter(dir, target, { share, me, projectDir: process.env.CLAUDE_PROJECT_DIR });
  const ev = r.build(hook);
  if (ev) await r.send(ev, SESSION_END_TIMEOUT_MS);
}

// ---- 替结束了却没送出 SessionEnd 的会话补发（sweep.json）
//
// SessionEnd 送不到的会话（点 × 关了窗口、进程崩了、发送超时、旧版插件把它拦下了、服务器升级后不收旧格式）在群里要挂两个
// 小时才被服务器移除，看着像多了一个会话。那个会话自己已经不在了，只能由还活着的会话（跑着新插件）替它发，服务器新旧都认。
// Claude Code 在 <配置目录>/sessions/<进程号>.json 里登记正在跑的会话（交互的和 claude -p 都有，正常退出时删掉）：
// 不在登记里、或者登记的进程已经没了的，就是结束了。候选是插件报过（usage/ 缓存里有）、最近两小时（服务器移除会话的时间）动过的会话记录。
// 登记是 Claude Code 内部的文件，所以很保守：登记里找不到自己这个会话（这个版本不登记、换了格式）、有登记读不懂，就不扫；
// 记录刚动过不到一分钟的不算（可能刚开、还没登记）。宁可不清，不能把开着的会话从页面上拿掉

/** Claude Code 的会话编号（会话记录的文件名） */
const SID_RE = /^[A-Za-z0-9-]{1,80}$/;

const SWEEP_EVERY_MS = 60_000, SWEEP_QUIET_MS = 60_000, SWEEP_WINDOW_MS = 2 * 3600_000, SWEEP_MAX = 30;

/** 进程还在不在。没权限看（EPERM）也是在 @param {number} pid */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e)?.code === "EPERM"; }
}

/**
 * Claude Code 登记着、进程还在的会话编号。没有登记目录、有一个读不懂：返回 null（不知道，别扫）
 * @param {string} cfg @param {(pid: number) => boolean} [isAlive] @returns {Set<string> | null}
 */
export function liveSessions(cfg, isAlive = alive) {
  /** @type {string[]} */
  let names;
  try { names = readdirSync(join(cfg, "sessions")); } catch { return null; }
  const live = new Set();
  for (const f of names) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const o = JSON.parse(readFileSync(join(cfg, "sessions", f), "utf8"));
      if (typeof o.sessionId !== "string" || !Number.isInteger(o.pid) || o.pid <= 0) return null;
      if (isAlive(o.pid)) live.add(o.sessionId);
    } catch (e) {
      if (/** @type {any} */ (e)?.code === "ENOENT") continue;   // 读的时候刚好退出、删掉了
      return null;   // 正在写、格式变了：这次不扫
    }
  }
  return live;
}

/**
 * 最近 SWEEP_WINDOW_MS 内动过、又安静了 SWEEP_QUIET_MS 以上的会话和记录最后动的时间。
 * 候选只从插件自己的 usage/ 缓存来（插件报过的会话；没报过的服务器上本来就没有，不用补）：缓存里记着会话记录的路径，
 * 文件名 <编号>.jsonl 就是原始会话编号。缓存本身 SWEEP_WINDOW_MS 以前就没动过的不看，剩下的才 stat 会话记录
 * @param {string} dir 插件数据目录 @param {number} now @returns {{ sid: string, mtime: number }[]}
 */
export function recentSessions(dir, now) {
  const root = join(dir, "usage");
  /** @type {{ sid: string, mtime: number }[]} */
  const out = [];
  const seen = new Set();
  /** @type {string[]} */
  let files;
  try { files = readdirSync(root); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const file = join(root, f);
      if (now - statSync(file).mtimeMs >= SWEEP_WINDOW_MS) continue;
      const path = JSON.parse(readFileSync(file, "utf8"))?.path;
      if (!str(path)) continue;
      const name = basename(path);
      if (!name.endsWith(".jsonl")) continue;
      const sid = name.slice(0, -6);
      if (!SID_RE.test(sid) || seen.has(sid)) continue;
      const mtime = statSync(path).mtimeMs, age = now - mtime;
      if (age < SWEEP_WINDOW_MS && age > SWEEP_QUIET_MS) { seen.add(sid); out.push({ sid, mtime }); }
    } catch { /* 缓存读不懂、记录没了：不算 */ }
  }
  return out;
}

/** 上次扫的时间；补发过的会话 → 补发时它的记录最后动的时间（之后又 --resume 过、又动了，就再补一次）
 *  @param {string} dir @returns {{ at: number, done: Record<string, number> }} */
function readSweep(dir) {
  const o = readJson(dir, "sweep.json");
  return { at: typeof o?.at === "number" ? o.at : 0, done: o && typeof o.done === "object" && o.done ? o.done : {} };
}

/** @param {string} dir @param {{ at: number, done: Record<string, number> }} s */
function writeSweep(dir, s) {
  try { writeJson(dir, "sweep.json", s); } catch { /* 写不了：下次再扫一遍，服务器对没有的会话的 SessionEnd 什么都不做 */ }
}

/**
 * 找出结束了的会话，给 send 补发 SessionEnd（每个只发一次）。返回补发了哪些会话编号
 * @param {object} o
 * @param {string} o.dir 插件数据目录 @param {string} o.cfg Claude Code 的配置目录 @param {string} o.self 跑这个 hook 的会话
 * @param {(sid: string) => Promise<unknown>} o.end 发一条 SessionEnd
 * @param {number} [o.now] @param {(pid: number) => boolean} [o.isAlive]
 * @returns {Promise<string[]>}
 */
export async function sweepEnded({ dir, cfg, self, end, now = Date.now(), isAlive = alive }) {
  const state = readSweep(dir);
  if (now - state.at < SWEEP_EVERY_MS) return [];
  const live = liveSessions(cfg, isAlive);
  if (!live || !live.has(self)) return [];
  for (const [sid, t] of Object.entries(state.done)) if (typeof t !== "number" || now - t > SWEEP_WINDOW_MS) delete state.done[sid];
  const gone = recentSessions(dir, now)
    .filter(x => x.sid !== self && !live.has(x.sid) && !(state.done[x.sid] >= x.mtime)).slice(0, SWEEP_MAX);
  for (const x of gone) state.done[x.sid] = x.mtime;
  state.at = now;
  writeSweep(dir, state);   // 先记下：同时跑的 hook 不再发一遍
  await Promise.all(gone.map(x => end(x.sid).catch(() => {})));
  return gone.map(x => x.sid);
}

// ---- 上报不出去时告诉用户
//
// 异步 hook 失败时 Claude Code 什么都不显示（实测），设错了 server_url 的人只会觉得「装了没用」。
// 所以每次发送后把结果记进 status.json（变了才写），会话开始时检查设置和上次的结果，有问题就在 Claude Code 里提示一行。

/**
 * 记下这次发送的结果。status：HTTP 状态码，或者 "unreachable"（连不上、超时）
 * @param {string} dir @param {string} url 服务器地址（不含 #k=） @param {number | "unreachable"} status
 */
export function recordStatus(dir, url, status) {
  const d = lastStatus(dir);
  if (d && d.url === url && d.status === status) return;
  try { writeJson(dir, "status.json", { url, status }); } catch { /* 写不了就算了 */ }
}

/** @param {string} dir @returns {{ url: string, status: number | "unreachable" } | null} */
export function lastStatus(dir) {
  const d = readJson(dir, "status.json");
  return d && typeof d.url === "string" && (typeof d.status === "number" || d.status === "unreachable") ? d : null;
}

/** 现在的设置或者上次的发送有没有问题（见 reportProblem），Node 太旧优先 @param {string} dir @param {Resolved} target */
export function currentProblem(dir, target) {
  return nodeProblem(process.versions.node) ?? reportProblem(target, lastStatus(dir));
}

/** 插件要的最低 Node 版本（自带的 fetch、AbortSignal.timeout） */
export const MIN_NODE = 18;
/**
 * Node 太旧：fetch 不存在，每次发送都会失败，却会被记成「连不上服务器」。会话开始时直接说清楚
 * @param {string} version process.versions.node @returns {string | null}
 */
export function nodeProblem(version) {
  const major = Number(String(version).split(".")[0]);
  return major >= MIN_NODE ? null : `Agent Loop is not reporting: it needs Node.js ${MIN_NODE} or newer, but \`node\` here is ${version}. Install a newer Node.js, then start a new session.`;
}

/** server_url 是不是以 http:// 或 https:// 开头 @param {string} url */
export const hasScheme = url => /^https?:\/\//i.test(url);

/**
 * 设置或者上次的发送有没有问题。没问题返回 null；有问题返回给用户看的一行字（英文，和插件别的输出一样）。
 * 这行字会显示在 Claude Code 里，也可能进对话：不能带密钥
 * @param {Resolved} target resolveTarget 的结果 @param {{ url: string, status: number | "unreachable" } | null} last
 */
export function reportProblem(target, last) {
  const { url, block } = target;
  if (block === "moved") return `Agent Loop: ${blockMessage(block, target)}`;
  if (block) return `Agent Loop is not reporting: ${blockMessage(block, target)}`;
  // 上次的结果只对同一个地址算数：换过地址就等下一次发送
  if (!last || last.url !== url) return null;
  const s = last.status;
  if (s === "unreachable") {
    return target.local
      ? `Agent Loop could not reach ${url} last time. To watch on this computer, run \`npx agent-loop\`. To join a galaxy group instead, paste its invite link (…/#k=…) into the plugin's server_url setting.`
      : `Agent Loop could not reach ${url} last time. Check that the server is running and reachable from this computer.`;
  }
  if (s === 401 || s === 403) return `Agent Loop: ${url} refused the reports (HTTP ${s}). The invite link may be wrong, or this server only accepts certain galaxy groups. ${FIX_LINK}`;
  if (s === 400) return `Agent Loop: ${url} rejected the reports (HTTP 400). The plugin and the server may be different versions: update the plugin.`;
  return null;
}

// ---- 第一次接上一个星系群时，让 Claude 跟用户讲清楚
//
// 页面上发给 Claude Code 的那段话只有一两句（装插件、提醒重载），说明都在这里：插件生效以后，用户在新接上的
// 星系群里第一次说话时（同步的 UserPromptSubmit hook，会话开始时 Claude 还不会开口），把这段作为上下文交给 Claude，
// 让它顺带讲一遍会分享什么、怎么加密，问要不要改名字和分享多少。每个星系群只讲一次，记在插件数据目录的 hello.json 里。
// 这段会进对话、发给模型：只有服务器地址和指纹，不带密钥

const HELLO = markList("hello.json", "groups", 20, x => GROUP_RE.test(x));
export const PLUGIN_REPO = "https://github.com/sacryu/agent-loop-plugin";

/** 讲过的星系群编号 @param {string} dir @returns {string[]} */
export const helloGroups = HELLO.list;

/** 每一档分享的内容（给 Claude 讲用），按 shareLevel 的 0、1、2 */
const SHARE_WHAT = [
  ["anonymous", "only anonymous categories and timings (which kind of tool, how long each step took)"],
  ["summary", "the project folder name, session titles, each step's tool and target (file name, start of the command, search terms), the first line of errors and the last sentence of each answer; no full inputs or outputs"],
  ["full", "everything in summary, plus the full prompts, complete tool inputs and outputs, and complete answers"],
];

/**
 * 记下这个星系群讲过了。已经讲过、记不下来（记不下来就不讲：不然每句话都讲一遍）返回 false
 * @param {string} dir @param {string} group
 */
function claimHello(dir, group) {
  try { return HELLO.set(dir, group, true); } catch { return false; }
}

/**
 * 讲的内容：几条要点（英文，交给 Claude 用用户的语言讲）。不带密钥
 * @param {string} url @param {string} share @param {string} me
 */
function helloPoints(url, share, me) {
  const [level, what] = SHARE_WHAT[shareLevel(share, isLocal(url))];
  return [
    "- What it is: Agent Loop draws running Claude Code sessions as a galaxy (each session a planet, each tool call a ray), and people in the group can see each other's.",
    `- What is shared now (share = ${share || "auto"}, which means ${level} for this server): ${what}.`,
    "- Encryption: apart from anonymous categories and timings, everything is encrypted (AES-256-GCM) with the key in the invite link. The key never goes to the server, so the server can't read it; only people with the link can.",
    `- Permissions: the plugin is only hooks plus 5 slash commands. Its hook script picks allowed fields out of each event and sends them; it doesn't change any code and has no dependencies. Source: ${PLUGIN_REPO}`,
    `- Ask whether they want to change their name in the group (now: ${me ? JSON.stringify(me) : "an auto-generated catalog number like ALC 1342+27"}) or how much to share (auto, anonymous, summary, full). Change nothing unless they ask. To change, pipe a JSON with only the keys to change into \`claude plugin configure agent-loop@agent-loop --values-stdin\`, for example {"name":"Alice"} or {"share":"anonymous"}, then remind them to run /reload-plugins.`,
    "- /agent-loop:galaxy opens their galaxy in the browser; /agent-loop:status shows where it reports; /agent-loop:leave takes them out of the group; /agent-loop:create makes a new group of their own.",
  ];
}

/**
 * 要不要讲、讲什么。不在星系群里、设置有问题、退出过、讲过：返回 null。要讲时先记下来（同时开着的几个会话只讲一次）
 * @param {string} dir @param {Resolved} target resolveTarget 的结果 @param {string} share @param {string} me
 * @returns {string | null}
 */
export function helloContext(dir, target, share, me) {
  if (target.block || target.local || !target.group || !claimHello(dir, target.group)) return null;
  return [
    `The Agent Loop plugin just connected this computer to galaxy group ${fingerprint(target.group)} on ${target.url}. This note appears only once.`,
    "Deal with the user's message as usual. In the same reply, add a short note in the user's language (a few lines, no headings) that covers:",
    ...helloPoints(target.url, share, me),
  ].join("\n");
}

// ---- 接入：页面上发给 Claude Code 的那段话的最后一行（--welcome）
//
// 装插件、设好邀请链接以后，hook 要等用户执行 /reload-plugins（或开新会话）才生效，而 Claude 执行不了斜杠命令。
// 所以那段话最后让 Claude 直接跑一次这个脚本（从插件市场的目录，路径是固定的）：
//   - 把正在跑的这个会话（Claude Code 给 Bash 的 CLAUDE_CODE_SESSION_ID）作为一次 SessionStart 报上去：星系马上出现，
//     用的是和 hook 一样的安装密钥、盐、项目目录（从会话记录里读），重载以后 hook 发来的事件接着画在同一颗行星上
//   - 带着密钥在浏览器里打开自己的星系（&welcome：页面飞进去，弹一张欢迎卡片）
//   - 把说明（和第一次说话时 hook 交给 Claude 的同一份要点）打印出来交给 Claude，并记下讲过了，hook 不再讲
// 这个命令不是 hook，拿不到 CLAUDE_PLUGIN_OPTION_*：地址从参数来，share、name 从用户级 settings.json 的 pluginConfigs 读。
// 输出会进对话：不带密钥

/** Claude Code 的配置目录 @param {Record<string, string | undefined>} [env] */
export function configDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** 插件装好以后 Claude Code 给它的数据目录（hook 里的 CLAUDE_PLUGIN_DATA）：<配置目录>/plugins/data/<插件>-<市场> */
export function installedDataDir(cfg = configDir()) {
  return join(cfg, "plugins", "data", PLUGIN_ID.replace("@", "-"));
}

/** 用户级设置里插件的 share、name（不敏感的设置存在这里，实测） @param {string} cfg */
export function savedOptions(cfg) {
  try {
    const o = JSON.parse(readFileSync(join(cfg, "settings.json"), "utf8")).pluginConfigs?.[PLUGIN_ID]?.options ?? {};
    return { share: typeof o.share === "string" ? o.share.trim() : "", me: typeof o.name === "string" ? o.name.trim().slice(0, 40) : "" };
  } catch { return { share: "", me: "" }; }
}

/** 装着的插件版本（installed_plugins.json）；没装返回 "" @param {string} cfg */
export function installedVersion(cfg) {
  try {
    const e = JSON.parse(readFileSync(join(cfg, "plugins", "installed_plugins.json"), "utf8")).plugins?.[PLUGIN_ID];
    const v = Array.isArray(e) ? e.find(x => x && typeof x.version === "string")?.version : undefined;
    return typeof v === "string" ? v : "";
  } catch { return ""; }
}

/** a 比 b 旧（只比数字段） @param {string} a @param {string} b */
export function olderThan(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x < y; }
  return false;
}

/** 这个会话的记录：<配置目录>/projects/<任意>/<会话编号>.jsonl。找不到返回 "" @param {string} cfg @param {string} sid */
export function findTranscript(cfg, sid) {
  if (!SID_RE.test(sid)) return "";
  const root = join(cfg, "projects");
  try {
    for (const d of readdirSync(root)) {
      const p = join(root, d, `${sid}.jsonl`);
      try { if (statSync(p).isFile()) return p; } catch { /* 不在这里 */ }
    }
  } catch { /* 没有 projects */ }
  return "";
}

/** 会话启动时的目录（记录里第一个带 cwd 的行）：hook 用的 CLAUDE_PROJECT_DIR 就是它 @param {string} path */
export function transcriptCwd(path) {
  if (!path) return "";
  for (const line of readLines(path, 256 * 1024)) {
    if (!line.includes('"cwd"')) continue;
    try { const o = JSON.parse(line); if (str(o.cwd)) return o.cwd; } catch { /* 最后一行可能被截断了 */ }
  }
  return "";
}

/**
 * @param {string} value 邀请链接（或者本机地址）
 * @param {SetUpOptions} o
 * @returns {Promise<string>} 交给 Claude 的输出
 */
export async function welcome(value, o) {
  try {
    return await setUp(value, o);
  } catch (e) {
    return fileProblem(e, o.dir);
  }
}

/** 读写不了自己的文件（权限、磁盘满、identity.json 坏了）。只说错误码：错误信息里可能带着文件内容（安装密钥）
 *  @param {unknown} e @param {string} dir */
function fileProblem(e, dir) {
  const code = e && typeof e === "object" && typeof (/** @type {any} */ (e).code) === "string" ? /** @type {any} */ (e).code : "";
  return `Problem: setting up Agent Loop failed${code ? ` (${code})` : ""} while reading or writing its files in ${dir}. ` +
    "Tell the user this in their language: they may need to check that this folder is writable and not damaged. Do not delete anything there and do not run any other command.";
}

/**
 * @typedef {object} SetUpOptions
 * @property {string} cfg Claude Code 的配置目录
 * @property {string} dir 插件数据目录
 * @property {string} sid 正在跑的会话（CLAUDE_CODE_SESSION_ID），拿不到是 ""
 * @property {string} cwd 拿不到会话记录时的项目目录
 * @property {((url: string) => boolean) | null} open 打开浏览器；null 表示不打开（--no-open）
 * @property {boolean} [created] 刚用 /agent-loop:create 建的群：页面上弹「群建好了」和邀请链接（&created），不弹「这是你的星系」
 * @property {number | "unreachable" | null} [sent] 已经把这个会话报上去了（建群时先报，服务器收下了才存设置），这是结果
 * @property {string} [version] 已经问过的服务器版本（serverVersion），没给就问一次
 */

/**
 * 把正在跑的这个会话作为一次 SessionStart 报给 value 指的服务器。返回 HTTP 状态码、"unreachable"，没有可报的返回 null
 * @param {string} value @param {SetUpOptions} o @returns {Promise<number | "unreachable" | null>}
 */
async function reportSession(value, o) {
  const transcript = findTranscript(o.cfg, o.sid), cwd = transcriptCwd(transcript) || o.cwd;
  const r = reporter(o.dir, parseTarget(value), { ...savedOptions(o.cfg), projectDir: cwd });
  const ev = r.build({ hook_event_name: "SessionStart", session_id: o.sid, source: "resume", cwd, ...(transcript ? { transcript_path: transcript } : {}) });
  if (!ev) return null;
  try { return await r.send(ev, SEND_TIMEOUT_MS * 2); } catch { return "unreachable"; }
}

const AGAIN = "ask them to copy the whole message for Claude Code from the Invite panel on the galaxy group's page again";

/** @param {string} value @param {SetUpOptions} o @returns {Promise<string>} */
async function setUp(value, o) {
  if (!value.trim()) {
    return "Problem: no invite link was given to --welcome (it goes right after --welcome, in quotes).\n" +
      `Tell the user this in their language, and ${AGAIN}. Do not run any other command.`;
  }
  // 退出过这个群又拿邀请回来：就是要回去（下面去掉 left 的记号），不算问题
  const target = resolveTarget(o.dir, value), keys = target.keys;
  const problem = nodeProblem(process.versions.node) ?? (target.block === "left" ? null : reportProblem(target, null));
  if (problem) {
    return `Problem: ${problem.replace(/^Agent Loop is not reporting: /, "the invite link given to --welcome is not usable: ")}\n` +
      `Tell the user this in their language, and ${AGAIN}. Do not run any other command.`;
  }
  // 插件没装上（安装那一行失败了）：重载以后没有 hook，报上去的这一次也接不上。先别动任何东西
  const have = installedVersion(o.cfg);
  if (!have) {
    return `Problem: the Agent Loop plugin is not installed, so the install line (claude plugin install ${PLUGIN_ID} …) did not work.\n` +
      "Tell the user this in their language, with the error that line printed if there was one. Once the cause is fixed, run the install line and then this line again.";
  }
  if (target.block === "left" && keys) markLeft(o.dir, keys.group, false);
  // 换群：已经开着的会话在 /reload-plugins 以前还拿着旧的设置，记下来让它们别再发（见 moved.json）
  const prev = rememberedTarget(o.dir), old = prev ? parseTarget(prev) : null, now = targetKey(target);
  if (old && targetKey(old) !== now) {
    markMoved(o.dir, targetKey(old), true);
    if (o.sid) noteStale(o.dir);   // 跑这条命令的会话自己就拿着旧设置（/agent-loop:status 会提醒它 /reload-plugins）
  }
  markMoved(o.dir, now, false);
  rememberTarget(o.dir, value);
  const { share, me } = savedOptions(o.cfg);
  const { secret } = loadIdentity(o.dir);
  // 旧群在别的服务器上：告诉它这个星系走了，不用等超时（同一个服务器上，新群收到事件时已经搬过去了）
  const oldKeys = old && old.k ? deriveKeys(old.k) : null;
  if (old && oldKeys && targetKey(old) !== now && old.url !== target.url && hasScheme(old.url) && !isLocal(old.url)) {
    await sendLeave(old.url, secret, oldKeys.access);
  }

  // 建群时已经先报过了（createGroup 的 sent）：不再报一次
  const status = o.sent !== undefined ? o.sent : o.sid ? await reportSession(value, o) : null;
  if (status !== null) recordStatus(o.dir, target.url, status);
  const reported = typeof status === "number" && status < 300, ok = status === null || reported;
  const where = keys ? `galaxy group ${fingerprint(keys.group)} on ${target.url}` : target.url;
  // 服务器的版本：旧服务器的页面不认 #galaxy=（见 galaxyUrl）。建群时已经问过了；被拒、连不上就不问（也不开浏览器）
  const fresh = newPage(o.version !== undefined ? o.version : ok ? serverVersion(await serverHealth(target.url)) : "");
  // &welcome（页面上「这是你的星系，刚才那个对话已经在这里了」）只在真报上去了时带；没报（拿不到会话编号）就只打开；被拒、连不上不开。
  // 刚建的群带 &created：页面弹「群建好了」和邀请链接（不管报没报上去：邀请链接只有在那里才拿得到）
  const mark = o.created ? "&created" : reported ? "&welcome" : "";
  const opened = !!o.open && ok && o.open(`${galaxyUrl(o.dir, value, true, fresh)}${mark}`);
  const lines = [
    o.created ? `Agent Loop created a new galaxy group ${fingerprint(keys?.group ?? "")} on ${target.url}, and this computer now reports to it.`
      : `Agent Loop is set up: this computer reports to ${where}.`,
    `Their galaxy: ${galaxyUrl(o.dir, value, false, fresh)}`,
  ];
  if (opened) lines.push(`(opened in the browser${keys ? " with the group key" : ""}; the key is not shown here)`);
  if (o.created) {
    lines.push(opened
      ? "The invite link (the group's only key) is in the panel that opened in the browser, and later under Invite on that page. It is not shown here."
      : "The invite link (the group's only key) is not shown here: run /agent-loop:galaxy to open the group in the browser, where it is under Invite.");
  }
  if (!ok) {
    const p = status === "unreachable" ? `could not reach ${target.url}. Check that the server is running and reachable from this computer.`
      : `${target.url} refused the report (HTTP ${status}). The invite link may be wrong or expired.`;
    lines.push(`Problem: ${p}`);
  } else if (o.sid) {
    lines.push("This session is on the map already, but it only starts drawing its steps after the user runs /reload-plugins (Claude can't run it). Sessions that were already open need /reload-plugins too; new sessions report on their own.");
  } else {
    lines.push("Their galaxy shows up once the user runs /reload-plugins (Claude can't run it) and says something; new sessions report on their own.");
  }
  if (olderThan(have, PLUGIN_VERSION)) lines.push(`The installed plugin is ${have}, older than ${PLUGIN_VERSION}: run \`claude plugin update ${PLUGIN_ID}\` now, before /reload-plugins.`);
  if (keys) claimHello(o.dir, keys.group);   // 这里讲过了：第一次说话时 hook 不再讲
  lines.push("",
    "Tell the user, in their language, in a short note (a few lines, no headings): " +
    (o.created ? "that the new group is created and where the invite link is (only share it with people they trust; anyone with it can watch the group), " : "") +
    (opened ? "their galaxy is open in the browser (give the address above as a link)" : "the address of their galaxy above, as a link") +
    (ok ? ", that they should run /reload-plugins now" : ", the problem above and how to fix it") + (keys ? ", and:" : "."),
    ...(keys ? helloPoints(target.url, share, me) : []));
  return lines.join("\n");
}

// ---- 发送

/**
 * @param {string} url @param {string} secret @param {OutEvent} ev @param {number} timeoutMs @param {string} [access] 星系群的口令
 */
export async function send(url, secret, ev, timeoutMs, access) {
  /** @type {Record<string, string>} */
  const headers = { "content-type": "application/json", authorization: `Bearer ${secret}`, "x-agent-loop-plugin": PLUGIN_VERSION };
  if (access) headers["x-group"] = access;
  const res = await fetch(url + "/v1/events", {
    method: "POST", headers, body: JSON.stringify(ev), signal: AbortSignal.timeout(timeoutMs),
  });
  await res.arrayBuffer().catch(() => {});
  return res.status;
}

/**
 * 往一个目标报事件：hook、替旧设置的会话发 SessionEnd、补发 SessionEnd、接入时报这个会话都用它，拼事件的方式只有这一份
 * @param {string} dir 插件数据目录 @param {{ url: string, k: string | null }} target
 * @param {{ share: string, me: string, projectDir?: string }} o
 */
function reporter(dir, target, { share, me, projectDir }) {
  const local = isLocal(target.url), keys = target.k ? deriveKeys(target.k) : null;
  const { secret, salt } = loadIdentity(dir);
  /** @type {Parameters<typeof buildEvent>[1]} */
  const ctx = {
    salt, level: shareLevel(share, local), local, key: keys?.content, gid: galaxyId(secret), me, projectDir,
    readModel: modelFromTranscript, readUsage: (p, sid) => usageFromTranscript(p, usageCacheFile(dir, sid)),
  };
  return {
    secret,
    build: (/** @type {any} */ hook) => buildEvent(hook, ctx),
    send: (/** @type {OutEvent} */ ev, /** @type {number} */ timeoutMs) => send(target.url, secret, ev, timeoutMs, keys?.access),
  };
}

async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const c of process.stdin) chunks.push(/** @type {Buffer} */ (c));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 「我的星系」的网址。带着邀请链接的密钥（#k=）时，这条网址发给别人就等于邀请对方
 * @param {string} dir 插件数据目录 @param {string} serverUrlValue server_url 的值（可能是邀请链接）
 * @param {boolean} [withKey] 带不带密钥
 */
export function galaxyUrl(dir, serverUrlValue, withKey = true, fresh = false) {
  const { url, k } = parseTarget(serverUrlValue);
  const id = galaxyId(loadIdentity(dir).secret);
  // &mine：告诉页面这是你自己的星系（别人发来的 #galaxy= 链接没有它，不会被当成你的）。
  // 键叫 galaxy=，不叫 g=：g= 容易被当成星系群（group）的编号，而群编号其实只藏在 #k= 里。
  // 可 0.2.10 以前的服务器的页面只认 g=：确认了服务器够新（fresh，见 newPage）才给 galaxy=。新的页面两种都认
  return `${url}/#${k && withKey ? `k=${k}&` : ""}${fresh ? "galaxy" : "g"}=${id}&mine`;
}

/**
 * 问服务器的 /healthz（不要口令，不带安装密钥）。连不上：reach 是 false；答了但不是 JSON（代理、登录页）：h 是 null
 * @param {string} url @param {number} [timeoutMs]
 * @returns {Promise<{ reach: false } | { reach: true, http: number, h: any }>}
 */
export async function serverHealth(url, timeoutMs = SEND_TIMEOUT_MS) {
  /** @type {Response} */
  let res;
  try { res = await fetch(url + "/healthz", { signal: AbortSignal.timeout(timeoutMs) }); } catch { return { reach: false }; }
  let h = null;
  try { h = res.ok ? await res.json() : (await res.arrayBuffer(), null); } catch { h = null; }
  return { reach: true, http: res.status, h };
}

/** /healthz 答的服务器版本。0.2.10 以前的服务器不答、连不上，都是 "" @param {Awaited<ReturnType<typeof serverHealth>>} r */
export function serverVersion(r) {
  const v = r.reach && r.h && typeof r.h === "object" ? r.h.version : undefined;
  return typeof v === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v) ? v : "";
}

/** 这个版本的服务器，页面认不认 #galaxy=、&created（since 给 LEFT_SINCE 时：认不认 #left=）。不知道版本当作不认 @param {string} version */
export const newPage = (/** @type {string} */ version, since = CREATE_SINCE) => !!version && !olderThan(version, since);

/** 用系统的浏览器打开网址（参数直接传给程序，不经过 shell）。失败就算了
 *  Windows 不用 explorer.exe：网址里有 & 时它除了开浏览器，还会多开一个「文档」文件夹窗口；
 *  url.dll 的 FileProtocolHandler 直接交给默认浏览器，不经过 cmd，& 也不用转义
 *  @param {string} url */
function openBrowser(url) {
  try {
    const [cmd, args] = process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
    return true;
  } catch { return false; }
}

/**
 * /agent-loop:galaxy 的输出。会进对话、发给模型：密钥不能出现在这里，带密钥的网址直接交给浏览器打开。
 * 退出过目标群（left.json）时没有地方显示你的星系：不打开浏览器、不给 #galaxy=…&mine（那会带人进旧群、把一个已经不在的星系
 * 标成「你的」），只说清楚已经退出和两条出路
 * @param {string} dir 插件数据目录 @param {string} value server_url 的值（可能是邀请链接）
 * @param {((url: string) => boolean) | null} open 打开浏览器；null 表示不打开（--no-open）
 * @returns {Promise<string>}
 */
export async function galaxyCommand(dir, value, open) {
  const target = resolveTarget(dir, value);
  const node = nodeProblem(process.versions.node);
  if (target.block === "left") {
    const out = `No galaxy address: ${blockMessage("left", target)}`;
    return node ? `${out}\nProblem: ${node}` : out;
  }
  // 服务器旧了（不答版本）、连不上：给旧页面也认的 #g=
  const fresh = hasScheme(target.url) && newPage(serverVersion(await serverHealth(target.url)));
  let out = galaxyUrl(dir, value, false, fresh);
  if (target.k && open && open(galaxyUrl(dir, value, true, fresh))) out += "\n(opened in your browser with the group key; the key is not shown here)";
  const problem = currentProblem(dir, target);
  return problem ? `${out}\nProblem: ${problem}` : out;
}

// ---- 建群（/agent-loop:create）
//
// 星系群不在服务器上注册：K 在本机随机生成，群在第一条事件到达时出现（开放模式的服务器才收新群，有每个 IP 的限额）。
// 以前建群在页面上做，浏览器记下 K，可你自己的插件不会跟过去，两边各记各的「在哪个群」。现在只在插件里建：
//   1. 问服务器收不收新群（/healthz 的 open；本机的服务没有群，白名单的服务器只收管理员登记的群），
//      服务器够不够新（version：比 CREATE_SINCE 旧的页面不认 &created，邀请链接没处显示）
//   2. 本机生成 K，先把这个会话报到新群：服务器收下了，群才算建起来（群数上限、每个 IP 的建群限额都在这一步）
//   3. 交给 `claude plugin configure --values-stdin` 存进 server_url：从标准输入给，不进命令行参数、
//      shell 历史和对话；和接入命令存的是同一个地方（实测）。存不进去就把星系从新群里撤出来
//   4. 后面和接入命令一样（setUp）：换群的记号、带着密钥在浏览器里打开（&created：页面弹邀请链接）
// 输出会进对话：不带密钥。命令文件设了 disable-model-invocation，只有用户自己敲得出来

/** 把 server_url 存进 Claude Code 的设置（敏感设置，进安全存储）。存好了返回 null，否则返回出错的说明（不带密钥）
 *  @param {string} value @returns {Promise<string | null>} */
export async function saveServerUrl(value) {
  const body = JSON.stringify({ server_url: value });
  /** @param {boolean} shell @returns {Promise<{ missing: boolean, error: string | null }>} */
  const attempt = shell => new Promise(done => {
    /** @type {import("node:child_process").ChildProcess} */
    let p;
    const argv = ["plugin", "configure", PLUGIN_ID, "--values-stdin"];
    /** @type {import("node:child_process").SpawnOptions} */
    const opts = { stdio: ["pipe", "ignore", "pipe"], windowsHide: true };
    try {
      // 值只从标准输入给。经过 shell 时给一整条命令（参数数组配 shell: true 在 Node 24 上会打 DEP0190 警告，
      // 那行警告会进命令的输出）；这几个词是固定的，拼不进别的东西
      p = shell ? spawn(["claude", ...argv].join(" "), { ...opts, shell: true }) : spawn("claude", argv, opts);
    } catch (e) { done({ missing: false, error: `could not run claude (${/** @type {any} */ (e)?.code || "error"})` }); return; }
    let err = "", settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const finish = (/** @type {boolean} */ missing, /** @type {string | null} */ error) => { if (!settled) { settled = true; clearTimeout(timer); done({ missing, error }); } };
    // 超时：连子进程一起停掉。经过 cmd.exe 时 p.kill() 只停得了 cmd，claude 还会接着跑、事后照样把设置存进去
    const stop = () => {
      if (process.platform === "win32" && p.pid) {
        try { spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => p.kill()); } catch { p.kill(); }
      } else p.kill();
    };
    timer = setTimeout(() => { stop(); finish(false, "claude plugin configure did not finish within 30 seconds and was stopped"); }, 30_000);
    p.stderr?.on("data", d => { if (err.length < 2000) err += d; });
    p.on("error", e => finish(/** @type {any} */ (e).code === "ENOENT", `could not run claude (${/** @type {any} */ (e).code || "error"})`));
    p.on("close", code => {
      if (code === 0) return finish(false, null);
      const line = err.split("\n").map(x => x.trim()).find(Boolean)?.replace(KEY_IN_TEXT, "$1…").slice(0, 200);
      // shell 找不到命令：cmd 是 1、sh 是 127
      finish(shell && /not recognized|not found/i.test(err), `claude plugin configure exited with code ${code}${line ? `: ${line}` : ""}`);
    });
    p.stdin?.on("error", () => {});
    p.stdin?.end(body);
  });
  let r = await attempt(false);
  // Windows 上用 npm 装的 claude 是 claude.cmd，不经过 shell 起不来
  if (r.missing && process.platform === "win32") r = await attempt(true);
  return r.missing ? "could not find the claude command on PATH" : r.error;
}

/** 新的星系群密钥：32 字节随机数的 base64url（43 个字符） */
export const newK = () => b64u(randomBytes(32));

/**
 * 能不能在这台服务器上建群，看它 /healthz 答的（serverHealth）。能返回 null，不能返回原因
 *   - 本机的服务（npx agent-loop）没有群
 *   - 服务器比 CREATE_SINCE 旧（不答 version）：它的页面不认 &created，新群的邀请链接没有地方显示
 *   - open 是 false：白名单的服务器只收管理员登记的群
 * @param {string} url @param {Awaited<ReturnType<typeof serverHealth>>} r @returns {string | null}
 */
export function createBlocked(url, r) {
  if (!r.reach) return `could not reach ${url}`;
  const h = r.h;
  if (r.http >= 300) return `${url} did not answer like an Agent Loop server (HTTP ${r.http})`;
  if (!h || typeof h !== "object" || h.ok !== true) return `${url} did not answer like an Agent Loop server`;
  if (h.local === true) return `${url} is a server for a single computer (npx agent-loop), which has no galaxy groups`;
  const v = serverVersion(r);
  if (!newPage(v)) {
    return `${url} runs an older Agent Loop server (${v || "before 0.2.11"}) whose page cannot show a new group's invite link. ` +
      `Ask its admin to update the server to ${CREATE_SINCE} or newer, or join one of its groups with an invite link`;
  }
  if (h.open === false) return `${url} only accepts galaxy groups its admin has registered. Ask the admin for an invite link (made with npx agent-loop invite) and join with that`;
  return null;
}

/** 新群的第一次上报被拒了：为什么 @param {string} url @param {number | "unreachable"} status */
function createRefused(url, status) {
  if (status === "unreachable") return `could not reach ${url} to send the first report`;
  if (status === 503) return `${url} is full (HTTP 503): it has reached its limit of galaxy groups or galaxies. Try again later or ask its admin`;
  if (status === 429) return `${url} is limiting new galaxy groups and galaxies from this network (HTTP 429). Try again in an hour`;
  if (status === 403) return `${url} only accepts galaxy groups its admin has registered (HTTP 403). Ask the admin for an invite link (made with npx agent-loop invite) and join with that`;
  return `${url} refused the first report to the new group (HTTP ${status})`;
}

/**
 * /agent-loop:create [服务器地址]。没给地址就用现在报给的那个服务器
 * @param {string} given 命令后面跟的地址（可以是空的；带着 #… 的只取前面）
 * @param {SetUpOptions & { save: (value: string) => Promise<string | null> }} o
 * @returns {Promise<string>} 交给 Claude 的输出
 */
export async function createGroup(given, o) {
  const fail = (/** @type {string} */ why) =>
    `Problem: no galaxy group was created: ${why}. Nothing was changed.\nTell the user this in their language. Do not run any other command.`;
  const node = nodeProblem(process.versions.node);
  if (node) return fail(node.replace(/^Agent Loop is not reporting: /, "").replace(/\.$/, ""));
  const arg = given.trim().replace(/^["']+|["']+$/g, "");
  const url = parseTarget(arg ? arg.split("#")[0] : rememberedTarget(o.dir)).url;
  const usage = "Usage: /agent-loop:create https://<server>";
  if (!hasScheme(url)) return fail(`the server address must start with https:// or http:// (got "${url.slice(0, 200)}"). ${usage}`);
  if (isLocal(url)) {
    return fail(arg ? `${url} is this computer, and a server on this computer has no galaxy groups. ${usage}`
      : `this computer reports to a server on this computer (${url}), which has no galaxy groups. Say which server to create it on. ${usage}`);
  }
  if (!installedVersion(o.cfg)) return fail(`the Agent Loop plugin is not installed under ${o.cfg}`);
  const health = await serverHealth(url, SEND_TIMEOUT_MS * 2);
  const blocked = createBlocked(url, health);
  if (blocked) return fail(blocked);
  const k = newK(), value = `${url}/#k=${k}`, access = /** @type {NonNullable<ReturnType<typeof deriveKeys>>} */ (deriveKeys(k)).access;
  // 先把这个会话报到新群，服务器真收下了（群建起来了）才存设置：群数到了上限、这个 IP 建群太多、服务器这时连不上，
  // 都要在动 server_url 以前知道，不然插件指着一个不存在的群，原来那个群的邀请链接也从设置里没了。
  // 拿不到会话编号（旧版的 Claude Code）就没法先试，只能照常存
  /** @type {number | "unreachable" | null} */
  let sent;
  try { sent = o.sid ? await reportSession(value, o) : null; } catch (e) { return fileProblem(e, o.dir); }
  if (sent !== null && !(typeof sent === "number" && sent < 300)) return fail(createRefused(url, sent));
  const saveError = await o.save(value);
  if (saveError) {
    // 新群已经在服务器上了，星系也搬了进去：搬出来（同一个服务器上的旧群，旧会话下一步就把它带回去）
    if (sent !== null) await sendLeave(url, loadIdentity(o.dir).secret, access);
    return fail(`the new invite link could not be saved into the plugin's server_url setting (${saveError})`);
  }
  return welcome(value, { ...o, created: true, sent, version: serverVersion(health) });
}

// ---- 现在的状态（/agent-loop:status）

/**
 * 只读：报给哪里、在不在群里、上次发得怎么样、星系的编号和名字、分享多少、插件版本。输出会进对话：不带密钥
 * @param {string} dir 插件数据目录 @param {string} value server_url 的值 @param {string} cfg Claude Code 的配置目录
 * @param {number} [now]
 */
export function statusCommand(dir, value, cfg, now = Date.now()) {
  const target = resolveTarget(dir, value), local = target.local;
  const { share, me } = savedOptions(cfg);
  const last = lastStatus(dir), have = installedVersion(cfg);
  const problem = currentProblem(dir, target);
  const where = local ? `a server on this computer (${target.url})` : target.group ? `galaxy group ${fingerprint(target.group)} on ${target.url}` : target.url;
  const mine = last && last.url === target.url ? last.status : null;
  const lastLine = mine === null ? "nothing sent to this server yet"
    : mine === "unreachable" ? "could not reach the server"
    : mine < 300 ? "accepted" : `refused (HTTP ${mine})`;
  // reportProblem 不管 429、5xx（多半一会儿就好），可上次确实没送到：不能说「在报」
  // 退出过、设置不对：Problem 那一行说清楚（和 hook 的提示是同一句）
  const state = problem ? "not reporting (see Problem)"
    : mine === null ? "set up; nothing sent yet"
    : mine === "unreachable" || mine >= 300 ? "not reporting right now: the last report did not get through (see Last report); every step tries again"
    : "reporting";
  const update = have && olderThan(have, PLUGIN_VERSION) ? `; run \`claude plugin update ${PLUGIN_ID}\`` : "";
  // 换过群以后还拿着旧设置的会话（resolveTarget 的 moved）什么都不发：这条命令看不到是哪个会话在跑，只能说最近见到过。
  // 退出过这个群时反正什么都不发，不提
  const staleAgo = now - staleSeen(dir), STALE_RECENT_MS = 30 * 60_000;
  const lines = [
    `Reports to: ${where}`,
    `State: ${state}`,
    ...(staleAgo >= 0 && staleAgo < STALE_RECENT_MS && target.block !== "left"
      ? [`Old sessions: ${Math.max(1, Math.round(staleAgo / 60_000))} min ago a session that was open before the last switch of server_url (including the one that ran /agent-loop:create or the setup) still had the old setting, so it sends nothing. Run /reload-plugins in each session that was open before the switch.`]
      : []),
    `Last report: ${lastLine}`,
    `Galaxy: ${galaxyId(loadIdentity(dir).secret)}, named ${me ? JSON.stringify(me) : "with an auto-generated catalog number"}`,
    `Sharing: ${share || "auto"} (${SHARE_WHAT[shareLevel(share, local)][0]} for this server)`,
    `Plugin: ${PLUGIN_VERSION}${have && have !== PLUGIN_VERSION ? ` (installed: ${have}${update})` : ""}`,
  ];
  if (problem) lines.push(`Problem: ${problem}`);
  return lines.join("\n");
}

/** 命令（不是 hook）的参数：数据目录（命令正文里的 ${CLAUDE_PLUGIN_DATA} 没被替换时用 dataDir()）、后面的词、浏览器开不开。
 *  命令文件把 "$ARGUMENTS" 整个当一个参数传进来（/agent-loop:create https://srv --no-open 是一个参数）：拆开再认
 *  @param {string[]} args */
function commandArgs(args) {
  const dir = args[1] && !args[1].startsWith("${") ? args[1] : dataDir();
  const words = args.slice(2).flatMap(a => a.split(/\s+/)).filter(Boolean);
  return {
    dir,
    /** 用户给的地址：第一个不以 -- 开头、也不是没被替换的 $ARGUMENTS 的词 */
    given: words.find(w => !w.startsWith("--") && !w.startsWith("$")) ?? "",
    open: words.includes("--no-open") ? null : openBrowser,
  };
}

/** 写到标准输出，写完再返回（之后进程马上退出） @param {string} out @returns {Promise<void>} */
const print = out => new Promise(r => process.stdout.write(out + "\n", () => r()));

async function main() {
  const args = process.argv.slice(2);
  // /agent-loop:galaxy、leave、rejoin、status：命令里的 shell 拿不到插件的环境变量（CLAUDE_PLUGIN_OPTION_* 也拿不到，实测），
  // 所以数据目录从参数传进来，地址从 hook 记下的 server.json 读；没记过就是默认的本机地址（parseTarget）
  if (args[0] === "--galaxy" || args[0] === "--leave" || args[0] === "--rejoin" || args[0] === "--status") {
    const { dir, given, open } = commandArgs(args);
    const value = given || rememberedTarget(dir) || "";
    return print(args[0] === "--galaxy" ? await galaxyCommand(dir, value, open)
      : args[0] === "--status" ? statusCommand(dir, rememberedTarget(dir) || "", configDir())
      : await leaveOrRejoin(args[0] === "--leave" ? "leave" : "rejoin", dir, value, open));
  }
  if (args[0] === "--welcome") {
    // 接入（页面上那段话的最后一行）：Claude 在 Bash 里跑，从插件市场的目录。数据目录是插件装好以后 hook 用的那个。
    // 链接是第一个不以 -- 开头的参数（--no-open 放在前面也认得）；没有就照实说，不退回本机地址
    return print(await welcome(args.slice(1).find(a => !a.startsWith("--")) ?? "", {
      cfg: configDir(), dir: dataDir(), sid: (process.env.CLAUDE_CODE_SESSION_ID || "").trim(), cwd: process.cwd(),
      open: args.includes("--no-open") ? null : openBrowser,
    }));
  }
  if (args[0] === "--create") {
    // 后面是用户给的服务器地址（可以没有：命令正文里的 $ARGUMENTS 是空的或没被替换）
    const { dir, given, open } = commandArgs(args);
    return print(await createGroup(given, {
      cfg: configDir(), dir, sid: (process.env.CLAUDE_CODE_SESSION_ID || "").trim(), cwd: process.cwd(), open, save: saveServerUrl,
    }));
  }
  const text = await readStdin();
  const hook = JSON.parse(text);
  const { target, share, me } = settings();
  if (args[0] === "--check") {
    // 同步的检查（hooks.json 里 SessionStart、UserPromptSubmit 的第二个 hook）：只读本机的几个小文件，不连网络。
    // 异步 hook 的输出不会显示给用户、也不进上下文，所以这一步必须是同步的。
    // 会话开始时：设置或上次的发送有问题就提示一行（压缩上下文时不重复）。
    // 用户说话时：第一次接上这个星系群，把说明交给 Claude（helloContext）
    // 换过群以后还没 /reload-plugins 的旧会话：说话、/clear 时提示一行（新开的会话不算，见 resolveTarget）
    let out = null;
    const dir = dataDir(), t = resolveTarget(dir, target, hook);
    if (t.block === "moved") {
      if (hook.source !== "compact") out = { systemMessage: `Agent Loop: ${blockMessage("moved", t)}` };
    } else if (hook.hook_event_name === "UserPromptSubmit") {
      // 设置或上次的发送有问题时不讲（会话开始时已经提示过怎么改）
      const ctx = currentProblem(dir, t) ? null : helloContext(dir, t, share, me);
      if (ctx) out = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } };
    } else if (hook.source !== "compact") {
      const problem = currentProblem(dir, t);
      if (problem) out = { systemMessage: problem };
    }
    if (out) await print(JSON.stringify(out));
    return;
  }
  const dir = dataDir(), t = resolveTarget(dir, target, hook);
  const value = (process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL || "").trim();
  // 换过群以后还没 /reload-plugins 的旧会话：不发，也不把旧链接写回 server.json
  if (t.block === "moved") {
    noteStale(dir);
    if (hook.hook_event_name === "SessionEnd") await endInCurrent(dir, hook, share, me);
    return;
  }
  // 地址漏了 http://，或者发往别处却没有邀请链接（或者链接坏了）：什么都不发。会话开始时的检查会告诉用户。
  // 这时只在还没记过地址时记一下（新用户设错了，/galaxy 也能照实说出问题）；记过就不动：
  // 改设置以前开的会话还拿着旧值，不能让它把新会话记下的好地址冲掉
  if (t.block === "scheme" || t.block === "nokey" || t.block === "badkey") { if (!rememberedTarget(dir)) rememberTarget(dir, value); return; }
  // 新开的会话拿的一定是当前的设置：它要是换走了的旧值，说明用户又改回去了，去掉记号照常发（见 moved.json）
  if (isStartup(hook)) try { markMoved(dir, markOf(t.url, t.group), false); } catch { /* 写不了：这次照常发 */ }
  rememberTarget(dir, value);
  // 用 /agent-loop:leave 退出过这个星系群：不发（会话开始时的检查会说明）
  if (t.block) return;
  const r = reporter(dir, t, { share, me, projectDir: process.env.CLAUDE_PROJECT_DIR });
  const ev = r.build(hook);
  if (!ev) return;
  if (ev.ev === "SessionStart" && ev.source === "startup") pruneUsageCache(dir);
  // SessionEnd 的发送超时很短，超时不代表服务器有问题：它的结果不记
  if (ev.ev === "SessionEnd") return void await r.send(ev, SESSION_END_TIMEOUT_MS);
  /** @type {number | "unreachable"} */
  let status;
  try { status = await r.send(ev, SEND_TIMEOUT_MS); } catch { status = "unreachable"; }
  recordStatus(dir, target.url, status);
  // 会话开始、说话时（都是异步的 hook，不耽误用户）：替结束了却没送出 SessionEnd 的会话补发。服务器收下了才扫
  if (status === 204 && !ev.agent && (ev.ev === "SessionStart" || ev.ev === "UserPromptSubmit")) {
    await sweepEnded({
      dir, cfg: configDir(), self: String(hook.session_id),
      end: sid => {
        const gone = r.build({ hook_event_name: "SessionEnd", session_id: sid, reason: "other", cwd: hook.cwd });
        return gone ? r.send(gone, SEND_TIMEOUT_MS) : Promise.resolve();
      },
    });
  }
}

const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (isMain) {
  process.on("uncaughtException", () => { process.exit(0); });
  process.on("unhandledRejection", () => { process.exit(0); });
  // 发完（或失败）就立刻退出：发送超时以后，没连上的 TCP 连接还会让进程多挂一两秒（Windows 上连被拒绝的端口会重试），
  // 同步的 SessionEnd 会因此被 Claude Code 取消
  main().catch(() => {}).finally(() => process.exit(0));
}
