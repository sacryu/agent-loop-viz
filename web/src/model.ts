// 星系这一层的数据：每个对话一个球（Ring），球上每一步一根射线（Step），子 agent 是小球，项目是轨道。
// 数据来自服务器的细节层（WebSocket 推来的完整状态和增量），也可以来自演示数据（demo.ts）。
// 文字一律有退路：有附件（解得开）就显示真实信息，没有就退回自动生成的名字和类别词。
import {
  MAX_STEPS, basename, galaxyName, projectName, toolKind,
  type ToolKind, type WAtt, type WireGalaxy, type WireProject, type WireSession, type WireStep, type WireSub,
} from "@agent-loop/shared/browser";
import { ATT, CARD, detailOf, takeDirty } from "./attach.ts";
import { DEG, TAU, frac, now, rand } from "./util.ts";
import { T } from "./i18n.ts";

export const GAP = 0.8;              // 圈与圈之间空出多少个槽位
export const SLOT_MAX = 9 * DEG;     // 步数少时每步占的角度
export const SLOT_MIN = 2.6 * DEG;   // 再挤就不挤了：转满一周，旧的一周向圆心收
export const RING_F = [1, 0.8, 0.62];
export const HEAD_GAP = 5;           // 转满一周后，最新一步前面空出几个槽位，分得清头和尾
export const ROUND_GAP = 2.6;        // 你又发了一句话：两轮之间的缝更大
export const PULSE_MS = 700, SWEEP_MS = 1500;
export const SUB_MAX = 4, SUB_BIRTH_MS = 1100, SUB_BACK_MS = 850;

export interface StepIn {
  id: string; lap: number; round: number; phrase: string; start: number; end: number | null; err: boolean;
  kind?: ToolKind; errText?: string;   // errText：报错的第一行（来自附件）
}
export interface Seg { x0: number; y0: number; x1: number; y1: number; al: number; s: Step; live: boolean; flash: number; sw: number; d: number; back: boolean }
export interface Step extends StepIn {
  a: number | null; f: number; k: number; ta: number; bornAt: number; flashAt: number;
  g: Seg | null;   // 这一帧画在哪里（没画就是 null）
  seg?: Seg;       // g 指向的那个对象：每帧原地改写，不新建
  lon: number; sl: number; cl: number;
}
export interface Sat { bornAt: number; endAt: number | null; ph: number; tilt: number; flat: number; pinged?: boolean }

/** 服务器上有没有这一步的完整内容（输入或输出）：有才能点开 */
export function hasFull(S: { wire: Map<string, WireStep> }, st: { id: string } | null | undefined): boolean {
  const w = st ? S.wire.get(st.id) : undefined;
  return !!(w && (w.fin || w.fout));
}

/** 能画成一个球的东西（对话、子 agent）共有的状态：步骤、自转、后台任务卫星、子 agent */
export interface Ring {
  sid: string; status: string; phase: string; phaseSince: number; bg: number; bgSince: number | null;
  sats: Sat[]; subs: Map<string, Sub>; subGone: Set<string>; subSeq?: number;
  lapsShown: number; stepsTotal: number; steps: Step[]; byId: Map<string, Step>;
  fresh: boolean; seeded: boolean; sweepAt: number;
  slot: number; rings: number; ringsAnim: number; nextA: number; curA: number;
  spin: number; spinV: number; qn: number; nextLon: number; nextSl: number; nextCl: number;
  twinkles: { s: Step; t0: number }[];
  thinkK?: number; thinkPh?: number; waitSub?: boolean; stale?: boolean;
  light?: [number, number, number];   // 指向中心恒星的单位向量：屏幕 x、屏幕 y、朝向你。球按它画出月相
}
export interface Sub extends Ring {
  aid: string; parent: Session; type: string; typeAtt?: WAtt; toolId: string | null; bornAt: number; endAt: number | null; seq: number;
  fx: number | null; fy: number | null; spot: { x: number; y: number; r: number } | null; returned: boolean;
}
export interface Session extends Ring {
  project: string; label: string; lapsDone: number; roundSince: number;
  /** 附件：标题（Claude Code 起的）、第一句话（还没有标题时当标题）、这一轮在问什么、回答的最后一句；模型名 */
  titleAtt?: WAtt; firstAtt?: WAtt; askAtt?: WAtt; ansAtt?: WAtt; ask: string; ans: string; model: string | null;
  /** 现在显示的是 Claude Code 起的标题：标题换了、新的密文还没解开时先留着旧的，不闪回第一句话 */
  titled?: boolean;
  /** 上下文的 token 数、累计输出的 token 数（插件 0.2.2 起才有） */
  ctxTok: number | null; outTok: number | null;
  off: number | null; orb: Orbit | null; goneAt: number | null; bornAt: number; labelA: number;
  lastEvent: number; sizeK?: number; wire: Map<string, WireStep>; kindOf?: Map<string, string>;
}
export interface Orbit {
  key: string; title: string; sids: string[]; ghosts: string[]; leaving: boolean; rho: number | null; spin: number; phase0: number; wl: number; p: number;
}

