// 演示数据：页面里自己跑的假宇宙和假会话，不需要真的有服务器。
//   ?demo           一个有 150 个星系的宇宙，点进任意一个都有在跑的假会话
//   ?demo&n=2000    2000 个星系（测性能）
//   ?demo#galaxy=<编号>  直接飞进某个星系（旧的 #g= 也认）
// 演示星系里按 + 加一个项目、按 - 随机去掉一个。
import { MAX_STEPS, STATUS_CODE, TOOL_KINDS, projectName, type SummaryRow, type ToolKind } from "@agent-loop/shared/browser";
import {
  KIND_DONE, M, applyStatus, bgOnly, getSession, isEnded, resetGalaxy, setSteps, syncGroups, syncSubs,
  type Session, type StepIn,
} from "./model.ts";
import { applySummary } from "./universeView.ts";
import { hashUnit, now, params, pick, rand, rint } from "./util.ts";
import { T } from "./i18n.ts";

const KINDS: ToolKind[] = ["read", "read", "read", "edit", "edit", "search", "search", "shell", "shell", "shell", "web", "mcp", "other"];
const phrase = () => KIND_DONE[pick(KINDS)];
const toolMs = () => Math.random() < 0.06 ? rand(6000, 26000) : Math.exp(rand(Math.log(12), Math.log(3500)));
const hexId = (i: number) => Array.from({ length: 8 }, (_, k) => Math.floor(hashUnit("g" + i, k) * 65536).toString(16).padStart(4, "0")).join("");

// ------------------------------------------------------------------ 宇宙

const uni = new Map<string, string>();   // 星系编号 → 状态字母串
const uniProj = new Map<string, number>();
let uniCount = 0;

function randomCodes(): string {
  const n = Math.random() < 0.55 ? rint(1, 3) : Math.random() < 0.8 ? rint(3, 7) : rint(8, 18);
  const mood = Math.random();
  let s = "";
  for (let i = 0; i < n; i++) {
    const x = Math.random();
    s += mood < 0.35 ? (x < 0.75 ? STATUS_CODE.idle : x < 0.9 ? STATUS_CODE.stale : STATUS_CODE.done)
      : x < 0.3 ? STATUS_CODE.think : x < 0.55 ? STATUS_CODE.act : x < 0.62 ? STATUS_CODE.waiting : x < 0.68 ? STATUS_CODE.bg
      : x < 0.7 ? STATUS_CODE.error : x < 0.8 ? STATUS_CODE.done : STATUS_CODE.idle;
  }
  return s;
}

export function startDemoUniverse() {
  const n = Math.max(1, Math.min(20000, +(params.get("n") || 150) || 150));
  const rows: SummaryRow[] = [];
  for (let i = 0; i < n; i++) {
    const id = hexId(i), codes = randomCodes();
    uni.set(id, codes); uniProj.set(id, Math.max(1, Math.min(codes.length, rint(1, 4))));
    rows.push([id, uniProj.get(id)!, codes]);
  }
  uniCount = n;
  applySummary(rows, [], true);
}

let lastUni = 0;
/** 宇宙里的假星系慢慢变：一部分换状态，偶尔有星系出现、熄灭 */
export function demoUniverseTick() {
  const t = performance.now();
  if (t - lastUni < 900) return;
  lastUni = t;
  const rows: SummaryRow[] = [], gone: string[] = [];
  const ids = [...uni.keys()];
  const k = Math.max(1, Math.round(ids.length * 0.03));
  for (let i = 0; i < k; i++) {
    const id = pick(ids);
    if (id === M.galaxyId) continue;
    const old = uni.get(id)!;
    const codes = [...old].map(c => (Math.random() < 0.4 ? randomCodes()[0] : c)).join("") || "i";
    uni.set(id, codes); rows.push([id, uniProj.get(id)!, codes]);
  }
  if (Math.random() < 0.08 && ids.length > 5) { const id = pick(ids); if (id !== M.galaxyId) { uni.delete(id); gone.push(id); } }
  if (Math.random() < 0.08) {
    const id = hexId(uniCount++), codes = randomCodes();
    uni.set(id, codes); uniProj.set(id, Math.max(1, Math.min(codes.length, rint(1, 4)))); rows.push([id, uniProj.get(id)!, codes]);
  }
  // 正在看的演示星系：概要跟着它的真实（假）状态走
  if (M.galaxyId && uni.has(M.galaxyId)) {
    const codes = M.groups.flatMap(g => g.sids).map(sid => codeOf(M.sessions.get(sid))).join("");
    if (codes) { uni.set(M.galaxyId, codes); rows.push([M.galaxyId, M.groups.length, codes]); }
  }
  applySummary(rows, gone, false);
}

