// 星系的状态机：一个星系 = 一个安装（一台机器上的一份插件）。以 Python 版 agentloop/state.py 为蓝本重写，
// 服务器和演示站（在浏览器里）跑的是同一份：这里不用 Node 的模块，也不自己取时间（时间都是传进来的）。
// 去掉了所有文字（标题、主句、旁白、摘要）、会话记录的解析和回填、进程登记、状态栏、文件冲突和已读。
//
// 输入只有规范化后的事件（shared/protocol.ts），时间 t 已经换算成服务器时钟（ts + 偏移量）。
// 状态机只读匿名字段。附件（本机是明文对象，别处是密文）看不懂也不解读，只按事件类型放到对应的位置
// （对话、这一步、子 agent、项目和星系的名片），随细节层推给浏览器。大附件不在这里，见 server/src/fullstore.ts。
import type { Event } from "./protocol.ts";   // 只要类型：浏览器里不打包 zod
import { slotsOf } from "./attach.ts";
import { branchOf, type Branch, type ToolKind } from "./tools.ts";
import {
  MAX_STEPS, STATUS_CODE,
  type Phase, type Status, type SummaryRow, type WAtt, type WireGalaxy, type WireProject, type WireSession, type WireStep, type WireSub,
} from "./wire.ts";

/** 一条事件的小附件（本机的明文或别处的密文），带上它的键。没有就是 undefined */
export function smallAtt(ev: Event, k: string): WAtt | undefined {
  const x = ev.detail ?? ev.enc;
  return x === undefined ? undefined : { k, x };
}

export const WORKING = "working", WAITING = "waiting", DONE = "done", ERROR = "error", IDLE = "idle";
export const THINK = "think", ACT = "act";

const WAIT_NOTIFICATIONS = new Set(["permission_prompt", "elicitation_dialog", "agent_needs_input"]);

export interface Limits {
  maxSessions: number;      // 每个安装最多几个会话
  staleMs: number;          // 多久没有事件（也没有报过还开着）标成「可能已关闭」
  removeMs: number;         // 多久没有事件（也没有报过还开着）移除会话
  thinkStuckMs: number;     // 在想、没有工具和后台任务、这么久没有事件：回到待命（拿不到 Esc 打断的兜底）
  subFadeMs: number;        // 子 agent 结束后还列多久
  endedTtlMs: number;       // 收到 SessionEnd 以后，这段时间内迟到的事件不让它复活
  batchFallbackMs: number;  // 没有 PostToolBatch 的旧版本：工具全部结束多久后算一圈结束
}

export const DEFAULT_LIMITS: Limits = {
  maxSessions: 50, staleMs: 30 * 60_000, removeMs: 24 * 3600_000, thinkStuckMs: 120_000, subFadeMs: 2_000,
  endedTtlMs: 60_000, batchFallbackMs: 1_500,
};

export interface Step extends WireStep { u: number }

interface Tool { kind: ToolKind; start: number; typeH?: string }

interface Sub {
  id: string; type: string; typeH?: string; status: Status; phase: Phase; phaseSince: number; started: number;
  tools: Map<string, number>; ended: number | null; toolId: string | null; d?: WAtt;
}

export interface Tick { ms: number; err: boolean; waited: boolean; n: number }

export class Session {
  sid: string; proj: string; born: number;
  status: Status = IDLE; statusSince: number;
  phase: Phase = THINK; phaseSince: number;
  roundNo = 0; roundId: string | null = null; roundSince: number; doneSince: number | null = null;
  laps = 0;                 // 这一轮已经跑完的圈数
  lapsBefore = 0;           // 这一轮之前累计的圈数（服务器见到的，和会话记录里数出来的取大的，见 floorCounts）
  ticks: Tick[] = [];
  lapStart: number; lapErr = false; lapWaited = false;
  tools = new Map<string, Tool>();
  toolsEmptySince: number | null = null;
  compacting = false; compactFromIdle = false;
  bgWait = false; bgCount = 0; bgSince: number | null = null;
  waitSince: number | null = null; waitKind: WireSession["wait_kind"] = null; waitToolId: string | null = null;
  waitBranch: Branch | "sub" | null = null;
  errKind: string | null = null;
  subagents = new Map<string, Sub>();
  steps: Step[] = [];
  stepsTotal = 0;
  lastEvent: number; stale = false;
  /** 插件最近一次替它报「还开着」（Alive）的时间。只用来判断变暗和移除，不算动静（lastEvent 不变） */
  aliveAt = 0;
  model: string | null = null;
  ctxTok: number | null = null; outTok: number | null = null;
  title?: WAtt; first?: WAtt; ask?: WAtt; ans?: WAtt;