// ------------------------------------------------------------------ 状态

export const M = {
  galaxyId: null as string | null,
  /** 星系的名片（附件）和由它得出的名字 */
  card: undefined as WAtt | undefined,
  name: "",
  projects: [] as WireProject[],
  textVer: -1,
  sessions: new Map<string, Session>(),
  groups: [] as { key: string; title: string; sids: string[] }[],
  pulses: [] as { sid: string; dir: "in" | "out"; t0: number; dur?: number }[],   // dur：光走这段路要多久，第一次画时按距离定
  pings: [] as { sid: string | null; t0: number; ink?: boolean }[],
  flare: 0,
  orbitMap: new Map<string, Orbit>(),
  orbitList: [] as Orbit[],
  /** 星系刚出现的时刻：开场动画从这里算 */
  bornAt: performance.now(),
};

export function resetGalaxy(id: string | null) {
  M.galaxyId = id;
  M.card = undefined; M.name = id ? galaxyName(id) : ""; M.projects = []; M.textVer = ATT.version;
  M.sessions.clear();
  M.groups = [];
  M.pulses.length = 0; M.pings.length = 0; M.flare = 0;
  M.orbitMap.clear(); M.orbitList = [];
  M.bornAt = performance.now();
}

export function ringState(sid: string): Ring {
  return { sid, status: "idle", phase: "think", phaseSince: 0, bg: 0, bgSince: null, sats: [], subs: new Map(), subGone: new Set(),
           lapsShown: 0, stepsTotal: 0, steps: [], byId: new Map(), fresh: true, seeded: false, sweepAt: -1e9,
           slot: SLOT_MAX, rings: 0, ringsAnim: 0, nextA: 0, curA: 0,
           spin: rand(0, TAU), spinV: 0, qn: 0, nextLon: 0, nextSl: 0, nextCl: 1, twinkles: [] };
}

export function getSession(sid: string): Session {
  let S = M.sessions.get(sid);
  if (!S) {
    const tp = performance.now(), early = tp - M.bornAt < 3000;
    S = Object.assign(ringState(sid), {
      project: "", label: "", lapsDone: 0, roundSince: 0, ask: "", ans: "", model: null, ctxTok: null, outTok: null, off: null, orb: null, goneAt: null, waitSub: false, stale: false,
      bornAt: tp + (early ? 450 + M.sessions.size * 70 : 0), labelA: 0, lastEvent: 0, wire: new Map<string, WireStep>(),
    }) as Session;
    M.sessions.set(sid, S);
  }
  return S;
}

/** 这一轮结束了：做完、闲着、出错 */
export const isEnded = (S: Ring) => S.status === "done" || S.status === "idle" || S.status === "error";
export const bgOnly = (S: Ring) => S.bg > 0 && S.status === "working" && S.phase === "think";   // 模型闲着，只在等后台任务
export const subsAlive = (S: Ring) => [...S.subs.values()].filter(A => A.endAt == null).sort((a, b) => a.seq - b.seq);