function codeOf(S: Session | undefined): string {
  if (!S) return STATUS_CODE.idle;
  if (S.status === "working") return bgOnly(S) ? STATUS_CODE.bg : S.phase === "act" ? STATUS_CODE.act : STATUS_CODE.think;
  return S.status === "waiting" ? STATUS_CODE.waiting : S.status === "done" ? STATUS_CODE.done : S.status === "error" ? STATUS_CODE.error : STATUS_CODE.idle;
}

export const isDemoGalaxy = (id: string) => uni.has(id);

// ------------------------------------------------------------------ 星系里的假会话

interface DemoSub { v: { id: string; type: string; status: string; phase: string; phase_since: number; ended: number | null; tool_id: string };
  list: StepIn[]; left: number; mode: string; next: number; ask: boolean; cur?: StepIn }
interface Demo { S: Session; list: StepIn[]; seq: number; seq0: number; round: number; mode: string; next: number; lapsLeft: number; toolsLeft: number;
  cur?: StepIn; subs?: DemoSub[]; subsDirty?: boolean; agentDoneAt?: number | null }

const demos: Demo[] = [];
let demoN = 0;
let groups: { key: string; title: string; sids: string[] }[] = [];

function demoHistory(D: Demo, laps: number, t: number) {
  // 往回造 laps 圈已经跑完的步骤
  const list: StepIn[] = [];
  let at = t - laps * 4200, left = rint(3, 12);
  for (let lap = 1; lap <= laps; lap++) {
    at += rand(800, 3000);
    if (--left < 0) { D.round++; left = rint(3, 12); }
    for (let j = pick([1, 1, 1, 2, 2, 3]); j > 0; j--) {
      const ms = toolMs();
      list.push({ id: "d" + (D.seq++), lap, round: D.round, phrase: phrase(), start: at, end: at + ms, err: Math.random() < 0.03 });
      at += ms + 60;
    }
  }
  return list;
}

/** 进入一个演示星系：照着它在宇宙里的概要造出会话 */
export function startDemoGalaxy(id: string) {
  resetGalaxy(id);
  demos.length = 0; demoN = 0;
  const codes = uni.get(id) || "wai";
  const np = Math.max(1, uniProj.get(id) || 1);
  groups = Array.from({ length: np }, (_, k) => ({ key: `${id}-p${k}`, title: projectName(`${id}-p${k}`), sids: [] as string[] }));
  [...codes].forEach((c, i) => {
    const g = groups[i % np];
    g.sids.push(demoSession(g.key, c));
  });
  for (const g of groups) g.sids.forEach((sid, i) => { const S = M.sessions.get(sid)!; S.project = g.title; S.label = T.session(i + 1); });
  M.groups = groups;
  syncGroups(groups);
}

function demoSession(proj: string, code: string): string {
  const t = now(), n = ++demoN;
  const sid = `${proj}-s${n}`;
  const S = getSession(sid);
  S.fresh = false;
  const D: Demo = { S, list: [], seq: n * 100000, seq0: n * 100000, round: 1, mode: "idle", next: t + rand(1500, 30000), lapsLeft: 0, toolsLeft: 0 };
  const laps = n === 3 ? 96 : n === 6 ? 58 : rint(2, 22);
  const busy = code === STATUS_CODE.think || code === STATUS_CODE.act;
  if (busy || n === 1) {                                 // 正在跑，已经做了几圈
    D.list = demoHistory(D, laps, t); S.lapsDone = laps;
    S.status = "working"; S.phase = "think"; S.phaseSince = t; D.mode = "think";
    D.lapsLeft = rint(4, 30); D.next = t + rand(300, 4000);
  } else if (code !== STATUS_CODE.stale) {               // 待命，环上留着上一轮
    D.list = demoHistory(D, laps, t - rand(20000, 600000)); S.lapsDone = laps;
  }
  if (code === STATUS_CODE.stale) S.stale = true;
  if (n === 1) { S.phase = "act"; S.phaseSince = t - 16000; D.toolsLeft = 1; D.lapsLeft = Math.max(D.lapsLeft, 3); demoAgent(D, t, 2, true); }
  if (code === STATUS_CODE.bg && n !== 1) { S.status = "working"; S.phase = "think"; S.phaseSince = S.bgSince = t - 47000; S.bg = 2;
    D.mode = "bg"; D.next = t + rand(6000, 10000); if (!D.list.length) { D.list = demoHistory(D, laps, t - 47000); S.lapsDone = laps; } }
  if (code === STATUS_CODE.waiting && n !== 1) { S.status = "waiting"; D.mode = "stuck"; D.next = t + rand(8000, 20000);
    D.list.push({ id: "d" + (D.seq++), lap: S.lapsDone + 1, round: D.round, phrase: KIND_DONE.shell, start: t - 9000, end: null, err: false }); }
  if (code === STATUS_CODE.done && n !== 1) { S.status = "done"; D.mode = "rest"; D.next = t + rand(5000, 16000); }
  if (code === STATUS_CODE.error && n !== 1) { S.status = "error"; D.mode = "rest"; D.next = t + rand(5000, 16000); }
  S.lapsShown = S.lapsDone + (isEnded(S) || bgOnly(S) ? 0 : 1); S.stepsTotal = D.seq - D.seq0;
  setSteps(S, D.list);
  demos.push(D);
  return sid;
}

