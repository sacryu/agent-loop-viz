// 服务器 → 浏览器（WebSocket /ws）的消息。分两层：
//   概要层：所有浏览器都收，最多每秒一次，只有每个星系的编号、项目数、每个会话的状态（一个字母）。
//   细节层：浏览器发 {"focus": "<星系编号>"} 以后才收那个星系的完整状态，之后实时推增量。
import type { ToolKind } from "./tools.ts";

export type Status = "working" | "waiting" | "done" | "error" | "idle";
export type Phase = "think" | "act";

/** 概要层里每个会话一个字母 */
export const STATUS_CODE = {
  think: "w",     // 在想
  act: "a",       // 在动手
  bg: "b",        // 回合结束了，只在等后台任务
  waiting: "q",   // 等你
  done: "d",
  error: "e",
  idle: "i",
  stale: "s",     // 可能已关闭
} as const;
export type StatusCode = (typeof STATUS_CODE)[keyof typeof STATUS_CODE];

/**
 * 一个附件：k 是它的键（见 attach.ts 的 slotsOf），x 是内容。本机模式下 x 是明文对象，否则是密文（字符串）。
 * 服务器不解读 x，只按事件类型把它放到对应的位置。
 * f：这一轮在问、回答（会话的 ask、ans）才有，表示同一条事件还带来了大附件（整句话、完整回答），页面上才让它能点。
 */
export interface WAtt { k: string; x: string | object; f?: true }

/** [星系编号, 项目数, 每个会话的状态字母拼成的串, 星系的名片（最新一条 SessionStart 的小附件）] */
export type SummaryRow = [id: string, projects: number, sessions: string, card?: WAtt];

export interface WireStep {
  id: string;            // 哈希后的 tool_use_id
  lap: number;           // 第几圈（整个会话累计）
  round: number;         // 第几轮（你说一句话算一轮）
  kind: ToolKind;
  d?: WAtt;              // 小附件（槽 step）：真实工具名和对象
  e?: WAtt;              // 小附件（槽 fail）：报错的第一行
  start: number;
  end: number | null;
  err: boolean;
  agent?: string;        // 子 agent 做的那一步：哈希后的 agent_id
  fin?: true;            // 服务器上有这一步的大附件：完整的输入（槽 full-in）
  fout?: true;           // 服务器上有这一步的大附件：完整的输出或报错（槽 full-out）。两个都没有时页面上点不开
}

export interface WireSub {
  id: string;
  type: string;          // 内置类型名或 custom
  status: Status;
  phase: Phase;
  phase_since: number;
  started: number;
  ended: number | null;
  tool_id: string | null;  // 主对话里派出它的那一步
  d?: WAtt;                // 小附件（槽 sub）：真实的类型名
}

export interface WireSession {
  sid: string;
  proj: string;
  born: number;
  status: Status;
  status_since: number;
  phase: Phase;
  phase_since: number;
  round: number;
  round_since: number;
  laps: number;            // 已经跑完的圈数（整个会话累计）
  steps_total: number;     // 主对话累计步数
  wait_sub: boolean;       // 在等你的是子 agent
  wait_kind: "permission" | "ask" | "plan" | "input" | null;
  bg: number;
  bg_since: number | null;
  compacting: boolean;
  err_kind: string | null;
  stale: boolean;
  last_event: number;
  running: number;         // 主对话正在跑的工具数
  subagents: WireSub[];
  model: string | null;    // 最近一次见到的模型名
  ctx_tok: number | null;  // 上下文的 token 数（最后一次回答时）
  out_tok: number | null;  // 主对话累计输出的 token 数
  title?: WAtt;            // 小附件（槽 title）：Claude Code 给对话起的标题
  first?: WAtt;            // 小附件（槽 ask）：服务器见到的第一句话。还没有标题时（刚开始、插件旧）拿它当标题
  ask?: WAtt;              // 小附件（槽 ask）：这一轮在问什么
  ans?: WAtt;              // 小附件（槽 ans）：这一轮回答的最后一句（回合结束后才有）
}

export interface WireProject {
  id: string;
  card?: WAtt;             // 小附件（槽 card）：这个项目最新一条 SessionStart 的附件，里面有项目名
  sids: string[];          // 轨道上的对话，从先到后
}

export interface WireGalaxy {
  id: string;
  card?: WAtt;             // 星系的名片：最新一条 SessionStart 的附件，里面有星系的名字
  projects: WireProject[]; // 轨道从内到外
  sessions: WireSession[];
  steps: Record<string, WireStep[]>;   // sid → 步骤（最多 600 步）
}

export type ServerMsg =
  /** local：本机模式（不需要口令）；open：开放模式，任何人都能在这台服务器上创建星系群 */
  | { t: "hello"; now: number; local: boolean; open: boolean }
  | { t: "sum"; now: number; full: boolean; rows: SummaryRow[]; gone: string[] }
  | { t: "gal"; now: number; id: string; full: true; galaxy: WireGalaxy }
  | { t: "gal"; now: number; id: string; full: false; projects: WireProject[]; sessions: WireSession[];
      steps: Record<string, WireStep[]>; gone: string[] }
  | { t: "gal-gone"; now: number; id: string }
  /** 这个星系群里插件旧了的星系：[星系编号, 它的插件版本（空串：太旧，没报版本）]。latest 是服务器这边的插件版本。
   *  连上时有旧的才发，之后变了就发（包括变成空的） */
  | { t: "plugin"; now: number; latest: string; old: [id: string, v: string][] }
  /** 浏览器要的大附件。x 为 null：服务器上没有（没传过、或者被挤掉了） */
  | { t: "full"; now: number; id: string; sid: string; slot: string; k: string; x: string | object | null };

export type ClientMsg =
  /** 加入星系群（非本机模式下第一条消息必须是它）：口令由邀请链接里的密钥派生 */
  | { join: string }
  | { focus: string | null }
  /** 要一个大附件（只能是正在看的星系里的） */
  | { full: { sid: string; slot: string; k: string } };

export const MAX_STEPS = 600;