// ---- 子 agent
// 每个子 agent 是一个缩小版的球：自己自转，自己调的每个工具长成射线，和中间的模型之间也有来回的光点。
// 它是主对话里某一次「派子 agent」派出去的（服务端给了 tool_id）：从那一步射线的尖上鼓出一个泡、拉长、断开，
// 飘到主球旁边，之后一根细线把它连在那根射线的尖上。结束时顺着细线收回主球，那根射线亮一下：结果交回来了。
export function syncSubs(S: Session, list: WireSub[], boot = false) {
  const tp = performance.now(), seen = new Set<string>();
  for (const v of list || []) {
    seen.add(v.id);
    if (S.subGone.has(v.id)) continue;
    let A = S.subs.get(v.id);
    if (!A) {
      if (v.ended) { S.subGone.add(v.id); continue; }   // 刚打开页面时已经结束的，不再演一遍
      A = Object.assign(ringState(S.sid + "#" + v.id), { aid: v.id, parent: S, type: v.type || "", typeAtt: v.d, toolId: v.tool_id || null,
            bornAt: boot ? tp - SUB_BIRTH_MS : tp, endAt: null, seq: S.subSeq = (S.subSeq || 0) + 1, fx: null, fy: null,
            spot: null, returned: false }) as Sub;
      A.seeded = !boot;
      S.subs.set(v.id, A);
    }
    A.type = v.type || A.type;
    if (v.d) A.typeAtt = v.d;
    if (v.tool_id) A.toolId = v.tool_id;
    if (A.endAt != null) continue;
    if (v.ended) { A.endAt = tp; applyStatus(A, "done", "think", v.ended); }
    else applyStatus(A, v.status, v.phase, v.phase_since);
  }
  for (const A of S.subs.values())
    if (!seen.has(A.aid) && A.endAt == null) { A.endAt = tp; applyStatus(A, "done", "think", A.phaseSince); }
}

// 第 q 步在球面上的位置：一个低差异序列，不管有多少步都铺得匀，而且先来的不会因为后来的而挪位置
export function spherePos(q: number) {
  const sl = 2 * frac((q + 0.5) * 0.7548776662) - 1;
  return { lon: TAU * frac(q * 0.569840291), sl, cl: Math.sqrt(1 - sl * sl) };
}

export function pulse(S: Ring, dir: "in" | "out") {
  if (M.pulses.length < 60) M.pulses.push({ sid: S.sid, dir, t0: performance.now() });
  // 页面在后台时不出帧，flare 不会衰减，切回来那一下会亮一闪：后台时不点
  if (dir === "out" && !(typeof document !== "undefined" && document.hidden)) M.flare = Math.max(M.flare, 0.8);
}

// 状态变化带来的一次性效果：发给模型（光点向内）、模型回了（光点向外）、这一轮做完（扫光）
// bg：回合已经结束、还在跑的后台任务数（shell 之类）。进入这个状态算「这一轮做完了」：扫光、光点回到球上，
// 之后只是在等，不再有发给模型的光点。
export function applyStatus(S: Ring, status: string, phase: string, phaseSince: number, bg = 0) {
  const was = S.status, wasPhase = S.phase, wasSince = S.phaseSince, wasBg = S.bg > 0;
  S.status = status; S.phase = phase; S.phaseSince = phaseSince; S.bg = status === "working" ? bg : 0;
  if (S.fresh) { S.fresh = false; return; }
  if (S.bg > 0 && phase === "think") {
    if (!wasBg && was === "working") { S.sweepAt = performance.now(); pulse(S, "out"); }
    return;
  }
  if (status === "working") {
    if (was !== "working" || phase !== wasPhase) pulse(S, phase === "think" ? "in" : "out");
    else if (phase === "think" && phaseSince !== wasSince) pulse(S, "in");
  }
  if ((was === "working" || was === "waiting") && (status === "done" || status === "idle")) {
    S.sweepAt = performance.now();
    pulse(S, "out");
  }
}

