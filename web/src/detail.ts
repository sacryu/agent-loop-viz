// 步骤详情：点表盘上的一步（或左边的「在问」「回答」），从右边滑出一块面板，显示完整的输入、输出、报错。
// 内容是大附件：点开时才向服务器要（演示站里由剧本直接给）。常用的几个工具单独排版，其余原样显示 JSON。
import type { FullSlot } from "@agent-loop/shared/browser";
import { openFull } from "./attach.ts";
import { T } from "./i18n.ts";
import { $, el, fmtMs } from "./util.ts";

/** 向服务器（或演示的剧本）要一个大附件：明文对象、密文，或者 null（没有） */
export type FullFetcher = (sid: string, slot: FullSlot, k: string) => Promise<string | object | null>;
let fetcher: FullFetcher = async () => null;
export function setFullFetcher(f: FullFetcher) { fetcher = f; }

let seq = 0;
export const detailOpen = () => $("detail").classList.contains("open");

export function closeDetail() {
  seq++;
  $("detail").classList.remove("open");
  $("detail").setAttribute("aria-hidden", "true");
}

const MAX_CHARS = 60_000;
const clipText = (s: string) => (s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + `\n…(+${s.length - MAX_CHARS})` : s);
const pre = (text: string, cls?: string) => el("pre", clipText(text), cls);
const kv = (k: string, v: unknown) => { const d = el("div", undefined, "kv"); d.append(el("b", k), document.createTextNode(String(v))); return d; };
const json = (v: unknown) => pre(typeof v === "string" ? v : JSON.stringify(v, null, 2));
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** 改动：旧的一行行标红、新的一行行标绿 */
function diff(oldS: string, newS: string): HTMLElement {
  const p = el("pre");
  for (const l of oldS.split("\n")) p.append(el("span", "- " + l, "del"));
  for (const l of newS.split("\n")) p.append(el("span", "+ " + l, "add"));
  return p;
}

/** structuredPatch（Edit、Write 的回应里的改动块） */
function patch(hunks: unknown): HTMLElement | null {
  if (!Array.isArray(hunks) || !hunks.length) return null;
  const p = el("pre");
  for (const h of hunks.slice(0, 50)) {
    if (!h || typeof h !== "object" || !Array.isArray((h as { lines?: unknown }).lines)) continue;
    const hh = h as { oldStart?: number; newStart?: number; lines: unknown[] };
    p.append(el("span", `@@ -${hh.oldStart ?? "?"} +${hh.newStart ?? "?"} @@`), document.createTextNode("\n"));
    for (const l of hh.lines) {
      const s = String(l);
      if (s.startsWith("-")) p.append(el("span", s, "del"));
      else if (s.startsWith("+")) p.append(el("span", s, "add"));
      else p.append(document.createTextNode(s + "\n"));
    }
  }
  return p;
}

function renderInput(tool: string, v: unknown): Node[] {
  if (typeof v === "string") return [pre(v)];
  if (!v || typeof v !== "object") return [json(v)];
  const i = v as Record<string, unknown>;
  switch (tool) {
    case "Bash": case "PowerShell":
      return [pre(String(i.command ?? "")), ...(str(i.description) ? [el("div", i.description, "muted")] : [])];
    case "Read": return [kv(T.file, i.file_path ?? ""), ...(i.offset != null || i.limit != null ? [kv("offset / limit", `${i.offset ?? 0} / ${i.limit ?? "-"}`)] : [])];
    case "Edit": return [kv(T.file, i.file_path ?? ""), diff(String(i.old_string ?? ""), String(i.new_string ?? ""))];
    case "MultiEdit":
      return [kv(T.file, i.file_path ?? ""), ...(Array.isArray(i.edits) ? i.edits.slice(0, 30).map(e => diff(String(e?.old_string ?? ""), String(e?.new_string ?? ""))) : [])];
    case "Write": return [kv(T.file, i.file_path ?? ""), pre(String(i.content ?? ""))];
    case "Grep": case "Glob":
      return [pre(String(i.pattern ?? "")), ...["path", "glob", "type", "output_mode"].filter(k => i[k] != null).map(k => kv(k, i[k]))];
    case "WebFetch": return [kv("url", i.url ?? ""), ...(str(i.prompt) ? [pre(i.prompt)] : [])];
    case "WebSearch": return [pre(String(i.query ?? ""))];
    case "Agent": case "Task":
      return [...(str(i.description) ? [kv("", i.description)] : []), ...(str(i.subagent_type) ? [kv("type", i.subagent_type)] : []),
        ...(str(i.prompt) ? [pre(i.prompt)] : [])];
  }
  return [json(v)];
}