  constructor(sid: string, proj: string, t: number) {
    this.sid = sid; this.proj = proj; this.born = t;
    this.statusSince = this.phaseSince = this.roundSince = this.lapStart = this.lastEvent = t;
  }

  get lapsTotal() { return this.lapsBefore + this.laps; }

  /**
   * 插件从会话记录里数出来的圈数、步数（laps、steps）：只拿来当下限，补上服务器没见到的部分
   * （服务器重启过、会话中途才接上）。只在没有圈正在跑的时候调用：那时记录里的回答都已经是跑完的圈
   */
  floorCounts(laps: number | undefined, steps: number | undefined) {
    if (laps != null && laps > this.lapsTotal) this.lapsBefore += laps - this.lapsTotal;
    if (steps != null && steps > this.stepsTotal) this.stepsTotal = steps;
  }

  setStatus(st: Status, t: number) { if (st !== this.status) { this.status = st; this.statusSince = t; } }
  setPhase(ph: Phase, t: number) { if (ph !== this.phase) { this.phase = ph; this.phaseSince = t; } }

  newRound(t: number, promptId: string | null) {
    this.lapsBefore += this.laps;
    this.roundNo += 1; this.roundId = promptId; this.roundSince = t;
    this.laps = 0; this.ticks = []; this.lapStart = t; this.lapErr = this.lapWaited = false;
    this.tools.clear(); this.toolsEmptySince = null;
    this.bgWait = false; this.doneSince = null; this.errKind = null;
  }

  endBgWait() { this.bgWait = false; this.bgSince = null; }

  endLap(t: number, at?: number) {
    const end = at ?? t, lap = this.lapsTotal + 1;
    const mine = this.steps.filter(x => x.lap === lap && !x.agent);
    const real = mine.filter(x => x.kind !== "progress");
    this.ticks.push({ ms: Math.max(0, end - this.lapStart), err: this.lapErr, waited: this.lapWaited, n: real.length });
    this.laps += 1; this.lapStart = end; this.lapErr = this.lapWaited = false;
    this.tools.clear(); this.toolsEmptySince = null;
  }

  statusCode(): string {
    if (this.stale) return STATUS_CODE.stale;
    switch (this.status) {
      case WORKING: return this.bgWait && this.phase === THINK ? STATUS_CODE.bg : this.phase === ACT ? STATUS_CODE.act : STATUS_CODE.think;
      case WAITING: return STATUS_CODE.waiting;
      case DONE: return STATUS_CODE.done;
      case ERROR: return STATUS_CODE.error;
      default: return STATUS_CODE.idle;
    }
  }

  wire(): WireSession {
    const subs: WireSub[] = [...this.subagents.values()].map(a => ({
      id: a.id, type: a.type, status: a.status, phase: a.phase, phase_since: a.phaseSince, started: a.started,
      ended: a.ended, tool_id: a.toolId, ...(a.d ? { d: a.d } : {}),
    }));
    return {
      sid: this.sid, proj: this.proj, born: this.born, status: this.status, status_since: this.statusSince,
      phase: this.phase, phase_since: this.phaseSince, round: this.roundNo, round_since: this.roundSince,
      laps: this.lapsTotal, steps_total: this.stepsTotal,
      wait_sub: this.status === WAITING && this.waitBranch === "sub",
      wait_kind: this.status === WAITING ? this.waitKind : null,
      bg: this.status === WORKING && this.bgWait ? this.bgCount : 0,
      bg_since: this.status === WORKING && this.bgWait ? this.bgSince : null,
      compacting: this.compacting, err_kind: this.status === ERROR ? this.errKind : null,
      stale: this.stale, last_event: this.lastEvent, running: this.tools.size, subagents: subs, model: this.model,
      ctx_tok: this.ctxTok, out_tok: this.outTok,
      ...(this.title ? { title: this.title } : {}), ...(this.first ? { first: this.first } : {}),
      ...(this.ask ? { ask: this.ask } : {}), ...(this.ans ? { ans: this.ans } : {}),
    };
  }
}

interface Project { id: string; card?: WAtt; seq: number; emptySince: number | null }

/** 网页上显示用的时间、步骤的变化都记在 u（单调递增），推送增量时只发上次以后变过的 */
export class Galaxy {
  readonly id: string;
  limits: Limits;
  sessions = new Map<string, Session>();
  projects = new Map<string, Project>();
  private projectSeq = 0;
  private ended = new Map<string, number>();
  batchSupported = false;
  /** 星系的名片：最新一条 SessionStart 的小附件（里面有星系的名字） */
  card?: WAtt;
  emptySince: number | null = null;
  lastEvent = 0;
  // 推送用
  u = 0;
  dirty = new Set<string>();       // 变过的会话
  gone = new Set<string>();        // 移除了的会话
  layoutDirty = false;
  sumDirty = true;
  flushedU = 0;
  /** 会话被移除时（服务器用它清掉这个会话的大附件） */
  onRemove?: (sid: string) => void;