export function setSteps(S: Ring, list: StepIn[]) {
  const tp = performance.now(), byId = new Map<string, Step>(), out: Step[] = [];
  for (const x of list) {
    if (byId.has(x.id)) continue;
    let s = S.byId.get(x.id);
    if (!s) s = { id: x.id, a: null, f: 1, k: 0, ta: 0, bornAt: S.seeded ? tp : -1e9, flashAt: -1e9, g: null, ...spherePos(S.qn++) } as Step;
    else if (s.end == null && x.end != null) s.flashAt = tp;
    s.lap = x.lap; s.round = x.round || 0; s.phrase = x.phrase || ""; s.start = x.start; s.end = x.end; s.err = !!x.err;
    s.kind = x.kind; s.errText = x.errText;
    byId.set(x.id, s); out.push(s);
  }
  S.steps = out; S.byId = byId; S.seeded = true;
  const np = spherePos(S.qn); S.nextLon = np.lon; S.nextSl = np.sl; S.nextCl = np.cl;
  layout(S);
}

// 每一步在环上的目标角度（12 点起，顺时针）和所在的那一周
export function layout(S: Ring) {
  const st = S.steps, pos: number[] = [];
  let units = 0, prev: Step | null = null;
  for (const s of st) {
    if (prev !== null && s.round !== prev.round) units += ROUND_GAP;
    else if (prev !== null && s.lap !== prev.lap) units += GAP;
    pos.push(units); units += 1; prev = s;
  }
  let slot = Math.min(SLOT_MAX, TAU / (units + 3)), cap = Infinity;
  if (slot < SLOT_MIN) { slot = SLOT_MIN; cap = Math.floor(TAU / SLOT_MIN); }
  const lastRev = cap === Infinity || !units ? 0 : Math.floor((units - 1) / cap);
  const head = units - lastRev * cap;   // 写到这一周的哪里了
  let rings = 0;
  st.forEach((s, i) => {
    const rev = cap === Infinity ? 0 : Math.floor(pos[i] / cap);
    const p = pos[i] - (cap === Infinity ? 0 : rev * cap);
    s.k = Math.max(0, lastRev - rev - (p >= head + HEAD_GAP ? 1 : 0));
    s.ta = p * slot;
    if (s.a == null) { s.a = s.ta; s.f = s.k <= 2 ? RING_F[s.k] : 0.5; }
    if (s.k <= 2 && s.k > rings) rings = s.k;
  });
  S.slot = slot; S.rings = rings;
  let next = units + (units && S.phase === "think" ? GAP : 0);
  if (cap !== Infinity) next = next >= (lastRev + 1) * cap ? 0 : next - lastRev * cap;
  S.nextA = next * slot;
}

// ------------------------------------------------------------------ 文字
// 固定的词来自 i18n.ts；真实的工具名、对象、项目名、标题来自附件。没有附件（对方选了匿名、解不开）就用固定的词。

export const KIND_DONE: Record<ToolKind, string> = T.kindDone;

/** 真实工具名 + 对象 → 一句短句 */
export function toolPhrase(name: string, obj: string): string {
  const t = T.tool;
  switch (name) {
    case "Bash": case "PowerShell": return t.shell(obj);
    case "Read": return t.read(obj);
    case "Edit": case "MultiEdit": case "NotebookEdit": return t.edit(obj);
    case "Write": return t.write(obj);
    case "Grep": return t.grep(obj);
    case "Glob": return t.glob(obj);
    case "WebFetch": return t.fetch(obj);
    case "WebSearch": return t.search(obj);
    case "Agent": case "Task": return t.agent(obj);
    case "AskUserQuestion": return t.ask(obj);
    case "ExitPlanMode": return t.plan;
    case "Skill": return t.skill(obj);
  }
  if (toolKind(name) === "progress") return t.progress;
  if (name.startsWith("mcp__")) { const p = name.split("__"); return t.mcp(p[1] || "", p.slice(2).join("__")); }
  return t.other(name);
}