// 演示里试轨道的增减：+ 在最外面加一个项目，- 随机去掉一个（任意一条）
export function demoAdd() {
  if (!M.galaxyId) return;
  const key = `${M.galaxyId}-p${groups.length}-${Math.floor(Math.random() * 1e6)}`;
  const g = { key, title: projectName(key), sids: [] as string[] };
  for (let i = rint(1, 3); i > 0; i--) g.sids.push(demoSession(key, pick(["w", "a", "i"])));
  g.sids.forEach((sid, i) => { const S = M.sessions.get(sid)!; S.project = g.title; S.label = T.session(i + 1); });
  groups = [...groups, g]; M.groups = groups;
  syncGroups(groups);
}
export function demoRemove(key?: string) {
  const g = key ? groups.find(x => x.key === key) : pick(groups);
  if (!g) return;
  const tp = performance.now();
  for (const sid of g.sids) { const S = M.sessions.get(sid); if (S) S.goneAt = tp; }
  for (let i = demos.length - 1; i >= 0; i--) if (g.sids.includes(demos[i].S.sid)) demos.splice(i, 1);
  groups = groups.filter(x => x !== g); M.groups = groups;
  syncGroups(groups);
}

// 演示的子 agent：主对话的这一步是「派子 agent」，派出 k 个，各自想、调工具，偶尔停下来等你授权，都做完了这一步才结束
const SUB_TYPES = ["Explore", "Explore", "general-purpose", "Plan", "custom"];
function demoAgent(D: Demo, t: number, k: number, warm = false) {
  const S = D.S;
  D.cur = { id: "d" + (D.seq++), lap: S.lapsDone + 1, round: D.round, phrase: KIND_DONE.agent, start: warm ? t - 16000 : t, end: null, err: false };
  D.list.push(D.cur); D.mode = "agent"; D.next = Infinity; D.agentDoneAt = null;
  D.subs = [];
  for (let i = 0; i < k; i++) {
    const v = { id: "sub" + (D.seq++), type: pick(SUB_TYPES), status: "working", phase: "think", phase_since: t, ended: null as number | null, tool_id: D.cur.id };
    const ds: DemoSub = { v, list: [], left: rint(4, 14), mode: "think", next: t + rand(400, 2500), ask: Math.random() < 0.2 };
    if (warm) {
      let at = t - 15000 + i * 900;
      for (let j = rint(3, 7); j > 0; j--) { const ms = toolMs() * 0.5; ds.list.push({ id: "d" + (D.seq++), lap: 1, round: 1, phrase: phrase(), start: at, end: at + ms, err: false }); at += ms + rand(400, 1800); }
    }
    D.subs.push(ds);
  }
  D.subsDirty = true;
}

function demoSubsTick(D: Demo, t: number) {
  const S = D.S, subs = D.subs!;
  for (const ds of subs) {
    const v = ds.v;
    if (v.ended || t < ds.next) continue;
    D.subsDirty = true;
    if (ds.mode === "think") {
      if (ds.left <= 0) { v.ended = t; v.status = "done"; continue; }
      if (ds.ask && ds.left <= 2) {   // 要你授权
        ds.ask = false; v.status = "waiting"; ds.mode = "ask"; ds.next = t + rand(4000, 7000); continue;
      }
      ds.cur = { id: "d" + (D.seq++), lap: 1, round: 1, phrase: phrase(), start: t, end: null, err: false };
      ds.list.push(ds.cur); v.phase = "act"; v.phase_since = t; ds.mode = "tool"; ds.next = t + toolMs() * 0.6;
    } else if (ds.mode === "tool") {
      ds.cur!.end = t; ds.cur!.err = Math.random() < 0.03; ds.left--;
      v.phase = "think"; v.phase_since = t; ds.mode = "think"; ds.next = t + rand(400, 2500);
    } else if (ds.mode === "ask") { v.status = "working"; ds.mode = "think"; ds.next = t + rand(300, 1000); }
  }
  const asking = subs.some(ds => ds.v.status === "waiting" && !ds.v.ended);
  if (asking && S.status !== "waiting") { applyStatus(S, "waiting", "act", S.phaseSince); S.waitSub = true; }
  else if (!asking && S.status === "waiting" && S.waitSub) { applyStatus(S, "working", "act", S.phaseSince); S.waitSub = false; }
  D.subs = subs.filter(ds => !ds.v.ended || t - ds.v.ended < 2500);   // 和服务端一样：结束后还列一会儿
  syncSubs(S, D.subs.map(ds => ({ ...ds.v, started: ds.v.phase_since } as never)));
  if (D.subsDirty) {
    D.subsDirty = false;
    for (const ds of D.subs) { const A = S.subs.get(ds.v.id); if (A) { setSteps(A, ds.list); A.stepsTotal = ds.list.length; } }
  }
  if (D.mode === "agent" && D.subs.every(ds => ds.v.ended)) {
    if (D.agentDoneAt == null) D.agentDoneAt = t;
    else if (t - D.agentDoneAt > 700) { D.mode = "tool"; D.next = t; }   // 结果都交回来了：「派子 agent」这一步结束
  }
}