  constructor(id: string, t: number, limits: Limits = DEFAULT_LIMITS) {
    this.id = id; this.limits = limits; this.emptySince = t;
  }

  private touch(s: Session) { this.dirty.add(s.sid); this.sumDirty = true; }

  // ------------------------------------------------------------ 事件

  handle(ev: Event, t: number): void {
    this.apply(ev, t);
    this.markFull(ev);
  }

  /** 这条事件带着大附件：在对应的那一步（或这一轮的「在问」「回答」）上记一笔。页面上只有记过的地方能点开 */
  private markFull(ev: Event) {
    if (ev.detail_full == null && ev.enc_full == null) return;
    const s = this.sessions.get(ev.sid), slot = slotsOf(ev).full;
    if (!s || !slot) return;
    if (slot.slot === "full-in" || slot.slot === "full-out") {
      const st = this.findStep(s, slot.k), key = slot.slot === "full-in" ? "fin" : "fout";
      if (!st || st[key]) return;
      st[key] = true; st.u = ++this.u;
    } else if (slot.slot === "full-ask" && s.ask && s.ask.k === slot.k && !s.ask.f) s.ask = { ...s.ask, f: true };
    else if (slot.slot === "full-ans" && s.ans && s.ans.k === slot.k && !s.ans.f) s.ans = { ...s.ans, f: true };
    else return;
    this.touch(s);
  }