const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"]);

/**
 * 一个对话里每一步的短句。文件平时只显示文件名；同一轮里有两个不同的文件同名时才带上父目录（插件给的是路径的最后两段）
 */
function phrases(sid: string, list: WireStep[]): Map<string, { phrase: string; errText?: string }> {
  const out = new Map<string, { phrase: string; errText?: string }>();
  const seen = new Map<string, Set<string>>();   // 「轮|文件名」→ 出现过的完整对象
  const dets = list.map(x => detailOf(x.d, "step", sid, x.id));
  list.forEach((x, i) => {
    const d = dets[i];
    if (d?.name && d.obj && FILE_TOOLS.has(d.name)) {
      const key = x.round + "|" + basename(d.obj).toLowerCase();
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key)!.add(d.obj.toLowerCase());
    }
  });
  list.forEach((x, i) => {
    const d = dets[i], e = x.e ? detailOf(x.e, "fail", sid, x.id) : null;
    let phrase: string;
    if (d?.name) {
      let obj = d.obj || "";
      if (obj && FILE_TOOLS.has(d.name) && (seen.get(x.round + "|" + basename(obj).toLowerCase())?.size ?? 0) <= 1) obj = basename(obj);
      phrase = toolPhrase(d.name, obj);
    } else phrase = KIND_DONE[x.kind] || KIND_DONE.other;
    out.set(x.id, e?.err ? { phrase, errText: e.err } : { phrase });
  });
  return out;
}

/** 子 agent 的类型名：附件里的真实类型名，否则是内置类型名或「自定义」 */
export function subTypeOf(A: Sub): string {
  const d = detailOf(A.typeAtt, "sub", A.parent.sid, A.aid);
  return d?.type || (A.type === "custom" ? T.customSubagent : A.type || T.subagent);
}

export const STATUS_WORD: Record<string, string> = T.status;
export const wordOf = (S: Ring) => (S.status === "working" ? (S.phase === "act" ? T.acting : bgOnly(S) ? T.bgWait : T.thinking) : STATUS_WORD[S.status] || "")
                    + (S.stale ? " · " + T.stale : "");

// ------------------------------------------------------------------ 轨道的增减
// 轨道不再按序号算位置，而是各自带着状态：
//   wl：占位（0→1）。半径按「外面还有多少占位」连续地算，所以进场时里面的轨道一点点往里让，
//       退场时缝一点点合上；不管去掉的是哪一条，别的轨道都不会跳。
//   p ：线画到了哪里（0→1），从项目名那一点起绕一周。进场先让位、再画线，球在线扫过时才出现；
//       退场倒过来：线连同上面的球收回到项目名，名字最后淡掉，然后缝合上。
//   spin：各自累计的公转角度，序号变了也不会跳，只是速度慢慢变成新位置的速度。
// 服务端新出现的项目总在最外面；退场中的轨道留在原来的位置，直到它的占位归零。
export const ROOM_S = 0.7, DRAW_S = 1.1, FOLD_S = 0.9, GONE_MS = 480;

