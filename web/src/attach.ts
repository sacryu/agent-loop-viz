// 附件：本机模式下是明文对象，直接用；别处来的是密文，用邀请链接里的密钥解开。
// 画面每帧都要读这些文字，所以这里是同步的：解开过的记在缓存里；还没解开的先返回 null（画面退回自动生成的名字、类别词），
// 同时在后台解，解开以后把它的范围（对话编号，名片是 CARD）记进脏集合，model.ts 每帧取走、只重拼这些对话的文字。
// 换密钥时 version 加一：所有文字都要重拼。
import { aadOf, asDetail, type Detail, type Slot, type WAtt } from "@agent-loop/shared/browser";
import type { GroupKeys } from "./crypto.ts";

/**
 * plain：本机模式或演示站，服务器（剧本）给的附件都是明文，大附件是字符串时也不是密文。
 * version：换了密钥就加一。cardVer：解开了一张名片（或换了密钥）就加一，宇宙视图看它更新名字
 */
export const ATT = { keys: null as GroupKeys | null, version: 0, cardVer: 0, plain: false };

/** 名片（星系的、项目的）的范围：名片不属于哪个对话 */
export const CARD = "card";

const cache = new Map<string, Map<string, Detail | null>>();   // 密文 → 附加校验数据 → 解开的结果（解不开是 null）
const pending = new Map<string, Set<string>>();               // 同上，正在解的
let cached = 0;
let dirty = new Set<string>();

export function setKeys(k: GroupKeys | null) {
  ATT.keys = k; cache.clear(); cached = 0; pending.clear(); dirty.clear(); ATT.version++; ATT.cardVer++;
}

/** 上次取走以后解开了附件的范围（对话编号、CARD），取走即清空 */
export function takeDirty(): Set<string> {
  const d = dirty;
  if (d.size) dirty = new Set();
  return d;
}

/**
 * 小附件的明文。sid、k：页面自己知道的这个附件该在的位置（对话、这一步的编号……；名片是星系编号、项目编号），
 * 不用服务器给的 att.k：服务器把附件挪了地方，附加校验数据就对不上，解不开。
 * scope：在后台解开以后要重拼哪里的文字，默认名片是 CARD、别的是 sid
 */
export function detailOf(att: WAtt | undefined, slot: Slot, sid: string, k: string = att?.k ?? "",
                         scope: string = slot === "card" ? CARD : sid): Detail | null {
  if (!att) return null;
  if (typeof att.x === "object") return asDetail(att.x);
  const x = att.x, aad = aadOf(slot, sid, k);   // 同一段密文放在别处要重新验
  const hit = cache.get(x)?.get(aad);
  if (hit !== undefined) return hit;
  const keys = ATT.keys;
  if (!keys) return null;
  let p = pending.get(x);
  if (p?.has(aad)) return null;
  if (!p) pending.set(x, p = new Set());
  p.add(aad);
  keys.open(x, aad)
    .then(v => asDetail(v), () => null)
    .then(d => {
      if (ATT.keys !== keys) return;
      const q = pending.get(x);
      if (q) { q.delete(aad); if (!q.size) pending.delete(x); }
      if (cached > 30000) { cache.clear(); cached = 0; }
      let m = cache.get(x);
      if (!m) cache.set(x, m = new Map());
      if (!m.has(aad)) cached++;
      m.set(aad, d);
      dirty.add(scope);
      if (scope === CARD) ATT.cardVer++;
    });
  return null;
}

export type FullResult = { ok: true; v: unknown } | { ok: false; why: "missing" | "locked" };

/** 大附件：服务器给的 x（明文、密文或 null）→ 内容 */
export async function openFull(x: string | object | null, slot: Slot, sid: string, k: string): Promise<FullResult> {
  if (x == null) return { ok: false, why: "missing" };
  if (typeof x === "object" || ATT.plain) return { ok: true, v: x };
  if (!ATT.keys) return { ok: false, why: "locked" };
  try { return { ok: true, v: await ATT.keys.open(x, aadOf(slot, sid, k)) }; } catch { return { ok: false, why: "locked" }; }
}
