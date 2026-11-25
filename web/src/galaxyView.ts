// 行星系视图：正中间的恒星是模型（star.ts）；每条轨道是一个项目；轨道上每个小球（行星）是一个对话，边公转边自转。
// 球上每根线是这个对话里的一步（一次工具调用），长度 = 耗时（对数刻度）；圈数和步数是整个对话累计的。
// 点一个小球，镜头飞过去，球摊平成一个表盘：各步从 12 点起顺时针排开，圈与圈之间留一个缝、轮与轮之间留一个大缝，
// 圆心是圈数，扫过去看那一步做了什么。按住空白处左右拖可以转动整个星系。
import { ctx, fit, grain, textW, V } from "./canvas.ts";
import { detailOpen } from "./detail.ts";
import { currentStep, drawFog, drawRing, dust, syncSats } from "./draw.ts";
import { PERF, drawStar, galaxyModel, massOf, starOf } from "./star.ts";
import {
  DRAW_S, FOLD_S, M, PULSE_MS, RING_F, ROOM_S, SUB_BACK_MS, bgOnly, hasFull, isEnded, layout, subsAlive, wordOf,
  type Orbit, type Ring, type Session, type Step,
} from "./model.ts";
import { F, PERSP, cam, project, scr, view } from "./scene.ts";
import { drawSky } from "./sky.ts";
import { $, CLAUDE, FONT, HOT, INK, TAU, clamp, col, lerp, now, setStyle, setText, smooth } from "./util.ts";

const BG = "11,12,14";   // 背景 #0B0C0E
/** 相邻两条轨道的半径比（放得下时）。太阳系里水星→金星 1.9、金星→地球 1.4、地球→火星 1.5 */
const ORBIT_Q = 1.5;
import { T } from "./i18n.ts";

export interface Placed { S: Session; wx: number; wy: number; vis: number; ghost: boolean; r: number; a: number }

export const G = {
  focusSid: null as string | null,
  hoverSid: null as string | null,
  hoverStep: null as Step | null,
  orbitClock: 0, orbitSpeed: 1,
  detailK: 0,   // 步骤详情开着（0→1）：表盘让到左边剩下的地方，左边的文字淡掉
  dragAngle: 0, lastDragAngle: 0,
  placed: new Map<string, Placed>(),
  orbits: [] as { O: Orbit; k: number; R: number; e: number; title: string; phase: number; labelA: number; rm: number }[],
  starM: 1,            // 恒星的质量（缓动着跟模型走）
  bx: 0, by: 0,        // 恒星相对质心的位置（轨道面上的坐标）
};

// ---- 引力。物理依据见 docs/physics.md 的「行星系」
/** 恒星被行星拉着绕质心转：偏离质心 = Σ 行星质量 × 行星位置 / 恒星质量 × WOBBLE。行星质量 ∝ 大小³ */
const WOBBLE = 0.03;
/** 对话走了：沿抛物线（刚好是逃逸速度）飞出去；新对话来了：沿抛物线从外面落进轨道。各用多久（ms），飞到轨道半径的 1 + PARA_D² 倍 */
const ESC_MS = 2200, CAP_MS = 2000, PARA_D = 1.25;
const PARA_S = PARA_D + PARA_D ** 3 / 3;
/**
 * 抛物线轨道上，从近日点（就是原来的轨道上那一点）出发经过的时间 ∝ D + D³/3（Barker 方程），D = tan(真近点角 / 2)，
 * 半径 = 近日点距离 × (1 + D²)。给定时间进度 u（0→1）反解 D 是个三次方程，用卡尔达诺公式直接解出来，不用迭代
 */
function barkerD(u: number) {
  const b = 1.5 * u * PARA_S, q = Math.sqrt(b * b + 1);
  return Math.cbrt(b + q) + Math.cbrt(b - q);
}
/** 恒星抛出的那层壳从星面走到最远要多久（ms） */
const SHELL_MS = 1300;
const HOT_RGB = HOT.split(",").map(Number), CLAUDE_RGB = CLAUDE.split(",").map(Number);
/**
 * 光点落回恒星时，恒星往外抛一层发光的气体壳（像日冕物质抛射）。壳是球形的，投到屏幕上是个圆盘：
 * 视线穿过壳的路程 L(b) = 2(√(Ro²−b²) − √(Ri²−b²))（b 是到圆心的距离），在内半径处最长，
 * 所以边缘最亮、往里渐暗、圆心处还有一层薄光——这就是看起来是个球而不是一个圈的原因。
 * 恒星挡住后半个壳：星面以内只算前半段路程。壳越走越厚越淡，颜色从刚离开星面的白热退到铜色。
 * rs：恒星半径；rEnd：壳最后走到的外半径；q：0→1 的进度
 */
function starShell(x: number, y: number, rs: number, rEnd: number, q: number, alpha: number) {
  const e = 1 - (1 - q) ** 2.4;                       // 先快后慢：被抛出去以后一路减速
  const ro = lerp(rs * 1.02, rEnd, e), d = ro * (0.07 + 0.16 * q), ri = Math.max(0, ro - d);
  const amp = 0.3 * alpha * (1 - q) ** 1.4 * smooth(0, 0.06, q);
  if (amp < 0.004) return;
  const c = HOT_RGB.map((h, k) => Math.round(lerp(h, CLAUDE_RGB[k], smooth(0, 0.45, q)))).join(",");
  const lmax = 2 * Math.sqrt(ro * ro - ri * ri);
  const L = (b: number) => 2 * (Math.sqrt(Math.max(0, ro * ro - b * b)) - Math.sqrt(Math.max(0, ri * ri - b * b))) * (b < rs ? 0.5 : 1) / lmax;
  const bs = [0, 0.4, 0.7, 0.85, 0.95, 1].map((t) => t * ri).concat([0.2, 0.45, 0.7, 0.9, 1].map((t) => ri + t * d));
  if (rs < ro) bs.push(rs * 0.999, rs * 1.001);
  bs.sort((a, b) => a - b);
  const rg = ro * 1.03, g = ctx.createRadialGradient(x, y, 0, x, y, rg);
  for (const b of bs) g.addColorStop(Math.min(1, b / rg), col(c, amp * L(b)));
  g.addColorStop(1, col(c, 0));
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rg, 0, TAU); ctx.fill();
  ctx.restore();
}