export function syncGroups(next: { key: string; title: string; sids: string[] }[]) {
  const intro = !M.orbitList.length && performance.now() - M.bornAt < 3000;   // 刚进来：照开场动画一条条画出来
  const keys = new Set(next.map(g => g.key));
  const order = next.map(g => g.key);
  let after: string | null = null;
  for (const O of M.orbitList) {   // 退场中的插回原处：跟在它原来里面那条后面
    if (keys.has(O.key)) { after = O.key; continue; }
    order.splice(after == null ? 0 : order.indexOf(after) + 1, 0, O.key); after = O.key;
  }
  next.forEach((g, k) => {
    let O = M.orbitMap.get(g.key);
    if (!O) {
      O = { key: g.key, title: g.title, sids: [], ghosts: [], leaving: false, rho: null, spin: 0, phase0: 0.6 + k * 2.1,
            wl: intro ? 1 : 0, p: intro ? -(0.15 + k * 0.12) / DRAW_S : 0 };
      M.orbitMap.set(g.key, O);
    }
    O.title = g.title; O.leaving = false;
    for (const sid of O.sids) if (!g.sids.includes(sid) && !O.ghosts.includes(sid)) O.ghosts.push(sid);
    O.sids = g.sids;
    O.ghosts = O.ghosts.filter(sid => !g.sids.includes(sid));
  });
  for (const O of M.orbitMap.values()) {
    if (keys.has(O.key) || O.leaving) continue;
    O.leaving = true; O.ghosts.push(...O.sids); O.sids = [];
  }
  M.orbitList = order.map(k => M.orbitMap.get(k)!);
}

// ------------------------------------------------------------------ 服务器推来的数据

const projectTitle = (p: WireProject) => detailOf(p.card, "card", M.galaxyId ?? "", p.id)?.proj || projectName(p.id);

function applySession(v: WireSession) {
  const S = getSession(v.sid);
  S.goneAt = null;
  S.titleAtt = v.title; S.firstAtt = v.first; S.askAtt = v.ask; S.ansAtt = v.ans; S.model = v.model ?? S.model;
  S.ctxTok = v.ctx_tok ?? S.ctxTok; S.outTok = v.out_tok ?? S.outTok;
  sessionText(S);
  S.lastEvent = v.last_event; S.lapsDone = v.laps || 0;
  S.roundSince = v.round_since;
  S.bgSince = v.bg_since || null; S.waitSub = v.wait_sub;
  S.stale = !!v.stale;
  const boot = S.fresh;
  applyStatus(S, v.status, v.phase, v.phase_since, v.bg || 0);
  syncSubs(S, v.subagents, boot);
  S.stepsTotal = v.steps_total;
  // 圈数是整个对话累计的，在跑的那一圈也算上
  S.lapsShown = S.lapsDone + ((S.status === "working" || S.status === "waiting") && !bgOnly(S) ? 1 : 0);
}

function applySteps(S: Session, list: WireStep[] | undefined, reset: boolean) {
  if (reset) S.wire.clear();
  for (const x of list || []) S.wire.set(x.id, x);
  // 只留最近的 MAX_STEPS 步（主对话）；子 agent 的步骤跟着它们的子 agent 走
  const all = [...S.wire.values()];
  const main = all.filter(x => !x.agent);
  if (main.length > MAX_STEPS) for (const x of main.slice(0, main.length - MAX_STEPS)) S.wire.delete(x.id);
  const t = now(), ph = phrases(S.sid, [...S.wire.values()]);
  const inOf = (x: WireStep, lap: number, round: number): StepIn =>
    ({ id: x.id, lap, round, ...ph.get(x.id)!, start: x.start || x.end || t, end: x.end, err: x.err, kind: x.kind });
  setSteps(S, [...S.wire.values()].filter(x => !x.agent).map(x => inOf(x, x.lap, x.round)));
  const bySub = new Map<string, StepIn[]>();
  for (const x of S.wire.values()) {
    if (!x.agent) continue;
    if (!bySub.has(x.agent)) bySub.set(x.agent, []);
    bySub.get(x.agent)!.push(inOf(x, 1, 1));
  }
  for (const [aid, l] of bySub) { const A = S.subs.get(aid); if (A) { setSteps(A, l); A.stepsTotal = l.length; } }
  for (const x of [...S.wire.values()]) if (x.agent && !S.subs.has(x.agent) && S.subGone.has(x.agent)) S.wire.delete(x.id);
}

