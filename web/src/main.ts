// Agent Loop 的页面：三级视图。
//   宇宙：每个星系是一小团光（universeView.ts）。点一团光，镜头扎进去，星系从光团里展开。
//   星系：中间的标志、轨道（项目）、球（对话）、射线（步骤）（galaxyView.ts）。Esc 回到宇宙。
//   表盘：点一个球，球摊平成一个表盘（还在 galaxyView.ts 里，是星系视图的镜头放大）。Esc 回到星系。
// 网址带 #galaxy=<星系编号> 时直接飞到那个星系（#g= 照样认：0.2.10 以前的插件、旧书签用它，新插件问不到服务器版本时也给它，见 report.mjs 的 galaxyUrl）。本机模式下只有一个星系时，直接进去。
// 网址带 #k=<密钥> 时是邀请链接：加入那个星系群（见 group.ts）。宇宙这一层画的是你所在的星系群。
// 点表盘上的一步，右边滑出步骤详情（detail.ts）。
// 「你的星系」：只认 /galaxy 命令给的网址（#galaxy=<编号>&mine），记在 localStorage 里，之后不带 #galaxy= 打开、刷新也认得。
//   别人发来的、书签里的、页面自己写的 #galaxy= 都没有 &mine，只飞过去，不改「你的星系」。
// 页面只看、不管「在哪个群」：建群、退出、换群都在插件里做（/agent-loop:create、leave、rejoin），页面跟着插件给的链接走。
//   读到 &mine 以后马上从地址里去掉，免得复制地址栏发给别人时把记号也带过去。
import { ID_RE, KEY43_RE, type ServerMsg } from "@agent-loop/shared/browser";
import { V, cv, resize } from "./canvas.ts";
import { demoAdd, demoRemove, demoTick, demoUniverseTick, isDemoGalaxy, startDemoGalaxy, startDemoUniverse } from "./demo.ts";
import { REPO_URL } from "./links.ts";
import { startPlayback } from "./play.ts";
import { closeDetail, detailOpen, openDetail, setFullFetcher } from "./detail.ts";
import { G, dim, drag, enterGalaxy, focus, galaxyFrame, mouse, panGalaxy, resetHud, zoomGalaxy, zoomHome, zoomed } from "./galaxyView.ts";
import { closePanel, fingerprint, forgetLeft, groupHooks, noteLeft, offerSwitch, panelOpen, showArrival, showInvite, showWelcome, syncGroupUi, takeK, useK, type Arrival } from "./group.ts";
import { applyStatic } from "./i18n.ts";
import { PERF, starInfo } from "./star.ts";
import { M, applyDelta, applyFull, hasFull, refreshText, resetGalaxy, type Session, type Step, type Sub } from "./model.ts";
import { conn, connect, debugConn, requestFull, setFocus } from "./net.ts";
import { ATT, detailOf } from "./attach.ts";
import { F, cam, scr, view } from "./scene.ts";
import { U, applySummary, fitCam, flyHooks, locate, panBy, stopFly, universeFrame, uscr, worldOf, zoomAt } from "./universeView.ts";
import { T } from "./i18n.ts";
import { applyPlugins, updateBar } from "./update.ts";
import { $, T0, clamp, fmtMs, lerp, params, pctl, setStyle, setText, smooth } from "./util.ts";

// 两种演示，都不连服务器：
//   剧本演示（演示站的构建默认就是它；本地加 ?demo）：播放编好的剧本，走和真实数据完全相同的路径（play.ts）
//   随机演示（?demo&n=2000）：成百上千个随机的星系，测性能用（demo.ts）
const DEMO = params.has("demo") || import.meta.env.MODE === "demo";
const RANDOM_DEMO = DEMO && params.has("n");
let player: ReturnType<typeof startPlayback> | null = null;
const FLY_MS = 1250;

type ViewName = "universe" | "galaxy";
const app = {
  view: "universe" as ViewName,
  // locate：出去以后镜头再飞到你的星系（「我的星系」在星系里按下时）。换了去向（enter）就跟着整个 trans 一起作废
  trans: null as null | { dir: "in" | "out"; id: string; t0: number; locate?: boolean },
  autoEntered: false,
  userLeft: false,
};