function renderOutput(tool: string, v: unknown, failed: boolean): Node[] {
  if (typeof v === "string") return [pre(v, failed ? "err" : undefined)];
  if (Array.isArray(v)) {   // MCP 工具常见：[{type:"text", text:"…"}]
    const texts = v.map(x => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : null));
    if (texts.every(t => t != null)) return [pre(texts.join("\n"))];
    return [json(v)];
  }
  if (!v || typeof v !== "object") return [json(v)];
  const o = v as Record<string, unknown>;
  switch (tool) {
    case "Bash": case "PowerShell": {
      const out: Node[] = [];
      if (str(o.stdout)) out.push(pre(o.stdout));
      if (str(o.stderr)) out.push(el("h3", T.stderr), pre(o.stderr, "err"));
      return out.length ? out : [el("div", "—", "muted")];
    }
    case "Read": {
      const f = o.file as Record<string, unknown> | undefined;
      if (f && typeof f === "object" && typeof f.content === "string") return [pre(f.content)];
      break;
    }
    case "Edit": case "MultiEdit": case "Write": {
      const p = patch(o.structuredPatch);
      if (p) return [p];
      break;
    }
    case "Grep":
      if (str(o.content)) return [pre(o.content)];
      if (Array.isArray(o.filenames)) return [el("div", T.files(Number(o.numFiles ?? o.filenames.length)), "muted"), pre(o.filenames.join("\n"))];
      break;
    case "Glob":
      if (Array.isArray(o.filenames)) return [el("div", T.files(Number(o.numFiles ?? o.filenames.length)), "muted"), pre(o.filenames.join("\n"))];
      break;
  }
  return [json(v)];
}

export interface DetailPart { label: string; slot: FullSlot; k: string; tool?: string; kind: "in" | "out" | "text"; failed?: boolean }

/**
 * 打开详情面板。kicker：小标题；title：短句；meta：耗时、报错第一行
 */
export function openDetail(o: { sid: string; kicker: string; title: string; meta?: string; err?: string; parts: DetailPart[] }) {
  const my = ++seq;
  $("d-kicker").textContent = o.kicker;
  $("d-title").textContent = o.title;
  const meta = $("d-meta");
  meta.textContent = o.meta || "";
  if (o.err) { if (o.meta) meta.append(document.createTextNode(" · ")); meta.append(el("span", o.err, "err")); }
  const body = $("d-body");
  body.textContent = "";
  for (const part of o.parts) {
    const box = el("section");
    box.append(el("h3", part.label), el("div", T.detailLoading, "muted"));
    body.append(box);
    fetcher(o.sid, part.slot, part.k)
      .then(x => openFull(x, part.slot, o.sid, part.k))
      .then(r => {
        if (my !== seq) return;
        box.lastChild?.remove();
        if (!r.ok) {
          const msg = r.why === "locked" ? T.detailLocked : T.detailGone;
          box.append(el("div", msg, "muted"));
          return;
        }
        const nodes = part.kind === "in" ? renderInput(part.tool || "", r.v) : part.kind === "out" ? renderOutput(part.tool || "", r.v, !!part.failed) : [pre(String(r.v))];
        box.append(...nodes);
      })
      .catch(() => { if (my === seq) { box.lastChild?.remove(); box.append(el("div", T.detailGone, "muted")); } });
  }
  $("detail").classList.add("open");
  $("detail").setAttribute("aria-hidden", "false");
}

$("d-close").title = T.detailClose;
$("d-close").onclick = () => closeDetail();