/** 对话的标题、在问什么、回答：来自附件 */
function sessionText(S: Session) {
  S.ask = detailOf(S.askAtt, "ask", S.sid)?.label || "";
  S.ans = detailOf(S.ansAtt, "ans", S.sid)?.say || "";
}

/** 对话的标题：Claude Code 起的 → 服务器见到的第一句话 → 「对话 N」 */
function sessionLabel(S: Session, n: number): string {
  const t = detailOf(S.titleAtt, "title", S.sid, "")?.label;
  if (t) { S.titled = true; return t; }
  if (S.titleAtt && S.titled) return S.label;
  S.titled = false;
  return detailOf(S.firstAtt, "ask", S.sid)?.label || T.session(n);
}

function applyProjects(projects: WireProject[]) {
  M.projects = projects;
  M.groups = projects.map(p => ({ key: p.id, title: projectTitle(p), sids: p.sids }));
  const live = new Set(projects.flatMap(p => p.sids));
  const ordinal = new Map<string, number>();
  for (const p of projects) p.sids.forEach((sid, i) => ordinal.set(sid, i + 1));
  for (const S of M.sessions.values()) {
    if (live.has(S.sid)) {
      const p = projects.find(x => x.sids.includes(S.sid))!;
      S.project = projectTitle(p); S.label = sessionLabel(S, ordinal.get(S.sid)!);
    } else if (S.goneAt == null) S.goneAt = performance.now();   // 不在了的对话先留着做退场动画
  }
  syncGroups(M.groups);
}

/** 星系的名字：名片里的 me，否则是星表编号 */
export function setGalaxyCard(card: WAtt | undefined) {
  M.card = card;
  M.name = detailOf(card, "card", M.galaxyId ?? "")?.me || (M.galaxyId ? galaxyName(M.galaxyId) : "");
}

export function applyFull(g: WireGalaxy) {
  if (M.galaxyId !== g.id) resetGalaxy(g.id);
  setGalaxyCard(g.card);
  for (const v of g.sessions) applySession(v);
  for (const v of g.sessions) applySteps(getSession(v.sid), g.steps[v.sid], true);
  applyProjects(g.projects);
}

/** 只重拼这些对话的标题（项目名、序号照旧）：名片没变时用，不必整个 applyProjects */
function relabel(sids: Iterable<string>) {
  for (const sid of sids) {
    const S = M.sessions.get(sid), p = M.projects.find(x => x.sids.includes(sid));
    if (S && p) S.label = sessionLabel(S, p.sids.indexOf(sid) + 1);
  }
}

/**
 * 附件在后台解开了：只把解开了附件的那些对话的文字重新拼一遍；解开了名片就重拼星系名、项目名。
 * 换了密钥（ATT.version 变了）就全部重拼。每帧调一次，没变就什么都不做。
 * 演示里的会话没有 wire 数据，不受影响
 */
export function refreshText() {
  const all = M.textVer !== ATT.version, dirty = takeDirty();
  if (!all && !dirty.size) return;
  M.textVer = ATT.version;
  if (!M.galaxyId) return;
  const card = all || dirty.has(CARD);
  if (card) setGalaxyCard(M.card);
  const redo: string[] = [];
  for (const S of all ? M.sessions.values() : [...dirty].map(sid => M.sessions.get(sid))) {
    if (!S) continue;
    sessionText(S);
    if (S.wire.size) applySteps(S, undefined, false);
    redo.push(S.sid);
  }
  if (!M.projects.length) return;
  if (card) applyProjects(M.projects);
  else relabel(redo);
}

export function applyDelta(d: { projects: WireProject[]; sessions: WireSession[]; steps: Record<string, WireStep[]>; gone: string[] }) {
  for (const v of d.sessions) applySession(v);
  for (const v of d.sessions) if (d.steps[v.sid]) applySteps(getSession(v.sid), d.steps[v.sid], false);
  for (const sid of d.gone) { const S = M.sessions.get(sid); if (S && S.goneAt == null) S.goneAt = performance.now(); }
  applyProjects(d.projects);
}