export const drag = { on: false, rotate: false, pan: false, moved: 0, x: 0, y: 0, t: 0, sign: 1, v: 0 };   // 按住拖动：总览时转动整个星系；放大以后是平移（pan），不转动（要转就缩回总览）
export const mouse = { x: -1e4, y: -1e4, inside: false, px: 0, py: 0 };

// ---- 滚轮缩放（总览时）：镜头往行星系里飞近，近看恒星和行星。
// 缩放绕着一个钉住的点：屏幕上的 (qx,qy)（相对总览时恒星在屏幕上的位置）一直对着平面上的 (ax,ay)。
// 在一颗行星上滚动时钉住的是这颗行星：它边公转，镜头边跟着。uz 是在总览镜头上再放大多少（对数），uzT 是目标
export const Z = { uz: 0, uzT: 0, ax: 0, ay: 0, qx: 0, qy: 0, sid: null as string | null };
const ZOOM_MAX = Math.log(10);
/** 这一帧总览（含缩放）的映射：屏幕 = (ox,oy) + 平面坐标 × z；(o0x,o0y) 和 zb 是不缩放时的 */
const zoomView = { ox: 0, oy: 0, z: 1, zb: 1, o0x: 0, o0y: 0 };

export function zoomed() { return Z.uzT > 0.001 || Z.uz > 0.001; }
export function resetZoom() { Z.uz = Z.uzT = 0; Z.sid = null; Z.ax = Z.ay = Z.qx = Z.qy = 0; }

/** 鼠标在 (mx,my) 滚了 dz（对数）。放大时钉住鼠标下的那一点（或那颗行星）；缩小时钉住「回到总览时不动的那一点」，退到底正好回到总览 */
export function zoomGalaxy(mx: number, my: number, dz: number) {
  if (G.focusSid) return;
  const { ox, oy, z, zb, o0x, o0y } = zoomView;
  const uzT = clamp(Z.uzT + dz, 0, ZOOM_MAX);
  if (uzT === Z.uzT) return;
  if (dz > 0) {
    const P = G.hoverSid ? G.placed.get(G.hoverSid) : null;
    if (P && !P.ghost) {
      if (Z.sid === P.S.sid) { Z.uzT = uzT; return; }   // 已经盯着它了
      Z.sid = P.S.sid; Z.ax = P.wx; Z.ay = P.wy;
    } else { Z.sid = null; Z.ax = (mx - ox) / z; Z.ay = (my - oy) / z; }
  } else {
    Z.sid = null;
    if (z - zb < 1e-3) { Z.uzT = uzT; return; }
    // 现在的画面和总览重合的那一点：ox + a·z = o0 + a·zb
    Z.ax = (o0x - ox) / (z - zb); Z.ay = (o0y - oy) / (z - zb);
  }
  // 钉住的点在屏幕上的位置，存成相对总览原点的偏移：鼠标视差照样起作用
  Z.qx = ox + Z.ax * z - o0x; Z.qy = oy + Z.ay * z - o0y;
  Z.uzT = uzT;
}

/**
 * 放大以后按住拖动：平移画面（钉住的那一点跟着鼠标走）。拖动时不再盯着行星。
 * 画面中心不能拖出最外面一条轨道，免得拖到一片空白里找不回来
 */
export function panGalaxy(dx: number, dy: number) {
  if (G.focusSid || !zoomed()) return;
  const { z, o0x, o0y } = zoomView;
  Z.sid = null;
  Z.qx += dx; Z.qy += dy;
  const ox = o0x + Z.qx - Z.ax * z, oy = o0y + Z.qy - Z.ay * z;
  const cx = (V.W / 2 - ox) / z, cy = (V.H / 2 - oy) / z;   // 画面中心对着平面上的哪一点
  const bx = view.rsys, by = view.rsys * view.tilt * 1.25;   // 近的一侧有透视放大，竖直方向多留一点
  Z.qx -= (clamp(cx, -bx, bx) - cx) * z; Z.qy -= (clamp(cy, -by, by) - cy) * z;
}

/** Esc：退回总览 */
export function zoomHome() { zoomGalaxy(0, 0, -Z.uzT); }

export function reanchor(sid: string | null) {
  const P = sid ? G.placed.get(sid) : null;
  const wx = P ? P.wx : 0, wy = P ? P.wy : 0;
  [cam.sx, cam.sy] = scr(wx, wy);
  cam.px = wx; cam.py = wy; cam.sid = P ? sid : null;
}

export function focus(sid: string | null) {
  if (sid && !M.sessions.has(sid)) return;
  G.focusSid = sid || null;
  if (G.focusSid) resetZoom();   // 点进一个对话再出来，回到不缩放的总览
  if (G.focusSid && cam.sid !== G.focusSid) reanchor(G.focusSid);
}

/** 进入一个星系：镜头回到总览，开场动画重新放一遍 */
export function enterGalaxy() {
  G.focusSid = null; G.hoverSid = null; G.hoverStep = null;
  cam.ready = false; cam.sid = null; cam.f = 0; cam.subK = 0;
  G.placed = new Map(); G.orbits = []; G.bx = G.by = 0;
  resetZoom();
}

// 鼠标指着一个小环时的卡片
let cardKey = "";
function updateCard(P: Placed | null, x: number, y: number, r: number, t: number, alpha: number) {
  if (!P || alpha < 0.5) { setStyle("card", "opacity", "0"); return; }
  const S = P.S, cur = currentStep(S, t);
  const state = [wordOf(S), S.lapsShown ? T.lap(S.lapsShown) : "", S.steps.length ? T.steps(Math.max(S.stepsTotal, S.steps.length)) : ""].filter(Boolean).join(" · ");
  const step = [cur.text, cur.sub].filter(Boolean).join(" · ") || "—";
  const subs = subsAlive(S), sc = subs.length ? currentStep(subs[0], t) : null;
  const subTxt = subs.length ? [T.subagents(subs.length), subs[0].type === "custom" ? T.custom : subs[0].type, sc!.text].filter(Boolean).join(" · ") : "";
  const key = [S.sid, S.label, S.project, state, step, S.status, subTxt].join("|");
  if (key !== cardKey) {
    cardKey = key;
    $("c-proj").textContent = S.project; $("c-title").textContent = S.label;
    $("c-state").textContent = state; $("c-step").textContent = step;
    $("c-subs").textContent = subTxt; setStyle("c-subrow", "display", subTxt ? "" : "none");
    $("card").dataset.status = S.status;
  }
  const { W } = V, above = y - r * 1.75 - 18 > 150;
  setStyle("card", "left", clamp(x, 170, W - 170).toFixed(1) + "px");
  setStyle("card", "top", (above ? y - r * 1.75 - 14 : y + r * 1.75 + 14).toFixed(1) + "px");
  setStyle("card", "transform", `translate(-50%, ${above ? "-100%" : "0"})`);
  setStyle("card", "opacity", "1");
}