export function demoTick() {
  const t = now();
  for (const D of demos) {
    if (D.subs && D.subs.length) demoSubsTick(D, t);
    if (t < D.next) continue;
    const S = D.S;
    const startTool = () => {
      D.cur = { id: "d" + (D.seq++), lap: S.lapsDone + 1, round: D.round, phrase: phrase(), start: t, end: null, err: false };
      D.list.push(D.cur); D.mode = "tool"; D.next = t + toolMs();
    };
    if (D.mode === "idle") {                 // 你发了一句话：新的一轮
      D.round++; D.lapsLeft = rint(3, 26);   // 圈数接着上一轮往下数
      S.stale = false;
      applyStatus(S, "working", "think", t);
      D.mode = "think"; D.next = t + rand(900, 5000);
    } else if (D.mode === "think") {         // 模型回了
      if (D.lapsLeft <= 0 && Math.random() < 0.3) {   // 回答完了，但留了 shell 在后台跑
        S.lapsDone++; S.bgSince = t;
        applyStatus(S, "working", "think", t, pick([1, 1, 2, 3]));
        D.mode = "bg"; D.next = t + rand(7000, 16000);
      } else if (D.lapsLeft <= 0) {
        S.lapsDone++;
        applyStatus(S, "done", "think", t);
        D.mode = "rest"; D.next = t + rand(5000, 16000);
      } else if (!(D.subs && D.subs.length) && D.lapsLeft > 1 && Math.random() < 0.12) {
        D.toolsLeft = 1;
        applyStatus(S, "working", "act", t);
        demoAgent(D, t, pick([1, 1, 2, 2, 3, 5]));
      } else {
        D.toolsLeft = pick([1, 1, 1, 2, 2, 3]);
        applyStatus(S, "working", "act", t);
        startTool();
      }
    } else if (D.mode === "tool") {          // 一个工具跑完
      if (D.cur) { D.cur.end = t; D.cur.err = Math.random() < 0.03; }
      if (--D.toolsLeft > 0) startTool();
      else {
        S.lapsDone++; D.lapsLeft--;
        applyStatus(S, "working", "think", t);
        D.mode = "think"; D.next = t + rand(700, 6000);
      }
    } else if (D.mode === "bg") {             // 一个后台任务跑完了
      if (S.bg > 1) { applyStatus(S, "working", "think", S.phaseSince, S.bg - 1); D.next = t + rand(3000, 9000); }
      else {                                 // 都跑完了：模型收到通知，接着干
        D.lapsLeft = rint(1, 4);
        applyStatus(S, "working", "think", t, 0);
        D.mode = "think"; D.next = t + rand(900, 3000);
      }
    } else if (D.mode === "stuck") {          // 你批准了
      const last = D.list[D.list.length - 1];
      if (last && last.end == null) last.end = t;
      applyStatus(S, "working", "think", t);
      D.lapsLeft = rint(1, 6); D.mode = "think"; D.next = t + rand(700, 3000);
    } else if (D.mode === "rest") {
      applyStatus(S, "idle", "think", t);
      D.mode = "idle"; D.next = t + rand(6000, 45000);
    }
    S.lapsShown = S.lapsDone + (S.status === "working" && !bgOnly(S) ? 1 : S.status === "waiting" ? 1 : 0); S.stepsTotal = D.seq - D.seq0;
    if (D.list.length > MAX_STEPS + 40) D.list = D.list.slice(-MAX_STEPS);
    setSteps(S, D.list);
  }
}

export { TOOL_KINDS };
