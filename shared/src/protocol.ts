// 插件 → 服务器的事件协议（POST /v1/events，一个 hook 事件一条）。版本 2：加了附件（见 shared/src/attach.ts）。
// 这是唯一的权威定义：服务器按它严格校验（有多余字段就拒绝；非本机的服务器收到明文附件直接拒绝），
// 防泄漏测试也用它检查 report.mjs 的输出。
// report.mjs 不能从这里导入，它的 JSDoc 类型与这里手工保持一致。
import { z } from "zod";
import { TOOL_KINDS } from "./tools.ts";
import { ID_RE, PROTOCOL_VERSION } from "./attach.ts";


export const EVENT_NAMES = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PostToolBatch", "PermissionRequest", "PermissionDenied", "Notification", "Stop", "StopFailure",
  "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
  // 不是 Claude Code 的 hook：同一台机器上别的会话有动静时，插件替开着、却安静了很久的会话报一声「还开着」
  // （见 report.mjs 的 sweep）。服务器靠它不把闲着的会话标成可能已关闭、不移除；服务器重启过的话靠它把会话补回来。
  // 旧的服务器不认它，回 400：插件不当回事，也不记进上报的结果
  "Alive",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const ERR_KINDS = ["rate_limit", "server", "auth", "billing", "max_output", "other"] as const;
export type ErrKind = (typeof ERR_KINDS)[number];

export const SESSION_SOURCES = ["startup", "resume", "clear", "compact", "fork"] as const;

// 只认这些通知类型；别的值脚本不上传
export const NOTIFICATION_TYPES = [
  "permission_prompt", "idle_prompt", "auth_success", "elicitation_dialog", "elicitation_complete",
  "elicitation_response", "agent_needs_input", "agent_completed",
] as const;

// 内置子 agent 类型原样上传，其余记成 custom
export const BUILTIN_AGENT_TYPES = ["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide"] as const;
export const AGENT_TYPES = [...BUILTIN_AGENT_TYPES, "custom"] as const;

/** 分享档位：0 匿名（只有匿名字段）、1 概要（加小附件）、2 完整（再加大附件）。只由发送方的插件决定 */
export const LEVELS = [0, 1, 2] as const;
export type Level = (typeof LEVELS)[number];

/** sha256(salt + 原值) 的前 16 个十六进制字符 */
export const Hash16 = z.string().regex(/^[0-9a-f]{16}$/);

// 模型名只认 Claude 的模型名（claude-… 或几个别名）；report.mjs 里的 MODEL_RE 与此相同
export const MODEL_RE = /^(claude-[a-z0-9.-]{1,60}(\[1m\])?|opus|sonnet|haiku|fable)$/;
export const ModelName = z.string().max(80).regex(MODEL_RE);

/** 小附件明文的上限（字节，JSON） */
export const SMALL_MAX_BYTES = 600;
/** 大附件明文的上限（字节，JSON） */
export const FULL_MAX_BYTES = 32 * 1024;

/**
 * 小附件的明文：结构化的短字段，不是写好的句子（句子由浏览器按看的人的语言拼）。
 * 服务器不解读它：本机模式下原样存、原样转发；非本机时只见到密文。浏览器解开以后按这个 schema 校验。
 */
export const DetailSchema = z.strictObject({
  me: z.string().max(80).optional(),      // SessionStart：星系的名字（插件设置里填的）
  proj: z.string().max(120).optional(),   // SessionStart：项目目录名
  label: z.string().max(120).optional(),  // UserPromptSubmit：这句话的开头
  name: z.string().max(160).optional(),   // 工具事件：真实工具名
  obj: z.string().max(200).optional(),    // 工具事件：对象（文件、命令开头、搜索词……）
  err: z.string().max(240).optional(),    // PostToolUseFailure：报错的第一行
  type: z.string().max(80).optional(),    // SubagentStart：真实的子 agent 类型名
  say: z.string().max(320).optional(),    // Stop：回答的最后一句
});

/** 密文：base64url(12 字节随机数 ‖ 密文 ‖ 16 字节校验) */
export const Sealed = z.string().regex(/^[A-Za-z0-9_-]+$/);

const base = {
  v: z.literal(PROTOCOL_VERSION),
  level: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  ev: z.enum(EVENT_NAMES),
  ts: z.number().int().positive(),
  sid: Hash16,
  proj: Hash16,
  agent: Hash16.optional(),
  prompt: Hash16.optional(),
  tool: Hash16.optional(),
  kind: z.enum(TOOL_KINDS).optional(),
  duration_ms: z.number().int().nonnegative().max(1e9).optional(),
  interrupt: z.boolean().optional(),
  source: z.enum(SESSION_SOURCES).optional(),
  ntype: z.enum(NOTIFICATION_TYPES).optional(),
  bg: z.number().int().nonnegative().max(1000).optional(),
  err_kind: z.enum(ERR_KINDS).optional(),
  agent_type: z.enum(AGENT_TYPES).optional(),
  agent_type_h: Hash16.optional(),
  task_note: z.boolean().optional(),
  model: ModelName.optional(),
  ctx_tok: z.number().int().nonnegative().max(1e11).optional(),   // 上下文的 token 数（最后一次回答时）
  out_tok: z.number().int().nonnegative().max(1e11).optional(),   // 主对话累计输出的 token 数
  // 会话记录里已有的圈数（主对话的回答条数）和步数（工具调用数）：服务器重启过、会话中途才接上时，累计数靠它补回来。
  // 只在会话开始、新一轮开始、回答完时带，服务器只拿它当下限
  laps: z.number().int().nonnegative().max(1e7).optional(),
  steps: z.number().int().nonnegative().max(1e7).optional(),
};

/** 发往非本机的事件：匿名字段，加上（档位 ≥ 1 时）附件的密文。服务器拿不到任何明文内容 */
export const RemoteEvent = z.strictObject({
  ...base,
  enc: Sealed.max(2000).optional(),
  enc_full: Sealed.max(60_000).optional(),
  // UserPromptSubmit 补发的名片（槽 card，和 SessionStart 的小附件同一个位置、同样的内容）：
  // 服务器重启、会话中途才设好插件时，会话开始那条事件没送到，项目名和星系名靠它补上。服务器只在还没有名片时用它
  enc_card: Sealed.max(2000).optional(),
  // 对话的标题（槽 title）：Claude Code 给对话起的（/rename 改过的优先），插件从会话记录里读。
  // 会话开始、提问、回答完时带上，每圈结束时只在它变了的时候带。有就换掉服务器上的
  enc_title: Sealed.max(2000).optional(),
});
/** 发往本机的事件：附件是明文（数据不出电脑），另可附原样的 hook 数据给调试页 */
export const LocalEvent = z.strictObject({
  ...base,
  detail: DetailSchema.optional(),
  card: DetailSchema.optional(),   // 同 RemoteEvent 的 enc_card，明文
  title: DetailSchema.optional(),  // 同 RemoteEvent 的 enc_title，明文
  detail_full: z.unknown().optional(),
  raw: z.unknown().optional(),
});
export type RemoteEvent = z.infer<typeof RemoteEvent>;
export type LocalEvent = z.infer<typeof LocalEvent>;
/** 服务器内部统一用这个类型：两种来源的字段并在一起，都是可选的 */
export type Event = z.infer<typeof RemoteEvent> & Omit<LocalEvent, keyof RemoteEvent>;

/** 档位 0 的事件必须严格符合这个 schema：防泄漏测试用。一个附件字段都没有 */
export const Level0Event = z.strictObject({ ...base, level: z.literal(0) });

export const SECRET_RE = /^[0-9a-f]{64}$/;
