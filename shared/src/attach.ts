// 附件：放在哪个槽、用什么附加校验数据、明文长什么样。浏览器和服务器都用，不依赖 zod。
export const PROTOCOL_VERSION = 2;

/**
 * 星系编号、星系群编号的长度：sha256 的前 32 个十六进制字符（128 位）。
 * 这两个编号是公开的，服务器却靠它们认人（编号对上了就算有密钥、有口令），所以不能短：
 * 只留 64 位的话，知道编号的人离线算 2^64 次哈希就能撞出一个「也对得上」的口令或安装密钥。
 * 插件（report.mjs）、命令行（cli/bin.mjs）各有一份同样的常量，测试检查一致
 */
export const ID_HEX = 32;
export const ID_RE = /^[0-9a-f]{32}$/;
/** 星系群的 K（邀请链接里 #k= 后面）和口令：32 字节的 base64url，43 个字符 */
export const KEY43_RE = /^[A-Za-z0-9_-]{43}$/;

/** 小附件的明文（字段含义见 protocol.ts 的 Detail schema） */
export interface Detail { me?: string; proj?: string; label?: string; name?: string; obj?: string; err?: string; type?: string; say?: string }
const DETAIL_KEYS = ["me", "proj", "label", "name", "obj", "err", "type", "say"] as const;

/** 浏览器解开附件以后的检查：只认已知的键、只要字符串 */
export function asDetail(v: unknown): Detail | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Detail = {};
  for (const k of DETAIL_KEYS) { const x = (v as Record<string, unknown>)[k]; if (typeof x === "string") out[k] = x.slice(0, 400); }
  return out;
}

// ---- 附件放在哪
// 每个附件属于一个「槽」。加密时把 协议版本|槽|sid|键 作为附加校验数据，服务器没法把附件挪到别的地方。
//   小附件：card（SessionStart，键是项目编号，sid 位置放星系编号：名片没法被挪到别人的星系上）、ask（UserPromptSubmit，键是 prompt）、step（PreToolUse /
//           PermissionRequest，键是 tool）、fail（PostToolUseFailure，键是 tool）、sub（SubagentStart，键是 agent）、
//           ans（Stop，键是 prompt）、title（对话的标题，随 SessionStart / UserPromptSubmit / PostToolBatch / Stop 附带，键为空）
//   大附件：full-in（工具输入）、full-out（工具输出或完整报错）、full-ask（整句话）、full-ans（完整回答）、full-note（通知）
export type SmallSlot = "card" | "ask" | "step" | "fail" | "sub" | "ans" | "title";
export type FullSlot = "full-in" | "full-out" | "full-ask" | "full-ans" | "full-note";
export type Slot = SmallSlot | FullSlot;

/** 一条事件的附件该放进哪个槽、用什么键。没有对应的槽就是 null */
export function slotsOf(ev: { ev: string; sid: string; proj: string; tool?: string; agent?: string; prompt?: string }, gid = ""):
  { small: { slot: SmallSlot; sid: string; k: string } | null; full: { slot: FullSlot; sid: string; k: string } | null } {
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

/** 一个大附件在哪：服务器存它、浏览器缓存它都用这个键 */
export const fullKey = (sid: string, slot: string, k: string) => `${sid}|${slot}|${k}`;

/** 附加校验数据（AAD） */
export const aadOf = (slot: Slot, sid: string, k: string) => `agent-loop/${PROTOCOL_VERSION}|${slot}|${sid}|${k}`;