  private apply(ev: Event, t: number): void {
    const name = ev.ev, sid = ev.sid;
    if (name === "PostToolBatch") this.batchSupported = true;
    if (name === "Alive") return this.onAlive(ev, t);
    let s = this.sessions.get(sid);
    if (!s) {
      if (name === "SessionEnd") return;
      const endedAt = this.ended.get(sid);
      // 刚结束的会话：退出前发出、迟到的事件不让它复活。--resume 沿用原来的 session_id，SessionStart 照常新建
      if (endedAt != null && t - endedAt < this.limits.endedTtlMs && name !== "SessionStart") return;
      if (this.sessions.size >= this.limits.maxSessions) return;
      s = this.newSession(ev, t);
    }
    this.lastEvent = Math.max(this.lastEvent, t);
    s.lastEvent = Math.max(s.lastEvent, t);
    s.stale = false;
    this.touch(s);
    if (!ev.agent) {
      if (ev.ctx_tok != null) s.ctxTok = ev.ctx_tok;
      if (ev.out_tok != null) s.outTok = ev.out_tok;
      // 对话的标题：插件从会话记录里读到的，有就换上（/rename 以后会变）
      const tx = ev.title ?? ev.enc_title;
      if (tx !== undefined) s.title = { k: "", x: tx };
    }

    const aid = ev.agent;
    if (aid && !["SubagentStart", "SubagentStop", "SessionStart", "SessionEnd", "UserPromptSubmit"].includes(name)) {
      this.handleSub(s, aid, ev, t);
      return;
    }

    // 「等你」时收到任何后续事件，就退出等待（手动拒绝没有专门的事件）
    if (s.status === WAITING && !["PermissionRequest", "Notification", "SubagentStart", "SubagentStop"].includes(name)) {
      const tid = ev.tool;
      const sameTool = s.waitToolId == null || tid == null || tid === s.waitToolId;
      if (!["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(name) || sameTool) this.exitWait(s, t);
    }

    // 错过了 UserPromptSubmit：凭 prompt_id 判断进入了新的一轮
    const pid = ev.prompt;
    if (pid && !["UserPromptSubmit", "SessionStart", "SessionEnd", "Stop", "StopFailure", "Notification"].includes(name)
        && (s.status === IDLE || s.status === DONE || s.status === ERROR) && s.roundId && pid !== s.roundId) {
      s.newRound(t, pid);
    }

    switch (name) {
      case "SessionStart": return this.onSessionStart(s, ev, t);
      case "SessionEnd": return this.onSessionEnd(s, t);
      case "UserPromptSubmit": return this.onUserPromptSubmit(s, ev, t);
      case "PreToolUse": return this.onPreToolUse(s, ev, t);
      case "PermissionRequest": return this.onPermissionRequest(s, ev, t);
      case "Notification": return this.onNotification(s, ev, t);
      case "PostToolUse": return this.onPostToolUse(s, ev, t, false);
      case "PostToolUseFailure": return this.onPostToolUse(s, ev, t, true);
      case "PermissionDenied": return this.onPermissionDenied(s, ev, t);
      case "PostToolBatch": return this.onPostToolBatch(s, t);
      case "SubagentStart": return this.onSubagentStart(s, ev, t);
      case "SubagentStop": return this.onSubagentStop(s, ev, t);
      case "PreCompact": return this.onPreCompact(s, t);
      case "PostCompact": return this.endCompact(s, t);
      case "Stop": return this.onStop(s, ev, t);
      case "StopFailure": return this.onStopFailure(s, ev, t);
    }
  }

  private newSession(ev: Event, t: number): Session {
    const s = new Session(ev.sid, ev.proj, t);
    this.sessions.set(s.sid, s);
    let p = this.projects.get(ev.proj);
    if (!p) { p = { id: ev.proj, seq: ++this.projectSeq, emptySince: null }; this.projects.set(p.id, p); }
    p.emptySince = null;
    this.emptySince = null;
    this.layoutDirty = true;
    return s;
  }

  private onSessionStart(s: Session, ev: Event, t: number) {
    this.ended.delete(s.sid);
    if (s.status === IDLE || s.status === DONE || s.status === ERROR) s.floorCounts(ev.laps, ev.steps);
    if (ev.model) s.model = ev.model;
    const card = smallAtt(ev, ev.proj);
    if (card) {
      const p = this.projects.get(s.proj);
      if (p) { p.card = card; this.layoutDirty = true; }
      this.card = card;
      this.sumDirty = true;
    }
    if (ev.source === "compact" && s.compacting) this.endCompact(s, t);
  }

  /**
   * 插件替开着、却安静了很久的会话报了一声「还开着」（这个会话自己没有动静，是同一台机器上别的会话替它报的）。
   * 不是动静：状态、圈、lastEvent 都不动，只记下时间，看门狗据此不变暗、不移除。
   * 服务器上没有这个会话（服务器重启过、超时移除过）：按待命新建，名片、标题、圈数步数、模型、token 数靠事件带的补上。
   * 刚结束的会话不让它复活（和别的迟到的事件一样）
   */
  private onAlive(ev: Event, t: number) {
    let s = this.sessions.get(ev.sid);
    if (!s) {
      const endedAt = this.ended.get(ev.sid);
      if (endedAt != null && t - endedAt < this.limits.endedTtlMs) return;
      if (this.sessions.size >= this.limits.maxSessions) return;
      s = this.newSession(ev, t);
      s.floorCounts(ev.laps, ev.steps);
      if (ev.model) s.model = ev.model;
      if (ev.ctx_tok != null) s.ctxTok = ev.ctx_tok;
      if (ev.out_tok != null) s.outTok = ev.out_tok;
      this.fillCard(s, ev);
    }
    const tx = ev.title ?? ev.enc_title;
    if (tx !== undefined && !s.title) s.title = { k: "", x: tx };
    this.lastEvent = Math.max(this.lastEvent, t);
    s.aliveAt = Math.max(s.aliveAt, t);
    s.stale = false;
    this.touch(s);
  }

  private onSessionEnd(s: Session, t: number) {
    this.ended.set(s.sid, t);
    this.removeSession(s.sid, t);
  }

  /**
   * UserPromptSubmit 补发的名片：只在项目、星系还没有名片时用（会话开始那条事件没送到：服务器重启过、会话中途才设好插件）。
   * 有了就不换：名片以 SessionStart 发的为准，而且密文每次都不一样，换了页面就要重新解一遍
   */
  private fillCard(s: Session, ev: Event) {
    const x = ev.card ?? ev.enc_card;
    if (x === undefined) return;
    const att: WAtt = { k: s.proj, x };
    const p = this.projects.get(s.proj);
    if (p && !p.card) { p.card = att; this.layoutDirty = true; }
    if (!this.card) { this.card = att; this.sumDirty = true; }
  }

  private onUserPromptSubmit(s: Session, ev: Event, t: number) {
    this.fillCard(s, ev);
    // 工作中途送达的后台任务通知（以及子 agent 交回的结果）会被并进当前这一轮；排队的消息 prompt_id 不变，也并进来
    const pid = ev.prompt ?? null;
    if ((s.status === WORKING || s.status === WAITING) && ((pid && pid === s.roundId) || ev.task_note)) {
      // 后台任务跑完的通知把模型叫醒了：在跑的少一个，模型接着想，不再是「只在等后台」
      if (ev.task_note && s.bgCount) s.bgCount -= 1;
      if (s.bgWait) {
        s.endBgWait();
        s.setPhase(THINK, t);
        s.phaseSince = t;
      }
      return;
    }
    s.floorCounts(ev.laps, ev.steps);   // 上一轮已经结束（或者服务器刚见到这个会话）：记录里的都是跑完的圈
    s.newRound(t, pid);
    s.setStatus(WORKING, t);
    s.phase = THINK; s.phaseSince = t;
    // 这一轮在问什么；服务器见到的第一句话留着，还没有标题时当标题。后台任务的通知不算（插件也不给它附件）
    const ask = smallAtt(ev, pid ?? "");
    s.ask = ask; s.ans = undefined;
    if (ask && !s.first) s.first = ask;
  }

  private work(s: Session, t: number) {
    if (s.bgWait) s.endBgWait();   // 错过了通知也不要紧：模型动手了，就不是在等后台
    if (s.status === IDLE || s.status === DONE || s.status === ERROR) {
      s.setStatus(WORKING, t);
      s.doneSince = null;
      if (s.phaseSince < s.roundSince) s.phaseSince = t;
    }
  }

  private onPreToolUse(s: Session, ev: Event, t: number) {
    const tid = ev.tool ?? `anon-${t}`;
    const kind = ev.kind ?? "other";
    // 乱序的残余：这一步的结束已经先到了，就不再把它当成在跑
    const had = this.findStep(s, tid);
    if (had && had.end != null) { this.attachStep(had, ev); return; }
    this.work(s, t);
    if (s.phase === THINK) s.setPhase(ACT, t);
    s.tools.set(tid, { kind, start: t, typeH: ev.agent_type_h });
    s.toolsEmptySince = null;
    this.recordStep(s, tid, kind, t, undefined, ev.tool ? smallAtt(ev, ev.tool) : undefined);
    if (kind === "ask") this.enterWait(s, t, "ask", tid, null);
    else if (kind === "plan") this.enterWait(s, t, "plan", tid, null);
  }

  private onPermissionRequest(s: Session, ev: Event, t: number) {
    this.work(s, t);
    if (ev.tool) { const st = this.findStep(s, ev.tool); if (st) this.attachStep(st, ev); }
    const kind = ev.kind ?? "other";
    const tid = ev.tool ?? this.matchTool(s, kind);
    this.enterWait(s, t, "permission", tid, branchOf(kind));
  }

  private onNotification(s: Session, ev: Event, t: number) {
    const nt = ev.ntype ?? "";
    if (!WAIT_NOTIFICATIONS.has(nt) || s.status === WAITING) return;
    if (nt === "permission_prompt") {
      const running = [...s.tools.entries()].sort((a, b) => a[1].start - b[1].start);
      const last = running[running.length - 1];
      this.enterWait(s, t, "permission", last ? last[0] : null, last ? branchOf(last[1].kind) : null);
    } else {
      this.enterWait(s, t, "input", null, null);
    }
  }

  private onPostToolUse(s: Session, ev: Event, t: number, failed: boolean) {
    let tid = ev.tool ?? null;
    let tool = tid ? s.tools.get(tid) : undefined;
    if (tid) s.tools.delete(tid);
    if (!tool && s.tools.size && !tid) {
      // 没有 tool_use_id 的旧版本：按类别找最早的那个
      const k = [...s.tools.entries()].find(([, v]) => v.kind === ev.kind)?.[0];
      if (k) { tool = s.tools.get(k); s.tools.delete(k); tid = k; }
    }
    if (failed) s.lapErr = true;
    this.finishStep(s, tid, t, failed, ev.duration_ms, ev.kind, undefined, ev);
    if (failed && ev.interrupt) { this.toIdle(s, t); return; }
    if (!s.tools.size && s.phase === ACT) s.toolsEmptySince = t;
  }

  private onPermissionDenied(s: Session, ev: Event, t: number) {
    s.lapErr = true;
    const tid = ev.tool;
    if (tid && s.tools.has(tid)) {
      s.tools.delete(tid);
      this.finishStep(s, tid, t, true, undefined, ev.kind);
    }
    if (!s.tools.size && s.phase === ACT) s.toolsEmptySince = t;
  }

  private onPostToolBatch(s: Session, t: number) {
    this.work(s, t);
    s.endLap(t);
    s.setPhase(THINK, t);
    s.phaseSince = t;
  }

  private onSubagentStart(s: Session, ev: Event, t: number) {
    const aid = ev.agent;
    if (aid) {
      const old = s.subagents.get(aid);
      if (!old || old.ended != null) {
        s.subagents.set(aid, { id: aid, type: ev.agent_type ?? "custom", typeH: ev.agent_type_h, status: WORKING, phase: THINK,
          started: t, phaseSince: t, tools: new Map(), ended: null, toolId: this.spawnedBy(s, ev.agent_type_h),
          d: smallAtt(ev, aid) });
      }
    }
    // 等的正是「派子 agent」这次调用：子 agent 启动了，说明你已经批准
    if (s.status === WAITING && s.waitToolId && s.tools.get(s.waitToolId)?.kind === "agent") this.exitWait(s, t);
  }

  /** 这个子 agent 是主对话里哪一次「派子 agent」派出去的：在跑的派遣里，先挑类型对得上、还没认领的，
   *  按开始时间先来先得；再挑不知道类型的；还没有才随便挑一个没认领的；都认领过了，就算最近那一次的。 */
  private spawnedBy(s: Session, typeH: string | undefined): string | null {
    const running = [...s.tools.entries()].filter(([, x]) => x.kind === "agent").sort((a, b) => a[1].start - b[1].start);
    if (!running.length) return null;
    const taken = new Set([...s.subagents.values()].filter(a => a.ended == null).map(a => a.toolId));
    const free = running.filter(([k]) => !taken.has(k));
    const same = free.filter(([, x]) => typeH && x.typeH === typeH).map(([k]) => k);
    const unknown = free.filter(([, x]) => !typeH || !x.typeH).map(([k]) => k);
    return (same.length ? same : unknown.length ? unknown : free.length ? free.map(([k]) => k) : [running[running.length - 1][0]])[0];
  }

  private onSubagentStop(s: Session, ev: Event, t: number) {
    const aid = ev.agent;
    const a = aid ? s.subagents.get(aid) : undefined;
    if (a && a.ended == null) { a.status = DONE; a.ended = t; a.tools.clear(); }
    // 在等授权的就是这个子 agent：它结束了，对话框也就没了。别的子 agent 结束不算
    if (aid && s.status === WAITING && s.waitToolId === "sub:" + aid) this.exitWait(s, t);
  }

  private onPreCompact(s: Session, t: number) {
    s.compacting = true;
    if (s.status === IDLE || s.status === DONE || s.status === ERROR) {
      s.compactFromIdle = true;
      this.work(s, t);
      s.setPhase(THINK, t);
      s.phaseSince = t;
    }
  }

  private endCompact(s: Session, t: number) {
    s.compacting = false;
    if (s.compactFromIdle) { s.compactFromIdle = false; s.setStatus(IDLE, t); }
  }

  private onStop(s: Session, ev: Event, t: number) {
    const bg = ev.bg ?? 0;
    if (ev.model) s.model = ev.model;
    const ans = smallAtt(ev, ev.prompt ?? "");
    if (ans) s.ans = ans;
    if (bg > 0) {
      if (!s.bgWait) s.bgSince = t;
      s.bgWait = true;
      s.bgCount = bg;
      s.setStatus(WORKING, t);
      if (s.phase === ACT && !s.tools.size) s.endLap(t);
      s.setPhase(THINK, t);
      return;
    }
    if (s.status === WORKING || s.status === WAITING || s.phase === ACT || s.tools.size) s.endLap(t);
    s.floorCounts(ev.laps, ev.steps);   // 回答完了，没有在跑的圈（记录可能还差最后一条没写进去：只当下限，少了不要紧）
    s.compacting = s.compactFromIdle = false;
    s.bgWait = false; s.bgCount = 0;
    s.setPhase(THINK, t);
    s.setStatus(DONE, t);
    s.doneSince = t;
  }

  private onStopFailure(s: Session, ev: Event, t: number) {
    s.tools.clear();
    s.setStatus(ERROR, t);
    s.errKind = ev.err_kind ?? "other";
    s.doneSince = t;
  }

  // ---- 子 agent 的事件：只驱动对应的小球

  private handleSub(s: Session, aid: string, ev: Event, t: number) {
    const name = ev.ev;
    const a = s.subagents.get(aid);
    if (!a && name !== "PermissionRequest") return;   // 没见过 SubagentStart 也照样提醒你授权
    if (a && a.status === WAITING && name !== "PermissionRequest" && name !== "Notification") {
      a.status = WORKING;
      if (s.status === WAITING && s.waitToolId === "sub:" + aid) this.exitWait(s, t);
    }
    if (name === "PreToolUse" && a) {
      if (a.phase !== ACT) { a.phase = ACT; a.phaseSince = t; }
      const tid = ev.tool ?? `anon-${t}`;
      a.tools.set(tid, t);
      const had = this.findStep(s, tid);
      if (had) this.attachStep(had, ev);
      else this.recordStep(s, tid, ev.kind ?? "other", t, aid, ev.tool ? smallAtt(ev, ev.tool) : undefined);
    } else if ((name === "PostToolUse" || name === "PostToolUseFailure") && a) {
      if (ev.tool) a.tools.delete(ev.tool);
      this.finishStep(s, ev.tool ?? null, t, name === "PostToolUseFailure", ev.duration_ms, ev.kind, aid, ev);
    } else if (name === "PostToolBatch" && a) {
      a.phase = THINK; a.phaseSince = t; a.tools.clear();
    } else if (name === "PermissionRequest" || (name === "Notification" && WAIT_NOTIFICATIONS.has(ev.ntype ?? ""))) {
      if (a) a.status = WAITING;
      if (name === "PermissionRequest" && ev.tool) { const st = this.findStep(s, ev.tool); if (st) this.attachStep(st, ev); }
      if (s.status !== WAITING) this.enterWait(s, t, name === "PermissionRequest" ? "permission" : "input", "sub:" + aid, "sub");
    }
  }

  // ---- 等待

  private matchTool(s: Session, kind: ToolKind): string | null {
    const c = [...s.tools.entries()].filter(([, v]) => v.kind === kind);
    return c.length ? c[c.length - 1][0] : null;
  }

  private enterWait(s: Session, t: number, kind: WireSession["wait_kind"], toolId: string | null, branch: Branch | "sub" | null) {
    if (s.status !== WAITING) s.waitSince = t;
    s.setStatus(WAITING, t);
    s.waitKind = kind; s.waitToolId = toolId; s.waitBranch = branch;
    s.lapWaited = true;
  }

  private exitWait(s: Session, t: number) {
    s.setStatus(WORKING, t);
    s.waitSince = null; s.waitToolId = null;
    for (const a of s.subagents.values()) if (a.status === WAITING) a.status = WORKING;
  }

  private toIdle(s: Session, t: number) {
    s.tools.clear(); s.toolsEmptySince = null;
    s.waitSince = null; s.waitToolId = null;
    s.compacting = s.compactFromIdle = s.bgWait = false;
    s.setPhase(THINK, t);
    s.setStatus(IDLE, t);
  }

  // ---- 步骤

  private findStep(s: Session, id: string): Step | undefined {
    for (let i = s.steps.length - 1; i >= 0; i--) if (s.steps[i].id === id) return s.steps[i];
    return undefined;
  }

  private recordStep(s: Session, id: string, kind: ToolKind, t: number, agent?: string, d?: WAtt): Step {
    if (s.steps.length >= MAX_STEPS) s.steps = s.steps.slice(-(MAX_STEPS - 100));
    const st: Step = { id, lap: s.lapsTotal + 1, round: s.roundNo, kind, start: t, end: null, err: false, u: ++this.u };
    if (agent) st.agent = agent; else s.stepsTotal += 1;
    if (d) st.d = d;
    s.steps.push(st);
    return st;
  }

  /** PreToolUse / PermissionRequest 的小附件补到已经有的那一步上（乱序、或者授权请求先到） */
  private attachStep(st: Step, ev: Event) {
    if (st.d || !ev.tool) return;
    const d = smallAtt(ev, ev.tool);
    if (d) { st.d = d; st.u = ++this.u; }
  }

  private finishStep(s: Session, id: string | null, t: number, failed: boolean, durationMs?: number, kind?: ToolKind,
                     agent?: string, ev?: Event) {
    if (!id) return;
    let st = this.findStep(s, id);
    if (!st) {
      // 乱序的残余：没见过开始就先到了结束。照样记一步，算它已经结束
      st = this.recordStep(s, id, kind ?? "other", t, agent);
    }
    st.end = t;
    if (durationMs) st.start = t - Math.round(durationMs);
    st.err = failed;
    if (failed && ev) { const e = smallAtt(ev, id); if (e) st.e = e; }
    st.u = ++this.u;
  }

  // ------------------------------------------------------------ 看门狗

  /** 每 0.5 秒一次。返回有没有东西变了 */
  watchdog(t: number): boolean {
    let changed = false;
    for (const [sid, at] of this.ended) if (t - at > this.limits.endedTtlMs) this.ended.delete(sid);
    for (const s of [...this.sessions.values()]) {
      let c = false;
      // 子 agent 淡出后移除
      for (const [aid, a] of s.subagents) {
        if (a.ended != null && t - a.ended > this.limits.subFadeMs + 500) { s.subagents.delete(aid); c = true; }
      }
      // 没有 PostToolBatch 的旧版本：工具全部结束 1.5 秒后视为这一圈结束
      if (!this.batchSupported && s.status === WORKING && s.phase === ACT && !s.tools.size && s.toolsEmptySince != null
          && t - s.toolsEmptySince > this.limits.batchFallbackMs) {
        s.endLap(t, s.toolsEmptySince);
        s.setPhase(THINK, t);
        s.phaseSince = s.lapStart;
        c = true;
      }
      const quiet = t - s.lastEvent, unheard = t - Math.max(s.lastEvent, s.aliveAt);
      // 拿不到「在想的时候按 Esc 打断」：在想、没有工具和后台任务在跑、两分钟没有任何事件，就回到待命
      if (s.status === WORKING && !s.tools.size && !s.bgWait && quiet > this.limits.thinkStuckMs
          && ![...s.subagents.values()].some(a => a.ended == null)) {
        this.toIdle(s, t);
        c = true;
      }
      // 可能已关闭（变暗）。等你授权不在此列：对话框还开着就仍然需要你
      // 插件报过还开着（Alive）的，从那时算起
      if (!s.stale && s.status !== WAITING && unheard > this.limits.staleMs) {
        s.stale = true;
        c = true;
      }
      if (unheard > this.limits.removeMs) {
        this.removeSession(s.sid, t);
        changed = true;
        continue;
      }
      if (c) { this.touch(s); changed = true; }
    }
    // 空了的项目先记住位置一会儿：/clear 时旧会话先结束、新会话后到，轨道不能跳到最外面
    for (const [id, p] of this.projects) {
      if (p.emptySince != null && t - p.emptySince > 15_000) { this.projects.delete(id); this.layoutDirty = true; changed = true; }
    }
    return changed;
  }

  removeSession(sid: string, t: number) {
    const s = this.sessions.get(sid);
    if (!s) return;
    this.sessions.delete(sid);
    this.onRemove?.(sid);
    this.dirty.delete(sid);
    this.gone.add(sid);
    this.sumDirty = true;
    this.layoutDirty = true;
    if (![...this.sessions.values()].some(x => x.proj === s.proj)) {
      const p = this.projects.get(s.proj);
      if (p) p.emptySince = t;
    }
    if (!this.sessions.size) this.emptySince = t;
  }

  // ------------------------------------------------------------ 输出

  /** 轨道从内到外：项目按第一次出现的先后；轨道上的对话按出现的先后 */
  layout(): WireProject[] {
    const out: WireProject[] = [];
    for (const p of [...this.projects.values()].sort((a, b) => a.seq - b.seq)) {
      const sids = [...this.sessions.values()].filter(s => s.proj === p.id)
        .sort((a, b) => a.born - b.born || (a.sid < b.sid ? -1 : 1)).map(s => s.sid);
      if (!sids.length) continue;
      const w: WireProject = { id: p.id, sids };
      if (p.card) w.card = p.card;
      out.push(w);
    }
    return out;
  }

  summary(): SummaryRow {
    const lay = this.layout();
    const row: SummaryRow = [this.id, lay.length, lay.flatMap(p => p.sids).map(sid => this.sessions.get(sid)!.statusCode()).join("")];
    if (this.card) row.push(this.card);
    return row;
  }

  full(): WireGalaxy {
    const steps: Record<string, WireStep[]> = {};
    for (const s of this.sessions.values()) steps[s.sid] = s.steps.map(stripU);
    const g: WireGalaxy = { id: this.id, projects: this.layout(), sessions: [...this.sessions.values()].map(s => s.wire()), steps };
    if (this.card) g.card = this.card;
    return g;
  }

  /** 上次推送以后的增量。调用后清掉变化记录 */
  delta(): { projects: WireProject[]; sessions: WireSession[]; steps: Record<string, WireStep[]>; gone: string[] } | null {
    if (!this.dirty.size && !this.gone.size && !this.layoutDirty) return null;
    const since = this.flushedU;
    const sessions: WireSession[] = [], steps: Record<string, WireStep[]> = {};
    for (const sid of this.dirty) {
      const s = this.sessions.get(sid);
      if (!s) continue;
      sessions.push(s.wire());
      const ch = s.steps.filter(x => x.u > since).map(stripU);
      if (ch.length) steps[sid] = ch;
    }
    const out = { projects: this.layout(), sessions, steps, gone: [...this.gone] };
    this.discardDelta();
    return out;
  }

  /** 清掉变化记录、不拼增量：没人在看这个星系时用（有人来看时先发完整状态，用不着这些增量） */
  discardDelta() {
    this.dirty.clear(); this.gone.clear(); this.layoutDirty = false; this.flushedU = this.u;
  }
}

function stripU(x: Step): WireStep {
  const { u: _u, ...rest } = x;
  return rest;
}