const MINE_KEY = "agent-loop.mine";
function showMine(id: string | null) {
  U.mine = id;
  setStyle("mine", "display", id ? "" : "none");
}
/** 刚认出你的星系：记下来，按钮出现时荡开一圈 */
function setMine(id: string) {
  if (id === U.mine) return;
  showMine(id);
  mineFx("intro", 1300);
  if (DEMO) return;   // 演示里的星系是假的，不记
  try { localStorage.setItem(MINE_KEY, id); } catch { /* 隐私模式之类：只记这一次 */ }
}
/** 编号加长到 32 位以前记下的 16 位编号：新编号就是它后面再接 16 位（同一个 sha256 取得更长），
 *  等宇宙里出现以它开头的星系时认回来，换成新编号记下 */
let legacyMine: string | null = null;
function storedMine() {
  if (DEMO) return null;
  try {
    const s = localStorage.getItem(MINE_KEY);
    if (s && /^[0-9a-f]{16}$/.test(s)) { legacyMine = s; return null; }
    return s && ID_RE.test(s) ? s : null;
  } catch { return null; }
}
function adoptLegacyMine() {
  if (!legacyMine) return;
  if (U.mine) { legacyMine = null; return; }
  for (const id of U.rows.keys()) if (id.startsWith(legacyMine)) { legacyMine = null; setMine(id); return; }
}