let hudKey = "";
/** 宇宙视图也写了底部的文字：下一帧星系视图重新写一遍 */
export function resetHud() { hudKey = ""; }

/**
 * 画一帧星系。alpha：从宇宙飞进来、飞回去时的淡入淡出；run：和服务断开时为 0（停转）；ftp：断开时停住的动画时钟。
 */
export function galaxyFrame(tp: number, dt: number, alpha: number, run: number, ftp: number, connLost: boolean) {
  const { W, H } = V;
  const age = tp - M.bornAt, intro = smooth(0, 1, age / 1700);
  const eCam = 1 - Math.exp(-dt / 0.13), eSlow = 1 - Math.exp(-dt / 0.2);
  const sessions = M.sessions;
  let working = 0;
  for (const s of sessions.values()) if (s.status === "working" && s.goneAt == null) working++;
  const liveN = M.groups.reduce((a, g) => a + g.sids.length, 0);

  // ---- 布局：轨道和每个对话的位置
  // rout 是画面能容下的最大轨道（也是透视的参照：镜头离轨道面多远），轨道不一定都排到这么远
  view.rout = W * 0.43;
  view.tilt = clamp(H * 0.8 / (view.rout * (1 / (1 - PERSP) + 1 / (1 + PERSP))), 0.2, 0.48);
  const rmBase = clamp(Math.min(W, H) * 0.027, 14, 27);
  const star = starOf(galaxyModel());
  G.starM += (massOf(star) - G.starM) * (1 - Math.exp(-dt / 1.5));   // 换了模型：转速、晃动慢慢变过去
  const kep = Math.sqrt(G.starM);   // 开普勒：同一半径上，角速度 ∝ √恒星质量
  G.orbitSpeed += ((1 - cam.f) * run * (drag.on ? 0 : G.hoverSid && !G.focusSid ? 0.15 : 1) - G.orbitSpeed) * eSlow;
  G.orbitClock += dt * G.orbitSpeed * kep;
  if (!drag.on) { G.dragAngle += drag.v * dt; drag.v *= Math.exp(-dt / 0.45); }   // 松手后带一点惯性

  // 轨道的进场、退场（见 model.ts 的 syncGroups）。wl、p 匀速走，用的时候再过一道 smooth，掉头也是连续的
  for (const O of M.orbitList) {
    if (O.leaving) {
      O.p = Math.max(0, Math.min(1, O.p) - dt / FOLD_S);
      if (O.p < 0.4) O.wl = Math.max(0, O.wl - dt / ROOM_S);   // 线收得差不多了，再合上缝
    } else {
      O.wl = Math.min(1, O.wl + dt / ROOM_S);
      if (O.wl > 0.5 || O.p < 0) O.p = Math.min(1, O.p + dt / DRAW_S);   // 位置让出一半了，开始画线
    }
  }
  M.orbitList = M.orbitList.filter(O => {
    if (!O.leaving || O.p > 0 || O.wl > 0) return true;
    M.orbitMap.delete(O.key); return false;
  });
  // 半径：从里往外按等比排开（行星系里相邻两条轨道的半径比差不多是常数，提丢斯-波得定则；太阳系里是 1.4～1.9），
  // 最里面一条在 rin，每往外一条乘 q。项目少的时候行星系就小，放不下了才把 q 压小、最外面一条贴着 rout。
  // 项目很多时 rin 也往里收一点；q 压得太小时里面几条挤在一起、名字叠住，就渐渐改成等距（cr 从 0 到 1）。
  // 占位是小数，所以一切都是连续的
  const ws = M.orbitList.map(O => smooth(0, 1, O.wl)), nEff = ws.reduce((a, b) => a + b, 0);
  const rin = clamp(0.4 - 0.025 * (nEff - 3), 0.28, 0.4);
  const q = nEff > 1 ? Math.min(ORBIT_Q, Math.pow(1 / rin, 1 / (nEff - 1))) : ORBIT_Q;
  const cr = smooth(1.4, 1.2, q), gap = (1 - rin) / Math.max(1, nEff - 1);
  const tiltZ = Math.sqrt(1 - view.tilt * view.tilt);   // 轨道面往屏幕里倾斜的那一分量：算球的受光方向用
  let inside = 0;
  G.orbits = M.orbitList.map((O, k) => {
    const idx = Math.max(0, inside + ws[k] - 1);   // 从里往外第几条（新来的、要走的只算一部分）
    inside += ws[k];
    const e = smooth(0, 1, O.p);
    const rho = lerp(rin * Math.pow(q, idx), rin + gap * idx, cr) * (O.leaving ? 1 : 1 + 0.06 * (1 - e));   // 新的一条从稍外面落进来
    O.rho = O.rho == null ? rho : O.rho + (rho - O.rho) * eSlow;
    // 开普勒第三定律：周期² ∝ 半径³ / 恒星质量，角速度 ∝ 半径^-1.5。类太阳恒星时最外面一圈 8 分钟转一周；轨道挪了位置，速度跟着慢慢变
    O.spin += dt * G.orbitSpeed * kep * TAU / 480 / Math.pow(Math.max(0.2, O.rho), 1.5);
    const R = view.rout * O.rho, count = O.sids.length || O.ghosts.length;
    return { O, k, R, e, title: O.title, phase: O.phase0 + O.spin + G.dragAngle,
             labelA: smooth(0, 0.25, O.p), rm: Math.min(rmBase, R * (1 + view.tilt) / 2 * TAU / (Math.max(1, count) * 4.6)) };
  });
  // 竖直方向按行星系实际的大小居中（透视让近的一侧更大，中心要往上让一点）
  const rsys = Math.max(rin * view.rout, ...G.orbits.map(o => o.R));
  view.rsys = rsys;
  view.oy = H * 0.5 - rsys * view.tilt * (1 / (1 - PERSP * rsys / view.rout) - 1 / (1 + PERSP * rsys / view.rout)) / 2;
  if (!cam.ready) { cam.sx = W / 2; cam.sy = view.oy; cam.lz = Math.log(0.9); cam.ready = true; }
  const placed = new Map<string, Placed>();
  G.placed = placed;
  let bx = 0, by = 0;   // Σ 行星质量 × 位置（轨道面上），算恒星被拉到哪
  /** 把一个对话放在轨道面上半径 r、角度 th 处 */
  const place = (S: Session, r: number, th: number, rm: number, vis: number, ghost: boolean) => {
    const X = r * Math.cos(th), Y = r * Math.sin(th);
    if (PERSP * Y >= view.rout * 0.9) return;   // 飞出去的球不能跑到镜头后面
    const [wx, wy, s] = project(X, Y);
    // 光从中心的恒星照过来：轨道面上指向圆心是 (-cos, -sin)，轨道面往屏幕上压扁 tilt，近的一侧（sin > 0）朝着你
    const st = Math.sin(th), L = (S.light ??= [0, 0, 0]);   // 每帧都要写：原地改，不新建数组
    L[0] = -Math.cos(th); L[1] = -st * view.tilt; L[2] = -st * tiltZ;
    placed.set(S.sid, { S, wx, wy, vis, ghost, r: rm * s * S.sizeK!, a: lerp(0.56, 1, (st + 1) / 2) });
    const m = S.sizeK! ** 3 * vis * smooth(0, 1, (tp - S.bornAt) / 520);   // 还没出现的、飞走了的不算
    bx += m * X; by += m * Y;
  };
  for (const o of G.orbits) {
    const O = o.O;
    const put = (sid: string, i: number) => {
      const S = sessions.get(sid);
      if (!S || placed.has(sid)) return;
      const ghost = i < 0;
      if (ghost && S.goneAt == null) return;   // 不是真的走了（换到了别的轨道上）
      if (!ghost) {
        const target = TAU * i / O.sids.length;
        if (S.off == null || S.orb !== O) S.off = target;
        else { let dd = (target - S.off) % TAU; if (dd > Math.PI) dd -= TAU; if (dd < -Math.PI) dd += TAU; S.off += dd * eSlow; }
        S.esc = null;
      } else if (S.off == null) S.off = 0;
      S.orb = O;
      // 步数多的对话大一点：不是所有的环都一样重
      const sizeT = 0.8 + 0.42 * clamp(Math.log(1 + Math.max(S.stepsTotal, S.steps.length)) / Math.log(600), 0, 1);
      S.sizeK = S.sizeK == null ? sizeT : S.sizeK + (sizeT - S.sizeK) * eSlow;
      const th = o.phase + S.off;
      // 走了：记下起飞的那一点，下面沿抛物线飞出去（轨道收走了也照样飞完）
      if (ghost) { S.esc ??= { R: o.R, th: th - G.dragAngle, rm: o.rm }; return; }
      // 球跟着线走：线从项目名那一点（th = π/2）画过来，扫过这个球时它才出现；收回去时扫过就消失
      const rel = (((th - Math.PI / 2) % TAU) + TAU) % TAU / TAU;
      const vis = smooth(rel, rel + 0.06, o.e * 1.06);
      // 开场以后才来的：沿抛物线从外面落进来，正好在近日点停到轨道上（逃逸倒过来放）。真实的捕获要有第三个天体或者气体拖拽带走多余的能量
      const uc = S.capture ? (tp - S.bornAt) / CAP_MS : 1;
      if (uc < 1) {
        const D = barkerD((1 - Math.max(0, uc)) ** 1.6);   // 到站前放慢，接上轨道上的速度
        place(S, o.R * (1 + D * D), th - 2 * Math.atan(D), o.rm, 1, O.leaving);
      } else place(S, o.R, th, o.rm, vis, O.leaving);
    };
    O.sids.forEach(put);
    O.ghosts.forEach(sid => put(sid, -1));
  }
  // 走了的对话：从原来的轨道上加速到逃逸速度，沿抛物线飞走，越飞越慢，边飞边淡
  for (const S of sessions.values()) {
    const E = S.esc;
    if (!E || S.goneAt == null || placed.has(S.sid)) continue;
    const u = clamp((tp - S.goneAt) / ESC_MS, 0, 1), D = barkerD(u ** 1.6);   // 起步时放慢，从轨道上的速度接过来
    place(S, E.R * (1 + D * D), E.th + G.dragAngle + 2 * Math.atan(D), E.rm, 1 - smooth(0.35, 1, u), true);
  }
  // 恒星和行星绕共同的质心转：质心不动（在原点），恒星在行星的反方向，偏离 ∝ 行星质量 / 恒星质量
  const k = WOBBLE / G.starM;
  G.bx += (-bx * k - G.bx) * eSlow; G.by += (-by * k - G.by) * eSlow;
  const [swx, swy] = project(G.bx, G.by);
  // 退场动画放完了的对话，这才真的删掉
  for (const S of [...sessions.values()]) {
    if (S.goneAt == null) continue;
    const P = placed.get(S.sid);
    if (!P || (P.vis <= 0 && tp - S.goneAt > 100)) {
      sessions.delete(S.sid); placed.delete(S.sid);
      for (const B of S.subs.values()) F.subSpots.delete(B.sid);
    }
  }
  for (const O of M.orbitList) O.ghosts = O.ghosts.filter(sid => sessions.has(sid));
  const tickRing = (S: Ring) => {
    for (const s of S.steps) {
      const tf = s.k <= 2 ? RING_F[s.k] : 0.5;
      s.a = (s.a ?? s.ta) + (s.ta - (s.a ?? s.ta)) * eSlow; s.f += (tf - s.f) * eSlow;
      if (Math.abs(tf - s.f) < 0.001) s.f = tf;
    }
    S.ringsAnim += (S.rings - S.ringsAnim) * eSlow;
    syncSats(S, tp, dt * run);
    S.curA += (S.nextA - S.curA) * eSlow;
    // 自转：在跑的转得快，待命的几乎不动
    S.spinV += (TAU / (S.status === "working" ? (bgOnly(S) ? 40 : 18) : S.status === "waiting" ? 40 : 80) - S.spinV) * eSlow * 0.3;
    S.spin += S.spinV * dt * run;
    const rate = (S.status === "working" && !bgOnly(S) ? 0.55 : 0.16) * Math.min(1, S.steps.length / 10) * (F.offline ? 0 : 1);
    if (S.steps.length && S.twinkles.length < 4 && Math.random() < rate * dt) {
      const st = S.steps[Math.floor(Math.random() * S.steps.length)];
      if (st.end != null && st.k === 0) S.twinkles.push({ s: st, t0: tp });
    }
  };
  F.frameDt = dt;
  for (const S of sessions.values()) {
    tickRing(S);
    for (const A of S.subs.values()) {
      tickRing(A);
      if (A.endAt != null && tp - A.endAt > SUB_BACK_MS + 300) {   // 收回去了：记下来，服务端还列着它的这一会儿别再建
        S.subs.delete(A.aid); S.subGone.add(A.aid); F.subSpots.delete(A.sid);
      }
    }
  }

  // ---- 镜头
  if (G.focusSid && (!placed.has(G.focusSid) || placed.get(G.focusSid)!.ghost)) G.focusSid = null;
  if (cam.sid && !placed.has(cam.sid)) reanchor(null);
  const A = cam.sid ? placed.get(cam.sid) ?? null : null;
  // 放大的对话派着子 agent 时，表盘往左挪一点、小一点，右边让出一列给子 agent
  cam.subK += ((G.focusSid && A && A.S.subs.size ? 1 : 0) - cam.subK) * eSlow;
  const heroR = Math.min(H * 0.27, W * 0.17) * lerp(1, 0.9, cam.subK);
  if (A) { cam.px = A.wx; cam.py = A.wy; }
  // 鼠标带一点视差：整个星系跟着轻轻偏
  mouse.px += ((mouse.inside ? mouse.x / W - 0.5 : 0) - mouse.px) * eSlow * 0.5;
  mouse.py += ((mouse.inside ? mouse.y / H - 0.5 : 0) - mouse.py) * eSlow * 0.5;
  const parx = -mouse.px * 22 * (1 - cam.f), pary = -mouse.py * 14 * (1 - cam.f);
  let tsx, tsy, tlz, tf;
  G.detailK += ((G.focusSid && detailOpen() ? 1 : 0) - G.detailK) * eCam;
  if (G.focusSid && A) {
    tsx = lerp(W * lerp(0.64, 0.585, cam.subK), (W - Math.min(600, W * 0.46)) / 2, G.detailK); tsy = H * 0.5;
    tlz = Math.log(heroR * lerp(1, 0.85, G.detailK) / A.r); tf = 1;
  }
  else {
    // 总览：不缩放时恒星在 (o0x,o0y)；滚轮放大时钉住的那一点 (ax,ay) 一直在屏幕上的 o0 + q
    const zb = lerp(0.9, 1, intro), o0x = W / 2 + parx, o0y = view.oy + pary;
    Z.uz += (Z.uzT - Z.uz) * eCam;
    if (Z.uzT === 0 && Z.uz < 1e-3) { Z.uz = 0; Z.sid = null; }
    if (Z.sid) {
      const P = placed.get(Z.sid);
      if (P && !P.ghost) { Z.ax = P.wx; Z.ay = P.wy; } else Z.sid = null;
    }
    const zt = zb * Math.exp(Z.uz), ox0 = Z.uz > 0 ? o0x + Z.qx - Z.ax * zt : o0x, oy0 = Z.uz > 0 ? o0y + Z.qy - Z.ay * zt : o0y;
    Object.assign(zoomView, { ox: ox0, oy: oy0, z: zt, zb, o0x, o0y });
    tsx = ox0 + cam.px * zt; tsy = oy0 + cam.py * zt; tlz = Math.log(zt); tf = 0;
  }
  cam.sx += (tsx - cam.sx) * eCam; cam.sy += (tsy - cam.sy) * eCam;
  cam.lz += (tlz - cam.lz) * eCam; cam.f += (tf - cam.f) * eCam;
  // 滚轮缩放时镜头直接到位：uz 自己已经是缓动的，再缓一道的话，位置和缩放各缓各的，钉住的点会先甩出去再回来
  if (!G.focusSid && !cam.sid && zoomed()) { cam.sx = tsx; cam.sy = tsy; cam.lz = tlz; }
  if (!G.focusSid && cam.sid && cam.f < 0.002) { cam.lz = tlz; cam.sx = tsx; cam.sy = tsy; reanchor(null); }
  const z = Math.exp(cam.lz), f = cam.f, bgA = 1 - 0.88 * f;

  // ---- 鼠标指着谁
  G.hoverSid = null; G.hoverStep = null; F.hoverSub = null; F.hoverSubStep = null;
  const canHover = alpha > 0.9 && mouse.inside && !(drag.on && drag.moved >= 6);
  if (canHover && G.focusSid && A && f > 0.5) {
    for (const B of A.S.subs.values()) {
      const sp = B.spot;
      if (!sp || B.endAt != null) continue;
      const dx = mouse.x - sp.x, dy = mouse.y - sp.y, d = Math.hypot(dx, dy);
      if (d > sp.r * 1.8) continue;
      F.hoverSub = B;
      const a = (Math.atan2(dx, -dy) + TAU) % TAU;
      let best = B.slot * 0.9;
      for (const s of B.steps) {
        if (s.k !== 0) continue;
        let da = Math.abs((s.a ?? 0) - a) % TAU; if (da > Math.PI) da = TAU - da;
        if (da < best) { best = da; F.hoverSubStep = s; }
      }
      break;
    }
  }
  if (canHover && !F.hoverSub) {
    if (G.focusSid && A) {
      const dx = mouse.x - cam.sx, dy = mouse.y - cam.sy, dist = Math.hypot(dx, dy), r = A.r * z;
      const k = dist > r * 1.7 ? -1 : dist >= r * 0.9 ? 0 : dist >= r * 0.71 ? 1 : dist >= r * 0.55 ? 2 : -1;
      if (k >= 0) {
        const a = (Math.atan2(dx, -dy) + TAU) % TAU;
        let best = A.S.slot * 0.7;
        for (const s of A.S.steps) {
          if (s.k !== k) continue;
          let da = Math.abs((s.a ?? 0) - a) % TAU; if (da > Math.PI) da = TAU - da;
          if (da < best) { best = da; G.hoverStep = s; }
        }
      }
    } else if (f < 0.5) {
      let best = 1e9;
      for (const P of placed.values()) {
        if (P.ghost || P.vis < 0.5) continue;
        const [x, y] = scr(P.wx, P.wy), dist = Math.hypot(mouse.x - x, mouse.y - y);
        if (dist < P.r * z * 1.7 + 4 && dist < best) { best = dist; G.hoverSid = P.S.sid; }
        for (const B of P.S.subs.values()) {
          const sp = B.spot;
          if (!sp) continue;
          const d = Math.hypot(mouse.x - sp.x, mouse.y - sp.y);
          if (d < sp.r * 1.6 + 4 && d < best) { best = d; G.hoverSid = P.S.sid; }
        }
      }
    }
  }
  if (alpha > 0.9) setStyle("c", "cursor", drag.on && (drag.rotate || drag.pan) && drag.moved >= 6 ? "grabbing" : G.hoverSid || (A && hasFull(A.S, G.hoverStep ?? F.hoverSubStep)) ? "pointer" : G.focusSid ? "default" : drag.on ? "grabbing" : "grab");

  // ---- 背景：底色、中心的暖光、雾、颗粒、尘埃
  ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#0B0C0E"; ctx.fillRect(0, 0, W, H);
  drawSky(M.galaxyId ?? "", alpha * intro * (1 - 0.6 * cam.f));   // 远处的恒星：在无穷远，镜头怎么动都不动
  const [ox, oy] = scr(swx, swy);   // 恒星（被行星拉得偏离质心一点）
  if (f < 0.98) {   // 恒星的光照亮周围的尘埃：一大片很淡的光，颜色跟着恒星
    ctx.save(); ctx.translate(ox, oy); ctx.scale(1, 0.62);
    const R = view.rout * 0.95 * z, g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, col(star.limb, 0.075 * bgA * intro * star.lum)); g.addColorStop(0.4, col(star.limb, 0.022 * bgA * intro)); g.addColorStop(1, col(star.limb, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.restore();
  }
  drawFog(0, tp, bgA * intro, parx, pary);
  ctx.fillStyle = grain; ctx.fillRect(0, 0, W, H);
  // 尘埃的亮度不闪烁（星星一闪一闪是地球大气造成的，太空里看是稳定的），颜色都一样：只设一次，每颗只换 globalAlpha
  const dustA = alpha * (1 - 0.4 * f) * intro;
  ctx.fillStyle = `rgb(${INK})`;
  // project() 和 scr() 在这里展开写：每帧几百个点，不为每个点新建数组
  const zc = Math.exp(cam.lz), cx0 = cam.sx - cam.px * zc, cy0 = cam.sy - cam.py * zc;
  for (const p of dust) {
    const th = p.th + G.orbitClock * p.w, Y = Math.sin(th) * p.r * view.rout;
    const s = 1 / (1 - PERSP * Y / view.rout);
    if (s < 0) continue;
    const x = cx0 + Math.cos(th) * p.r * view.rout * s * zc + parx * (p.deep - 1), y = cy0 + Y * view.tilt * s * zc + pary * (p.deep - 1);
    if (x < 0 || x > W || y < 0 || y > H) continue;
    const sz = p.size * clamp(s, 0.6, 1.8);
    ctx.globalAlpha = dustA * p.al; ctx.fillRect(x, y, sz, sz);
  }
  ctx.globalAlpha = alpha;

  // ---- 轨道：远的一侧淡、近的一侧亮；项目名压在线上最靠近你的那一点
  ctx.font = `500 11px "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif`; ctx.letterSpacing = "1.6px";
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineWidth = 1;
  const N = Math.round(clamp(140 * Math.sqrt(z), 140, 640));
  for (const o of G.orbits) {
    const e = o.e;
    if (e <= 0) continue;
    const sNear = 1 / (1 - PERSP * o.R / view.rout), sFar = 1 / (1 + PERSP * o.R / view.rout);
    const tw = textW(o.title), cut = Math.min(0.5, (tw / 2 + 12) / (o.R * sNear * z));
    const a0 = Math.PI / 2 + cut, span = (TAU - 2 * cut) * e;
    const yTop = scr(0, -o.R * view.tilt * sFar)[1], [lx, ly] = scr(0, o.R * view.tilt * sNear);
    const mine = G.focusSid && A && A.S.orb === o.O, la = mine ? lerp(1, 0.55, f) : bgA;
    const g = ctx.createLinearGradient(0, yTop, 0, ly);
    g.addColorStop(0, col(INK, 0.055 * la)); g.addColorStop(1, col(INK, 0.19 * la));
    ctx.strokeStyle = g;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {   // 同上，project() 和 scr() 展开写
      const th = a0 + span * i / N, Y = o.R * Math.sin(th), s = 1 / (1 - PERSP * Y / view.rout);
      const x = cx0 + o.R * Math.cos(th) * s * zc, y = cy0 + Y * view.tilt * s * zc;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = col(INK, 0.46 * (1 - f) * o.labelA); ctx.fillText(o.title, Math.round(lx), Math.round(ly));
  }
  ctx.letterSpacing = "0px";

  // ---- 对话：远的先画，中间隔一层雾和恒星，近的后画，放大的那个最后画
  const order = [...placed.values()].sort((a, b) => a.wy - b.wy);
  const logoR = Math.min(W, H) * 0.052 * z * lerp(0.55, 1, smooth(0, 1, age / 900));   // 中心那一团（光点落回去时荡开的圈也按它算）
  G.lastDragAngle = G.dragAngle;
  let midDone = false, hoverP: { P: Placed; x: number; y: number; r: number } | null = null;
  const mid = () => {
    drawFog(1, tp, bgA * intro, parx, pary);
    const tl = performance.now();
    for (let k = 0; k < PERF.stress; k++) drawStar(ox, oy, logoR * 0.62 * star.size, bgA * smooth(0, 1, age / 700), ftp, star, view.tilt, G.dragAngle);
    if (PERF.on && age > 2000) { PERF.star.push(performance.now() - tl); if (PERF.star.length > 600) PERF.star.shift(); }
    midDone = true;
  };
  const drawOne = (P: Placed) => {
    const [x, y] = scr(P.wx, P.wy), S = P.S;
    const appear = smooth(0, 1, (tp - S.bornAt) / 520) * P.vis;
    if (appear <= 0) return;
    const hov = G.hoverSid === S.sid, r = P.r * z * (hov ? 1.08 : 1) * lerp(0.55, 1, appear);
    if (hov) hoverP = { P, x, y, r };
    if (x < -r * 3 || x > W + r * 3 || y < -r * 3 || y > H + r * 3) return;
    const a = (hov ? 1 : P.a) * bgA * appear * (S.stale && !hov ? 0.5 : 1);   // 可能已关闭的：暗一半
    drawRing(S, x, y, r, a, 0, null, ftp, bgA * bgA * appear, 0);
    // 在跑的对话带着名字；其余的鼠标指上去才有。名字等环和中间的标志都画完再写，免得远处对话的名字被标志压住
    if (S.labelA > 0.02 && !hov && f < 0.6) names.push({ text: S.label, x: Math.round(x), y: Math.round(y + r * 1.72 + 6), a: 0.56 * a * (1 - f) * S.labelA });
  };
  const names: { text: string; x: number; y: number; a: number }[] = [];
  // 名字会被别的环压住时先隐掉，让开了再出来
  ctx.font = `400 11.5px "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif`;
  const spots = order.map(P => { const [x, y] = scr(P.wx, P.wy); return { P, x, y, r: P.r * z }; });
  for (const a of spots) {
    const S = a.P.S;
    let ok = S.status === "working" || S.status === "waiting";
    if (ok) {
      const hw = Math.min(124, textW(S.label)) / 2 + 4, top = a.y + a.r * 1.72 + 4, bot = top + 16;
      for (const b of spots) {
        if (b === a) continue;
        const dx = Math.max(a.x - hw - b.x, 0, b.x - (a.x + hw)), dy = Math.max(top - b.y, 0, b.y - bot);
        if (dx * dx + dy * dy < (b.r * 1.55) ** 2) { ok = false; break; }
      }
    }
    S.labelA = (S.labelA || 0) + ((ok ? 1 : 0) - (S.labelA || 0)) * eSlow;
  }
  for (const P of order) {
    if (!midDone && P.wy >= 0) mid();
    if (P.S.sid !== cam.sid || f < 0.02) drawOne(P);
  }
  if (!midDone) mid();
  if (names.length) {
    // 压在标志的铜色光上也要看得清：先描一圈背景色的边再写字
    ctx.save();
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.lineJoin = "round"; ctx.lineWidth = 3;
    ctx.font = `400 11.5px "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif`;
    for (const n of names) {
      ctx.strokeStyle = col(BG, 0.75 * n.a / 0.56); ctx.strokeText(n.text, n.x, n.y);
      ctx.fillStyle = col(INK, n.a); ctx.fillText(n.text, n.x, n.y);
    }
    ctx.restore();
  }

  // ---- 光点：发给模型（向内）、模型回了（向外）；到站时荡开一圈
  M.flare *= Math.exp(-dt / 0.45);
  const spotOf = (sid: string) => {
    const P = placed.get(sid);
    if (P) { const [x, y] = scr(P.wx, P.wy); return { x, y, r: P.r * z }; }
    return F.subSpots.get(sid) || null;
  };
  const mineOf = (sid: string) => !!cam.sid && (sid === cam.sid || sid.startsWith(cam.sid + "#"));
  for (let i = M.pulses.length - 1; i >= 0; i--) {
    const p = M.pulses[i], P = spotOf(p.sid);
    // 光速有限：飞行时间和到恒星的距离成正比。最外面一圈约 1 秒，里面的更快
    if (P && p.dur == null) { const rho = sessions.get(p.sid.split("#")[0])?.orb?.rho; p.dur = rho ? Math.max(300, 1050 * rho) : PULSE_MS; }
    const q = (tp - p.t0) / (p.dur ?? PULSE_MS);
    if (q >= 1 || !P) {
      // 到站后过了好一会儿才画到这一帧：页面在后台时不出帧，消息照样进来，切回来那一帧会一起到站。
      // 那些是早就到了的光，不再补荡一圈（不然几十层气体壳一起叠上去，一下亮得刺眼）
      const late = tp - p.t0 - (p.dur ?? PULSE_MS) > 250;
      if (q >= 1 && P && !late) {
        if (p.dir === "in") M.flare = Math.max(M.flare, 0.8);
        // 同一时刻落回恒星的几道光只抛一层壳：壳是用 lighter 叠的，叠几层就亮几倍
        const sid = p.dir === "in" ? null : p.sid;
        if (sid || !M.pings.some(g => !g.sid && tp - g.t0 < 250)) M.pings.push({ sid, t0: tp });
      }
      M.pulses.splice(i, 1); continue;
    }
    const e = q * q * (3 - 2 * q), u = p.dir === "in" ? e : 1 - e;
    const tail = clamp(p.dir === "in" ? u - 0.18 : u + 0.18, 0, 1);
    const cx = P.x, cy = P.y, dl = Math.hypot(ox - cx, oy - cy) || 1, edge = Math.min(dl * 0.5, P.r);
    const rx = cx + (ox - cx) / dl * edge, ry = cy + (oy - cy) / dl * edge;
    const x = lerp(rx, ox, u), y = lerp(ry, oy, u), x2 = lerp(rx, ox, tail), y2 = lerp(ry, oy, tail);
    const a = Math.sin(q * Math.PI) * (mineOf(p.sid) ? 1 : bgA);
    const g = ctx.createLinearGradient(x2, y2, x, y);
    g.addColorStop(0, col(CLAUDE, 0)); g.addColorStop(1, col(CLAUDE, 0.9 * a));
    ctx.strokeStyle = g; ctx.lineWidth = 1.4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x, y); ctx.stroke();
    ctx.fillStyle = col(HOT, a); ctx.beginPath(); ctx.arc(x, y, 2, 0, TAU); ctx.fill();
  }
  for (let i = M.pings.length - 1; i >= 0; i--) {
    const p = M.pings[i], q = (tp - p.t0) / (p.sid ? 900 : SHELL_MS), P = p.sid ? spotOf(p.sid) : null;
    if (q >= 1 || (p.sid && !P)) { M.pings.splice(i, 1); continue; }
    if (p.sid === cam.sid && f > 0.5 && !p.ink) continue;   // 后台任务、子 agent 落回来的那一圈，放大时也要看得到
    const [x, y] = P ? [P.x, P.y] : [ox, oy], r0 = P ? P.r : logoR * 1.5, e = 1 - (1 - q) * (1 - q);
    if (!P) { starShell(x, y, logoR * 0.62 * star.size, logoR * 2.5, q, bgA); continue; }
    ctx.lineWidth = 1.2; ctx.strokeStyle = col(p.ink ? INK : CLAUDE, (p.ink ? 0.7 : 0.6) * (1 - q) * (p.sid && mineOf(p.sid) ? 1 : bgA));
    ctx.beginPath(); ctx.arc(x, y, r0 * (1 + 0.55 * e), 0, TAU); ctx.stroke();
  }

  if (A && f >= 0.02) {
    const r = A.r * z, lod = smooth(heroR * 0.3, heroR * 0.85, r);
    drawRing(A.S, cam.sx, cam.sy, r, lerp(A.a, 1, f), lod, G.hoverStep, ftp, 1, smooth(heroR * 0.22, heroR * 0.92, r));
    // 表盘顶上：这一轮在问什么；回合结束以后，底下：回答的最后一句（都来自附件，没有就不写）
    const S = A.S, ta = lod * f;
    if (ta > 0.02 && (S.ask || S.ans)) {
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      // 宽度取到 8px 的整数倍：镜头飞行时 r 每帧都变，不取整的话 fit 的缓存每帧都对不上
      const maxW = Math.floor(Math.min(W * 0.5, r * 3.2) / 8) * 8;
      if (S.ask) {
        ctx.font = `400 ${Math.round(clamp(r * 0.075, 13, 17))}px ${FONT}`;
        ctx.fillStyle = col(INK, 0.78 * ta); ctx.fillText(fit("“" + S.ask + "”", maxW), cam.sx, cam.sy - r * 1.32 - 10);
      }
      if (S.ans && isEnded(S)) {
        ctx.font = `400 ${Math.round(clamp(r * 0.065, 12, 15))}px ${FONT}`;
        ctx.fillStyle = col(INK, 0.5 * ta); ctx.fillText(fit(S.ans, maxW), cam.sx, cam.sy + r * 1.32 + 12);
      }
    }
  }
  ctx.restore();

  // ---- 文字层
  const hp = hoverP as { P: Placed; x: number; y: number; r: number } | null;
  updateCard(hp && hp.P, hp ? hp.x : 0, hp ? hp.y : 0, hp ? hp.r : 0, now(), alpha);
  const S = G.focusSid ? sessions.get(G.focusSid) : null;
  const gname = M.galaxyId ? M.name : "";
  const ended = !!S && isEnded(S);
  const key = S ? [S.sid, S.label, S.project, S.ctxTok, S.outTok, wordOf(S), gname, S.ask, S.ans, !!S.askAtt?.f, !!S.ansAtt?.f, ended, S.model].join("|")
                : `m|${gname}|${M.groups.length}|${liveN}|${working}|${connLost}`;
  if (key !== hudKey) {
    hudKey = key;
    if (S) {
      $("f-proj").textContent = S.project; $("f-title").textContent = S.label;
      $("f-ctx").textContent = S.ctxTok ? S.ctxTok.toLocaleString("en-US") : "—";
      $("f-out").textContent = S.outTok ? S.outTok.toLocaleString("en-US") : "—";
      $("f-galaxy").textContent = gname; $("f-state").textContent = wordOf(S);
      $("f-ask").textContent = S.ask; setStyle("f-ask-row", "display", S.ask ? "" : "none");
      $("f-ans").textContent = S.ans; setStyle("f-ans-row", "display", S.ans && ended ? "" : "none");
      // 服务器上有整句话、完整回答时才加下划线、才能点
      $("f-ask").classList.toggle("link", !!S.askAtt?.f); $("f-ans").classList.toggle("link", !!S.ansAtt?.f);
      $("f-model").textContent = S.model || ""; setStyle("f-model-row", "display", S.model ? "" : "none");
    } else {
      setText("caption", !gname ? "" : liveN
        ? T.galaxyCaption(gname, M.groups.length, liveN, working)
        : connLost ? gname : T.galaxyQuiet(gname));
    }
  }
  setStyle("focus", "opacity", (smooth(0.55, 1, f) * alpha * (1 - G.detailK)).toFixed(3));
  setStyle("focus", "transform", `translateY(-50%) translateX(${((1 - smooth(0.4, 1, f)) * -18).toFixed(1)}px)`);
  setText("hint", G.focusSid ? T.hintFocus : zoomed() ? T.hintZoomed : T.hintGalaxy);
  setStyle("hint", "opacity", ((G.focusSid ? smooth(0.55, 1, f) : 0.75 * (1 - smooth(0, 0.5, f)) * intro) * alpha).toFixed(3));
  setStyle("caption", "opacity", ((1 - smooth(0, 0.5, f)) * intro * alpha).toFixed(3));
}

/** 断开时整幅画面压暗 */
export function dim(offK: number) {
  if (offK > 0.005) { ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0); ctx.fillStyle = `rgba(11,12,14,${(0.6 * offK).toFixed(3)})`; ctx.fillRect(0, 0, V.W, V.H); }
}

export { layout };