const hashId = () => { const m = /(?:^|[#&])(?:galaxy|g)=([0-9a-f]{32})(?:&|$)/.exec(location.hash); return m ? m[1] : null; };
const galaxyHash = (id: string) => `${location.pathname}${location.search}#galaxy=${id}`;

/**
 * 地址 # 后面用 & 分开的几项，一次读完。一次性的项（k、left、kept、mine、welcome、created）读到就一次从地址栏去掉
 * （replaceState：不触发 hashchange，不留历史），有星系编号时只留下 #galaxy=<编号>（#g= 也认，写回去时换成 galaxy=）。
 *   k：邀请链接里的密钥（group.ts）。undefined 是地址里没有 k=，null 是有但格式不对（只取 k= 后面合法字符的那一段再检查）
 *   left、kept：/agent-loop:leave 打开的（group.ts 的 noteLeft）
 *   galaxy：飞去哪个星系。mine：/galaxy 给的网址，记成你的星系（别人发来的、书签里的没有它）
 *   arrival：插件打开页面时带的记号（report.mjs 的 setUp），飞进你的星系以后弹一张卡片：
 *     &welcome：接入命令打开的，弹「这是你的星系」
 *     &created：/agent-loop:create 刚建好群，弹「群建好了」和邀请链接（邀请链接只在这里拿得到，命令的输出里不带密钥）
 */
interface Hash { k: string | null | undefined; left: string | null; kept: boolean; galaxy: string | null; mine: boolean; arrival: Arrival | null }
const ONCE_FLAGS = new Set(["kept", "mine", "welcome", "created"]);
const once = (p: string) => ONCE_FLAGS.has(p) || p.startsWith("k=") || p.startsWith("left=");
function readHash(): Hash {
  const s = location.hash, parts = s.slice(1).split("&"), has = (name: string) => parts.includes(name);
  const k = /(?:^|[#&])k=([A-Za-z0-9_-]*)/.exec(s), left = /(?:^|[#&])left=([0-9a-f]{16})(?:&|$)/.exec(s), galaxy = hashId();
  const rest = galaxy ? `galaxy=${galaxy}` : parts.filter(p => p && !once(p)).join("&");
  if (`#${rest}` !== (s || "#")) history.replaceState(galaxy ? { nav: galaxy } : history.state, "", `${location.pathname}${location.search}${rest ? "#" + rest : ""}`);
  return {
    k: k ? (KEY43_RE.test(k[1]) ? k[1] : null) : undefined, left: left ? left[1] : null, kept: has("kept"),
    galaxy, mine: has("mine"), arrival: has("created") ? "created" : has("welcome") ? "hi" : null,
  };
}

/**
 * 还没弹的卡片：连上、打过招呼、进得去以后弹（刚打开页面时、地址改成带记号时都走这里）。
 * welcome：这个浏览器第一次用邀请链接进这个群（不是 /galaxy 给的网址），告诉对方怎么把自己的星系也接进来
 */
let arrival: Arrival | "welcome" | null = null;
function tryArrival() {
  if (!arrival || !conn.hello) return;
  const a = arrival;
  arrival = null;
  if (conn.denied) return;
  if (a === "welcome") { if (!conn.local && ATT.keys && !panelOpen()) showWelcome(); }
  else if (conn.local || ATT.keys) showArrival(a);
}

/**
 * 照地址办（readHash 读出来的）。刚打开页面时（initial）和地址变了时（hashchange）共用：
 *   先处理 #left=（浏览器里存着的是那个群的密钥就清掉），再看密钥：刚打开时不会先拿着旧密钥连上这个群
 *   密钥：地址里没带 k= 就不动（刚打开时照样用浏览器里存着的）。已经在别的星系群里时不直接换，先问（offerSwitch）
 *   卡片：都等连接打过招呼再弹。换了密钥会重连，等新的连接打过招呼（刚打开时还没连，也是等）
 * 密钥用上以后才完成：刚打开时等它再连接
 */
async function applyHash(h: Hash, { initial }: { initial: boolean }) {
  if (!DEMO && h.left) { noteLeft(h.left, h.kept); await forgetLeft().catch(() => {}); }
  const key = !DEMO && (initial || h.k !== undefined) ? takeK(h.k ?? null) : null;
  if (h.galaxy && h.mine) setMine(h.galaxy);
  if (h.galaxy && h.galaxy !== M.galaxyId) enter(h.galaxy);
  else if (!h.galaxy && app.view === "galaxy") leave();
  if (DEMO) return;
  if (!key) { if (h.arrival) { arrival = h.arrival; tryArrival(); } return; }
  const { use, ask, fresh } = key;
  const card = h.arrival ?? (fresh && !h.mine ? "welcome" : null);
  // 刚打开时还没有密钥：存着的先用上（要问换不换群时也是，问的时候摆出现在这个群）。页面开着时要问的话不动现在的密钥
  if (use && use !== ATT.keys?.k && (initial || !ask)) {
    const ok = await useK(use).catch(() => false);
    if (!ask && card && (ok || !ATT.keys)) arrival = card;
  } else if (!ask && card) { arrival = card; tryArrival(); }
  // 链接带来了另一个星系群：问过再换，换过来以后由 offerSwitch 弹卡片
  if (ask) void offerSwitch(ask, h.arrival);
}

function enter(id: string) {
  if (app.view === "galaxy" && M.galaxyId === id && !app.trans) return;
  // 半路换了去向：之前的镜头飞行、「出去以后再定位」都作废（后者在被替换掉的 app.trans 上）
  stopFly();
  mineBtn.classList.remove("flying");
  resetGalaxy(id);
  enterGalaxy();
  M.bornAt = performance.now() + FLY_MS * 0.45;   // 开场动画在星系淡入时开始
  if (RANDOM_DEMO) { if (isDemoGalaxy(id)) startDemoGalaxy(id); }
  else if (player) player.setFocus(id);
  else setFocus(id);
  app.trans = { dir: "in", id, t0: performance.now() };
  setStyle("card", "opacity", "0");
  if (hashId() !== id || !/(?:^|[#&])galaxy=/.test(location.hash)) history.replaceState({ nav: id }, "", galaxyHash(id));
}

function leave(locate = false) {
  if (app.view !== "galaxy" || app.trans) return;
  app.userLeft = true;
  if (player) player.setFocus(null); else if (!DEMO) setFocus(null);
  app.trans = { dir: "out", id: M.galaxyId || "", t0: performance.now(), locate };
  setStyle("card", "opacity", "0");
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

function onMsg(m: ServerMsg) {
  switch (m.t) {
    case "sum":
      applySummary(m.rows, m.gone, m.full);
      adoptLegacyMine();
      fitCam(!U.cam.ready);
      maybeAutoEnter();
      break;
    case "gal":
      if (m.id !== M.galaxyId) return;
      if (m.full) applyFull(m.galaxy); else applyDelta(m);
      break;
    case "gal-gone":
      // 这个星系现在没有对话（或者从没来过）：留在空的星系里，有事件进来时会自己出现
      if (m.id === M.galaxyId) applyDelta({ projects: [], sessions: [], steps: {}, gone: [...M.sessions.keys()] });
      break;
    case "plugin":
      applyPlugins(m);
      break;
  }
}

/** 本机模式（或者星系群里只有一个星系，多半就是你自己）：直接进去 */
function maybeAutoEnter() {
  if (app.autoEntered || app.userLeft || app.view !== "universe" || app.trans || hashId()) return;
  const live = [...U.rows.values()].filter(r => r.goneAt == null);
  if ((conn.local || ATT.keys) && live.length === 1) { app.autoEntered = true; if (!U.mine && conn.local) setMine(live[0].id); enter(live[0].id); }
}

/** 「我的星系」按钮 / M 键：回到宇宙，镜头飞到你的星系，放一圈特效 */
function locateMine() {
  if (!U.mine || app.trans) return;
  mineBtn.classList.remove("arrive", "absent");
  if (app.view === "galaxy") {
    if (G.focusSid) focus(null);
    leave(true);
    mineBtn.classList.add("flying");
    return;
  }
  if (locate(U.mine)) mineBtn.classList.add("flying");
  else { mineBtn.classList.remove("flying"); mineFx("absent", 1100); flashNote(T.mineAbsent); }
}

// 按钮的动效（样式在 index.html）：flying 飞行中、arrive 到了、absent 你的星系不在、intro 第一次出现、press 按 M 键
const mineBtn = $("mine");
const mineTimers: Record<string, ReturnType<typeof setTimeout>> = {};
function mineFx(cls: string, ms: number) {
  mineBtn.classList.remove(cls); void mineBtn.offsetWidth; mineBtn.classList.add(cls);   // 重放动画
  clearTimeout(mineTimers[cls]); mineTimers[cls] = setTimeout(() => mineBtn.classList.remove(cls), ms);
}
flyHooks.arrive = () => { mineBtn.classList.remove("flying"); mineFx("arrive", 1300); };
flyHooks.cancel = () => mineBtn.classList.remove("flying");

let noteTimer: ReturnType<typeof setTimeout> | null = null;
function flashNote(text: string) {
  const el = $("note");
  el.textContent = text; el.style.opacity = "1";
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { el.style.opacity = "0"; }, 2600);
}

// ------------------------------------------------------------------ 步骤详情

/** 点了表盘上的一步（A：是子 agent 的那一步时是那个子 agent） */
function openStep(S: Session, st: Step, A?: Sub) {
  const w = S.wire.get(st.id);
  if (!w || !hasFull(S, st)) return;   // 服务器上没有这一步的完整内容：点不开
  const d = detailOf(w.d, "step", S.sid, w.id);
  const dur = st.end != null ? fmtMs(st.end - st.start) : "";
  openDetail({
    sid: S.sid, kicker: [S.project, A ? A.type : S.label, T.lap(st.lap)].filter(Boolean).join(" · "), title: st.phrase,
    meta: dur, err: st.err ? st.errText || T.failed : undefined,
    parts: [
      ...(w.fin ? [{ label: T.static.input, slot: "full-in", k: st.id, tool: d?.name, kind: "in" } as const] : []),
      ...(w.fout ? [{ label: st.err ? T.errorLabel : T.static.output, slot: "full-out", k: st.id, tool: d?.name, kind: "out", failed: st.err } as const] : []),
    ],
  });
}

/** 点了左边的「在问」「回答」：整句话、完整的回答 */
function openRound(which: "ask" | "ans") {
  const S = G.focusSid ? M.sessions.get(G.focusSid) : null;
  const att = S ? (which === "ask" ? S.askAtt : S.ansAtt) : undefined;
  if (!S || !att?.f) return;
  openDetail({ sid: S.sid, kicker: [S.project, S.label].join(" · "), title: which === "ask" ? S.ask : S.ans,
    parts: [{ label: which === "ask" ? T.static.asked : T.static.answer, slot: which === "ask" ? "full-ask" : "full-ans", k: att.k, kind: "text" }] });
}
$("f-ask").onclick = () => openRound("ask");
$("f-ans").onclick = () => openRound("ans");

// ------------------------------------------------------------------ 每一帧

let lastTp = performance.now(), offK = 0, offTp: number | null = null;

function frame(tp: number) {
  // 先约好下一帧：这一帧里哪里抛了异常，也只是丢这一帧，不会让整个页面从此定住
  requestAnimationFrame(frame);
  if (PERF.on && tp - T0 > 2000) { PERF.frame.push(tp - lastTp); if (PERF.frame.length > 600) PERF.frame.shift(); }
  const tf0 = performance.now();
  const dt = Math.min(0.05, (tp - lastTp) / 1000); lastTp = tp;
  if (RANDOM_DEMO) { demoUniverseTick(); if (app.view === "galaxy" || app.trans?.dir === "in") demoTick(); }
  refreshText();
  // 和服务断开了：offK 慢慢走到 1，画面压暗、公转自转停下；球上的动画停在断开的那一刻（ftp）
  const lost = !DEMO && conn.lost;
  offK += ((lost ? 1 : 0) - offK) * (1 - Math.exp(-dt / 0.2));
  if (lost) offTp ??= tp; else offTp = null;
  const ftp = offTp ?? tp, run = 1 - offK;
  F.offline = lost;

  let ua = 0, ga = 0, boost: { id: string; k: number } | null = null;
  if (app.trans) {
    const p = clamp((tp - app.trans.t0) / FLY_MS, 0, 1), e = p * p * (3 - 2 * p);
    if (app.trans.dir === "in") { ua = 1 - smooth(0.5, 0.95, p); ga = smooth(0.3, 0.9, p); boost = { id: app.trans.id, k: Math.exp(e * 4.2) }; }
    else { ga = 1 - smooth(0, 0.55, p); ua = smooth(0.15, 0.8, p); boost = { id: app.trans.id, k: Math.exp((1 - e) * 4.2) }; }
    if (p >= 1) {
      const t = app.trans;
      app.view = t.dir === "in" ? "galaxy" : "universe";
      if (t.dir === "out") resetGalaxy(null);
      app.trans = null;
      if (t.locate) locateMine();
    }
  } else if (app.view === "galaxy") ga = 1;
  else ua = 1;

  if (ua > 0.001) { universeFrame(tp, dt, ua, boost, run); resetHud(); }
  if (ga > 0.001) galaxyFrame(tp, dt, ga, run, ftp, lost);
  else setStyle("focus", "opacity", "0");
  dim(offK);
  // 这几项每帧都算，但只在变了的时候才真的写进 DOM
  setStyle("conn", "opacity", smooth(0, 0.6, offK).toFixed(3));
  if (!DEMO) updateBar(conn.local, U.mine, app.view === "galaxy" ? M.galaxyId : null);
  setText("mode", DEMO ? "DEMO" : conn.local ? "LOCAL" : conn.hello && ATT.keys ? `${T.groupMode} ${fingerprint(ATT.keys.group, true)}` : "");

  if (PERF.on && tp - T0 > 2000) { PERF.cpu.push(performance.now() - tf0); if (PERF.cpu.length > 600) PERF.cpu.shift(); }
}

// ------------------------------------------------------------------ 操作

addEventListener("resize", () => { resize(); fitCam(false); });
addEventListener("pointermove", e => {
  mouse.x = U.mouse.x = e.clientX; mouse.y = U.mouse.y = e.clientY; mouse.inside = U.mouse.inside = true;
  if (U.drag.on) {
    const dx = e.clientX - U.drag.x, dy = e.clientY - U.drag.y;
    U.drag.moved += Math.abs(dx) + Math.abs(dy);
    if (U.drag.moved >= 6) panBy(dx, dy);
    U.drag.x = e.clientX; U.drag.y = e.clientY;
  }
  if (!drag.on) return;
  const dx = e.clientX - drag.x, dts = Math.max(1, e.timeStamp - drag.t) / 1000;
  drag.moved += Math.abs(dx) + Math.abs(e.clientY - drag.y);
  if (drag.pan) { if (drag.moved >= 6) panGalaxy(dx, e.clientY - drag.y); }   // 放大以后：平移
  else if (drag.rotate) {   // 抓着近的一侧往右拖，近的一侧就往右走；抓着远的一侧则相反
    const da = drag.sign * dx / (view.rsys * 0.85 * Math.exp(cam.lz));
    G.dragAngle += da; drag.v = clamp(lerp(drag.v, da / dts, 0.5), -4, 4);
  }
  drag.x = e.clientX; drag.y = e.clientY; drag.t = e.timeStamp;
});
document.addEventListener("mouseleave", () => { mouse.inside = U.mouse.inside = false; });
cv.addEventListener("pointerdown", e => {
  if (e.button !== 0 || app.trans) return;
  if (app.view === "universe") Object.assign(U.drag, { on: true, moved: 0, x: e.clientX, y: e.clientY });
  else Object.assign(drag, { on: true, rotate: !G.focusSid && !zoomed(), pan: !G.focusSid && zoomed(), moved: 0, x: e.clientX, y: e.clientY, t: e.timeStamp, v: 0,
                              sign: e.clientY >= scr(0, 0)[1] ? -1 : 1 });
  cv.setPointerCapture(e.pointerId);
});
const drop = (e: PointerEvent) => {
  if (U.drag.on) {
    U.drag.on = false;
    if (U.drag.moved < 6 && e.type === "pointerup" && U.hover) enter(U.hover);
    return;
  }
  if (!drag.on) return;
  drag.on = false;
  if (e.timeStamp - drag.t > 120) drag.v = 0;   // 停住了再松手：不甩出去
  if (drag.moved >= 6 || e.type !== "pointerup") return;
  drag.v = 0;   // 没拖动就是点击
  if (G.focusSid) {
    const P = G.placed.get(G.focusSid);
    if (P && G.hoverStep) openStep(P.S, G.hoverStep);
    else if (P && F.hoverSub && F.hoverSubStep) openStep(P.S, F.hoverSubStep, F.hoverSub);
    else if (!P || Math.hypot(e.clientX - cam.sx, e.clientY - cam.sy) > P.r * Math.exp(cam.lz) * 1.7) { closeDetail(); focus(null); }
  } else if (G.hoverSid) focus(G.hoverSid);
};
cv.addEventListener("pointerup", drop);
cv.addEventListener("pointercancel", drop);
cv.addEventListener("wheel", e => {
  if (app.trans) return;
  e.preventDefault();
  // 触控板捏合给的 deltaY 很小、很密，鼠标滚轮一格是 100 左右：一格放大约 1.16 倍
  if (app.view === "universe") zoomAt(e.clientX, e.clientY, -e.deltaY * 0.0015);
  else zoomGalaxy(e.clientX, e.clientY, -e.deltaY * 0.0015);
}, { passive: false });
addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "Escape" && (detailOpen() || panelOpen())) { closeDetail(); closePanel(); return; }
  if ((e.key === "m" || e.key === "M") && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) { if (U.mine && !app.trans) mineFx("press", 140); locateMine(); }
  if (app.view === "galaxy" && !app.trans) {
    if (e.key === "Escape") { if (G.focusSid) focus(null); else if (zoomed()) zoomHome(); else leave(); }
    if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && G.focusSid) {
      const all = M.groups.flatMap(g => g.sids), i = all.indexOf(G.focusSid);
      if (i >= 0) { closeDetail(); focus(all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length]); }
    }
    if (RANDOM_DEMO && !G.focusSid && (e.key === "+" || e.key === "=")) demoAdd();   // 演示：加一个项目（最外面）
    if (RANDOM_DEMO && !G.focusSid && e.key === "-") demoRemove();                   // 演示：随机去掉一个项目
  }
});
// 只有用户自己改地址、点链接才会触发（replaceState 不会）
addEventListener("hashchange", () => void applyHash(readHash(), { initial: false }));

// 调试、截图用
const r3 = (a: number) => +a.toFixed(3), avg = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
(window as unknown as { __galaxy: unknown }).__galaxy = {
  enter, leave, locate: locateMine, mine: () => U.mine, view: () => (app.trans ? `${app.trans.dir}:${app.trans.id}` : app.view), galaxy: () => M.galaxyId,
  rows: () => U.rows.size, focus, focused: () => G.focusSid,
  ids: () => [...U.rows.values()].sort((a, b) => b.n - a.n).map(r => r.id),
  uat: (id: string) => { const r = U.rows.get(id); return r ? uscr(...(worldOf(r) as [number, number])) : null; },
  list: () => [...M.sessions.values()].map(s => ({ sid: s.sid, label: s.label, project: s.project, status: s.status, phase: s.phase, bg: s.bg,
    sats: s.sats.length, steps: s.steps.length, laps: s.lapsShown, phrases: s.steps.slice(-3).map(x => x.phrase),
    subs: [...s.subs.values()].map(a => ({ id: a.aid, type: a.type, status: a.status, ended: a.endAt != null, steps: a.steps.length })) })),
  hover: (x: number, y: number) => { mouse.x = U.mouse.x = x; mouse.y = U.mouse.y = y; mouse.inside = U.mouse.inside = true; },
  conn: debugConn,
  at: (sid: string) => { const P = G.placed.get(sid); return P ? scr(P.wx, P.wy) : null; }, origin: () => scr(0, 0),
  subSpots: () => [...F.subSpots].map(([k, v]) => ({ k, ...v })),
  demoAdd, demoRemove,
  /** 打开某个对话倒数第 i 步的详情 */
  detail: (sid: string, i = 1) => { const S = M.sessions.get(sid); const st = S?.steps[S.steps.length - i]; if (S && st) openStep(S, st); return st?.phrase; },
  round: openRound,
  orbits: () => M.orbitList.map(O => ({ key: O.key, title: O.title, leaving: O.leaving, wl: r3(O.wl), p: r3(O.p), rho: O.rho && r3(O.rho) })),
  perf: () => ({ star: starInfo(), stress: PERF.stress, n: PERF.frame.length, rows: U.rows.size,
    starAvg: r3(avg(PERF.star)), starP95: r3(pctl(PERF.star, 0.95)), cpuAvg: r3(avg(PERF.cpu)), cpuP95: r3(pctl(PERF.cpu, 0.95)),
    frameAvg: r3(avg(PERF.frame)), frameP95: r3(pctl(PERF.frame, 0.95)) }),
};

applyStatic();
mineBtn.onclick = () => locateMine();
$("invite").textContent = T.invite;
$("invite").onclick = () => showInvite();
// 「清除缓存」：你的星系在不在群里（在的话提醒去 Claude Code 里退）；不看以后画面清空，回到宇宙
groupHooks.mineHere = () => { const r = U.mine ? U.rows.get(U.mine) : undefined; return !!r && r.goneAt == null; };
groupHooks.left = () => {
  if (app.view === "galaxy") leave();
  applySummary([], [], true);
  app.autoEntered = false; app.userLeft = false;
};
// 用 /agent-loop:leave 退出了这个群：这个浏览器里也不再有「你的星系」（回去以后 /agent-loop:galaxy 会再记上）
groupHooks.forgetMine = () => {
  showMine(null);
  legacyMine = null;
  try { localStorage.removeItem(MINE_KEY); } catch { /* ignore */ }
};
$("insecure").textContent = T.insecure;
$("insecure").title = T.insecureTitle;
resize();
showMine(storedMine());
if (RANDOM_DEMO) { startDemoUniverse(); fitCam(true); }
if (DEMO && !RANDOM_DEMO) {
  ATT.plain = true;   // 剧本里的附件都是明文
  player = startPlayback(m => onMsg(m));
  setFullFetcher(player.full);
  // 一条固定的提示：这是演示数据；旁边是「装到自己的 Claude Code」
  setStyle("demo-bar", "display", "flex");
  $("demo-t").textContent = T.demoNote;
  $("demo-link").textContent = T.demoInstall;
  ($("demo-link") as HTMLAnchorElement).href = REPO_URL;
}
if (!DEMO) setFullFetcher(requestFull);
// 地址里的 #left=、邀请链接里的密钥处理完再连接（不然会先拿着旧密钥连上这个群）
void applyHash(readHash(), { initial: true }).then(() => {
  if (!DEMO) connect(onMsg, () => { syncGroupUi(); tryArrival(); });
});
requestAnimationFrame(frame);
void V;
