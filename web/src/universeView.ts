// 星系群视图（原来的宇宙视图）：每个星系是一小团光。只用概要层的数据（编号、项目数、每个会话的状态字母、名片）。
// 两种布局（物理依据见 docs/physics.md）：
//   星系群（50 个以内，平常的情形）：几个星系绕着共同的质心转，中间一层很淡的群内热气体的光。
//   宇宙网（星系很多时，比如 ?demo&n=2000）：下面这段说的纤维和空洞。
//   亮度：在跑的会话越多越亮；在想、在动手的带一层珊瑚色的光，并且会闪；等你的荡一圈白色的波纹；
//   只剩待命的是一团暗灰；可能已关闭的更暗。团的大小随会话数变大。
// 星系的位置由编号决定（同一个编号永远在同一个地方），按「宇宙网」分布：聚在团里、排在团与团之间的纤维上，中间是大片空洞。
// 各个设定的物理依据见 docs/physics.md。
// 拖动平移，滚轮缩放；鼠标指着出卡片，点一下飞进那个星系。
import { STATUS_CODE, galaxyName, type SummaryRow, type WAtt } from "@agent-loop/shared/browser";
import { ATT, detailOf } from "./attach.ts";
import { ctx, fit, grain, textW, V } from "./canvas.ts";
import { FLOATS, createBlobGl } from "./universeGl.ts";
import { $, CLAUDE, ERR, FONT, INK, TAU, clamp, col, frac, hashUnit, lerp, params, setStyle, setText, smooth } from "./util.ts";
import { T } from "./i18n.ts";
import { conn } from "./net.ts";

export interface GalaxyRow {
  id: string; name: string; projects: number; codes: string;   // name：名片里的名字，没有就是由编号生成的星表编号
  card?: WAtt;
  n: number; think: number; act: number; bg: number; wait: number; err: number; done: number; idle: number; stale: number;
  // 由编号决定的外观
  ux: number; uy: number; rot: number; flat: number; ph: number; tw: number;
  shown: number; bornAt: number; goneAt: number | null; heat: number;
  errAt: number | null;   // 出错的那一刻：红点按超新星的光变曲线先亮后暗
  web: { i: number; w: number }[];   // 落在哪几个星系团里、各占多少分量（位置不变，建行时算一次）
  // 星系群布局里的轨道：半径（单位圆里）、起始角；以及这一帧在世界坐标里的位置（两种布局按 U.gk 混合）
  orbR: number; orbA: number; wx: number; wy: number;
}

export const U = {
  rows: new Map<string, GalaxyRow>(),
  cam: { x: 0, y: 0, lz: 0, ready: false, tlz: 0, tx: 0, ty: 0 },
  R: 0, Rt: 0,          // 宇宙的世界半径（平滑地跟着星系数变）
  gk: 1,                // 1：星系群布局；0：宇宙网布局。星系数跨过界限时平滑地过渡
  GR: 0,                // 星系群的世界半径
  hover: null as string | null,
  mine: null as string | null,   // 你的星系（/galaxy 给的网址打开过一次就记住）：标出来
  fly: null as null | { id: string; t0: number; x0: number; y0: number; lz0: number; lz1: number },   // 镜头飞向某个星系
  ping: null as null | { id: string; t0: number },   // 定位到之后的特效：密度波
  drag: { on: false, moved: 0, x: 0, y: 0 },
  mouse: { x: -1e4, y: -1e4, inside: false },
};

const C = STATUS_CODE;

function count(codes: string) {
  const c = { think: 0, act: 0, bg: 0, wait: 0, err: 0, done: 0, idle: 0, stale: 0 };
  for (const ch of codes) {
    if (ch === C.think) c.think++; else if (ch === C.act) c.act++; else if (ch === C.bg) c.bg++;
    else if (ch === C.waiting) c.wait++; else if (ch === C.error) c.err++; else if (ch === C.done) c.done++;
    else if (ch === C.stale) c.stale++; else c.idle++;
  }
  return c;
}

// ---- 宇宙网：一副固定的骨架（星系团 + 连着团的纤维），每个星系按编号落在骨架上的某处。
// 真实的宇宙里星系不是均匀撒开的：大约一半在纤维上，一部分聚成星系团，空洞里只有零星几个。
// 骨架用固定的种子生成，和有多少星系、谁先来无关，所以同一个编号永远在同一个地方。
interface WebNode { x: number; y: number; rich: number; sig: number }
export const WEB = (() => {
  const nodes: WebNode[] = [];
  for (let i = 0; nodes.length < 13 && i < 400; i++) {
    const rad = 0.9 * Math.sqrt(hashUnit("web" + i, 1)), th = hashUnit("web" + i, 2) * TAU;
    const x = Math.cos(th) * rad, y = Math.sin(th) * rad;
    if (nodes.every(n => Math.hypot(n.x - x, n.y - y) > 0.34)) { const rich = 0.3 + hashUnit("web" + i, 3) * 0.7; nodes.push({ x, y, rich, sig: 0.035 + 0.035 * rich }); }
  }
  // 每个团连到离它最近的两个团，太长的不连
  const edges: [WebNode, WebNode, number][] = [];
  for (const a of nodes) {
    const near = nodes.filter(b => b !== a).sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y)).slice(0, 2);
    for (const b of near) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.8 && !edges.some(([p, q]) => (p === a && q === b) || (p === b && q === a))) edges.push([a, b, len]);
    }
  }
  const richSum = nodes.reduce((t, n) => t + n.rich, 0), lenSum = edges.reduce((t, e) => t + e[2], 0);
  return { nodes, edges, richSum, lenSum };
})();

/** 两个均匀随机数 → 一对标准正态分布的数（Box–Muller） */
function gauss(u1: number, u2: number): [number, number] {
  const m = Math.sqrt(-2 * Math.log(Math.max(1e-6, u1)));
  return [m * Math.cos(TAU * u2), m * Math.sin(TAU * u2)];
}

/** 按权重挑一个：u 是 0～1 的随机数，sum 是权重之和 */
function pickW<T>(arr: T[], w: (x: T) => number, sum: number, u: number): T {
  let acc = u * sum, pick = arr[0];
  for (const c of arr) { pick = c; if ((acc -= w(c)) <= 0) break; }
  return pick;
}

/** 一个编号在宇宙里的位置（单位圆盘里的坐标，乘上宇宙半径就是世界坐标） */
export function webPos(id: string): [number, number] {
  const kind = hashUnit(id, 11), pick = hashUnit(id, 12);
  const [g1, g2] = gauss(hashUnit(id, 13), hashUnit(id, 14));
  if (kind < 0.38) {   // 星系团：越「富」的团分到的星系越多，也铺得越开
    const n = pickW(WEB.nodes, c => c.rich, WEB.richSum, pick);
    return [n.x + g1 * n.sig, n.y + g2 * n.sig];
  }
  if (kind < 0.9) {    // 纤维：按长度挑一条，落在上面某处，两侧有一点散布
    const [a, b, len] = pickW(WEB.edges, c => c[2], WEB.lenSum, pick), t = hashUnit(id, 15), nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len, off = g1 * 0.022;
    return [a.x + (b.x - a.x) * t + nx * off, a.y + (b.y - a.y) * t + ny * off];
  }
  const rad = 0.95 * Math.sqrt(pick), th = hashUnit(id, 15) * TAU;   // 零星散落在空洞里的
  return [Math.cos(th) * rad, Math.sin(th) * rad];
}

const nameOf = (id: string, card: WAtt | undefined) => detailOf(card, "card", id)?.me || galaxyName(id);
let namesVer = -1;

export function setRow([id, projects, codes, card]: SummaryRow) {
  let r = U.rows.get(id);
  if (!r) {
    const [ux, uy] = webPos(id);
    // 团内光按团里有几个星系来定亮度：每个星系对附近的团贡献一个高斯分量，3σ 以外不算
    const web: GalaxyRow["web"] = [];
    WEB.nodes.forEach((n, i) => { const d2 = (ux - n.x) ** 2 + (uy - n.y) ** 2; if (d2 < 9 * n.sig * n.sig) web.push({ i, w: Math.exp(-d2 / (2 * n.sig * n.sig)) }); });
    r = { id, name: galaxyName(id), projects, codes, n: 0, think: 0, act: 0, bg: 0, wait: 0, err: 0, done: 0, idle: 0, stale: 0,
          ux, uy, rot: hashUnit(id, 16) * Math.PI,
          flat: 0.35 + hashUnit(id, 17) * 0.45, ph: hashUnit(id, 18) * TAU, tw: 0.6 + hashUnit(id, 19) * 1.2,
          shown: 0, bornAt: performance.now(), goneAt: null, heat: 0, errAt: -1e9, web,
          orbR: 0.3 + 0.7 * Math.sqrt(hashUnit(id, 21)), orbA: hashUnit(id, 22) * TAU, wx: 0, wy: 0 };
    placeRow(r, performance.now());
    U.rows.set(id, r);
  }
  r.goneAt = null;
  r.projects = projects; r.codes = codes;
  if (card !== undefined || r.card !== undefined) { r.card = card; r.name = nameOf(id, card); }
  Object.assign(r, count(codes));
  // 新出错：记下这一刻，红点先爆亮再暗下去。刚打开页面时就已经在错的，直接画成暗下去之后的样子（新建的行 errAt 从 -1e9 开始）
  if (!r.err) r.errAt = null;
  else r.errAt ??= performance.now();
  r.n = codes.length;
}

export function dropRow(id: string) {
  const r = U.rows.get(id);
  if (r && r.goneAt == null) r.goneAt = performance.now();
}

export function applySummary(rows: SummaryRow[], gone: string[], full: boolean) {
  if (full) { const ids = new Set(rows.map(r => r[0])); for (const id of U.rows.keys()) if (!ids.has(id)) dropRow(id); }
  for (const r of rows) setRow(r);
  for (const id of gone) dropRow(id);
}

// ---- 预先画好的径向渐变贴图：stops 是 [位置, 不透明度]，画的时候按亮度缩放、旋转、压扁
function radial(rgb: string, stops: [number, number][], size = 128) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const h = size / 2, g = c.getContext("2d")!, gr = g.createRadialGradient(h, h, 0, h, h, h);
  for (const [at, a] of stops) gr.addColorStop(at, `rgba(${rgb},${a})`);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return c;
}
/** 光团：一张中性的、一张珊瑚色的 */
const sprite = (rgb: string, core: number) => radial(rgb, [[0, 1], [core, 0.55], [0.45, 0.16], [1, 0]]);
/** WebGL 画光团（默认）；?ugl=0 或 WebGL 不可用时用 2D 贴图 */
const blobGl = params.get("ugl") === "0" ? null : createBlobGl();
let glData = new Float32Array(1024 * FLOATS);
const SPR_INK = sprite("214,220,232", 0.1), SPR_CLAUDE = sprite(CLAUDE, 0.08), SPR_CORE = sprite("255,240,230", 0.04);
/** 星系团的团内光：中心最亮、线性淡到边上 */
const SPR_ICL = radial("186,196,216", [[0, 1], [1, 0]]);

// ---- 背景：更远处的星系（深空场）。按距离分三层：越远越多、越小、越暗、越红（红移）；最近一层里有些能看出椭圆的形状。
// 它们在天上不是均匀撒开的，也成团（背景里也有宇宙网），所以一大半落在随机的小团里。
// 会动的只有真实会发生的：视差漂移（我们自己在动，越近的层漂得越快）、引力微透镜（前面有天体经过时背景的点对称地亮一下再暗回去）、
// 遥远的超新星（某个背景星系里突然多出一个点，快升慢降，越来越红）。不闪烁：闪烁是地球大气造成的。
const LAYERS = [
  { n: 1400, deep: 0.25, drift: 1.4, s0: 0.6, s1: 1.2, a0: 0.08, a1: 0.32, fill: "rgb(238,214,198)" },   // 最远
  { n: 440, deep: 0.5, drift: 2.8, s0: 0.8, s1: 1.6, a0: 0.16, a1: 0.5, fill: "rgb(236,226,218)" },
  { n: 95, deep: 0.9, drift: 5.5, s0: 1.0, s1: 2.0, a0: 0.3, a1: 0.7, fill: "rgb(222,228,242)" },        // 最近
];
/** 点按层连续存放：第 li 层是 bgPts[LSTART[li] .. LSTART[li + 1]) */
const LSTART = LAYERS.reduce((a, L) => (a.push(a[a.length - 1] + L.n), a), [0]);
const DRIFT = [-Math.cos(0.36), -Math.sin(0.36)];   // 漂移方向（屏幕像素/秒，再乘每层的速度）
interface BgPt { x: number; y: number; s: number; a: number; L: number; fz: number; cr: number; sr: number; flat: number }
const bgPts: BgPt[] = [];
{
  const clumps = Array.from({ length: 34 }, (_, i) => [hashUnit("bc" + i, 1), hashUnit("bc" + i, 2), 0.015 + 0.045 * hashUnit("bc" + i, 3)]);
  let k = 0;
  LAYERS.forEach((L, li) => {
    for (let i = 0; i < L.n; i++, k++) {
      const h = (j: number) => hashUnit("bg" + k, j);
      let x = h(1), y = h(2);
      if (h(3) < 0.6) {   // 落进某个小团
        const c = clumps[Math.floor(h(4) * clumps.length)], [g1, g2] = gauss(h(5), h(6));
        x = frac(c[0] + g1 * c[2]); y = frac(c[1] + g2 * c[2]);
      }
      const b = Math.pow(h(7), 1.7), rot = h(10) * Math.PI;   // 暗的多、亮的少
      bgPts.push({ x, y, s: L.s0 + (L.s1 - L.s0) * b, a: L.a0 + (L.a1 - L.a0) * b, L: li,
        fz: li === 2 && h(8) < 0.5 ? 3.5 + 5 * h(9) : 0, cr: Math.cos(rot), sr: Math.sin(rot), flat: 0.3 + 0.6 * h(11) });
    }
  });
}
/** 一个柔和的白色光斑贴图：画背景里能看出形状的星系、微透镜亮起来时的光晕 */
const SPR_FUZZ = radial("255,255,255", [[0, 1], [0.3, 0.4], [1, 0]], 32);
// 正在发生的微透镜和超新星。随机出现，不需要每个人看到的一样
const lensEv: { i: number; t0: number; tE: number; u0: number; a3: number }[] = [];   // a3：±3 个爱因斯坦时间处的放大倍数，用来归一
const snEv: { i: number; t0: number; dx: number; dy: number; peak: number }[] = [];
let nextLens = 0, nextSn = 0;
const bgMag = new Float32Array(bgPts.length).fill(1);
/** 在第 l0～l1 层里随机挑一个点 */
const pickBg = (l0: number, l1: number) => LSTART[l0] + Math.floor(Math.random() * (LSTART[l1 + 1] - LSTART[l0]));
/** 微透镜的放大倍数（Paczyński 曲线）：u 是前景天体和背景点在天上的距离（以爱因斯坦半径为单位） */
const lensA = (u: number) => (u * u + 2) / (u * Math.sqrt(u * u + 4));

export const SPACING = 6;   // 世界坐标里星系之间大致的间距
/** 星系数在这个以内用星系群布局，超过 GROUP_MAX + 10 换成宇宙网（中间留一段，免得在边界上来回跳） */
export const GROUP_MAX = 50;
/** 星系群的轨道面斜着看：竖直方向压扁成这么多 */
const GROUP_TILT = 0.62;
/** 星系群布局里最外面一圈转一周要多久（秒）。真实的是几十亿年 */
const GROUP_PERIOD_S = 900;

/**
 * 一个星系这一帧在世界坐标里的位置。星系群布局：绕质心的圆轨道。群里的质量大多在暗物质晕里，
 * 晕的转动曲线是平的（各处的环绕速度差不多），所以角速度和半径成反比：里面的转得快。
 */
function placeRow(r: GalaxyRow, tp: number) {
  const gx = r.ux * U.R, gy = r.uy * U.R;
  if (U.gk <= 0.001) { r.wx = gx; r.wy = gy; return; }
  const th = r.orbA + (REDUCED ? 0 : tp / 1000) * TAU / GROUP_PERIOD_S / r.orbR;
  const ox = Math.cos(th) * r.orbR * U.GR, oy = Math.sin(th) * r.orbR * U.GR * GROUP_TILT;
  r.wx = lerp(gx, ox, U.gk); r.wy = lerp(gy, oy, U.gk);
}

/** 世界坐标 → 屏幕 */
export function uscr(wx: number, wy: number, boost?: { x: number; y: number; k: number }) {
  const z = Math.exp(U.cam.lz);
  let x = V.W / 2 + (wx - U.cam.x) * z, y = V.H / 2 + (wy - U.cam.y) * z;
  if (boost) { x = boost.x + (x - boost.x) * boost.k; y = boost.y + (y - boost.y) * boost.k; }
  return [x, y];
}
export const worldOf = (r: GalaxyRow): [number, number] => [r.wx, r.wy];
// 世界坐标里的半径。星系群里星系之间相对更近（本星系群里银河系和仙女座只隔二十几个银河系的直径），画大一些
export const blobR = (r: GalaxyRow) => (0.55 + 0.32 * Math.log2(1 + r.n)) * lerp(1, 1.7, U.gk);

let groupLayout = true;
export function fitCam(instant: boolean) {
  let n = 0;
  for (const r of U.rows.values()) if (r.goneAt == null) n++;
  U.Rt = Math.sqrt(Math.max(n, 12)) * SPACING * 0.62;
  if (instant || !U.R) U.R = U.Rt;
  if (n > GROUP_MAX + 10) groupLayout = false; else if (n <= GROUP_MAX) groupLayout = true;
  U.GR = SPACING * (1.1 + 0.55 * Math.sqrt(Math.max(1, n)));
  if (instant) U.gk = groupLayout ? 1 : 0;
  // 星系群布局：整个群占屏幕的大半；宇宙网：照旧
  const want = groupLayout ? Math.log(Math.min(V.W, V.H * 1.3) * 0.36 / U.GR) : Math.log(Math.min(V.W, V.H) * 0.46 / Math.max(U.Rt, 1));
  U.cam.tlz = clamp(want, Math.log(0.25), Math.log(18));
  if (instant || !U.cam.ready) { U.cam.lz = U.cam.tlz; U.cam.x = U.cam.y = 0; U.cam.ready = true; }
}

let userZoomed = false;
export function userMovedCamera() { userZoomed = true; stopFly(); }
/** 半路停下镜头飞行（用户自己动了镜头，或者点进了别的星系） */
export function stopFly() { if (U.fly) { U.fly = null; flyHooks.cancel(); } }

/** 「我的星系」按钮跟着镜头走：到了（波发出去）、半路被打断 */
export const flyHooks = { arrive: () => {}, cancel: () => {} };

const FLY_MS = 1400, WAVE_MS = 2700;
const REDUCED = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 镜头飞到某个星系，到了以后放一圈特效。星系不在宇宙里（现在没有对话）时返回 false */
export function locate(id: string): boolean {
  const r = U.rows.get(id);
  if (!r || r.goneAt != null) return false;
  userMovedCamera();
  // 停下来时这团光在屏幕上大约 28px 半径，但不比现在离得更远
  const lz1 = clamp(Math.max(U.cam.lz, Math.log(28 / blobR(r))), Math.log(0.05), Math.log(40));
  // 已经在跟前了：不用再飞，直接从「快到了」那一刻开始，马上放特效
  const [tx, ty] = worldOf(r), near = Math.hypot(tx - U.cam.x, ty - U.cam.y) * Math.exp(U.cam.lz) < 4 && Math.abs(lz1 - U.cam.lz) < 0.05;
  U.fly = { id, t0: performance.now() - (near ? FLY_MS * 0.85 : 0), x0: U.cam.x, y0: U.cam.y, lz0: U.cam.lz, lz1 };
  U.ping = null;
  return true;
}

function stepFly(tp: number) {
  const f = U.fly;
  if (!f) return;
  const r = U.rows.get(f.id);
  if (!r) { stopFly(); return; }
  const p = clamp((tp - f.t0) / FLY_MS, 0, 1), e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  const [tx, ty] = worldOf(r);
  // 先往后退一点看清全局，再扎下去：远的时候退得多
  const dist = Math.hypot(tx - f.x0, ty - f.y0) * Math.exp(f.lz0) / Math.max(V.W, V.H);
  const hop = clamp(dist, 0, 1.2) * Math.sin(Math.PI * p);
  U.cam.x = lerp(f.x0, tx, e); U.cam.y = lerp(f.y0, ty, e);
  U.cam.lz = lerp(f.lz0, f.lz1, e) - hop;
  if (p > 0.85 && !U.ping) { U.ping = { id: f.id, t0: tp }; flyHooks.arrive(); }
  if (p >= 1) U.fly = null;
}

/**
 * 定位特效：密度波。一圈波从你的星系推出去，波峰扫过的星系被往外推、同时暗下去，波过去后慢慢亮回来；离得越远越弱。
 * 依据：重子声学振荡（BAO，从密度高的地方推出去的纵波），加上萨克斯-沃尔夫效应（波峰处物质堆积、势阱更深，
 * 光爬出来损失能量，看起来更暗）。时间压缩成两三秒，幅度放大到看得见。
 */
interface Wave { id: string; x: number; y: number; rad: number; t: number; v: number; amp: number; span: number }
function waveAt(tp: number, z: number, bst: unknown): Wave | null {
  const P = U.ping;
  if (!P) return null;
  const r = U.rows.get(P.id), t = tp - P.t0;
  if (!r || t >= WAVE_MS) { U.ping = null; return null; }
  if (bst) return null;
  const [x, y] = uscr(...worldOf(r)), span = Math.max(V.W, V.H);
  return { id: P.id, x, y, rad: blobR(r) * z, t, v: span * 0.6 / 1000, amp: REDUCED ? 0 : 14 * (1 - smooth(900, 1800, t)), span };
}
/** waveApply 的结果写在这里：每帧要算上千次，不每次新建数组 */
const WV = { x: 0, y: 0, k: 1 };
/**
 * 波作用在屏幕上 (x, y) 处：沿径向推开（gain 倍），推开以后的位置暗下去多少（k，最暗 0.25）——波峰扫到时变暗，过去后慢慢亮回来。
 * 推开是沿径向的，所以推开后到波源的距离就是 d + 推开的量，不用再算一次。
 */
function waveApply(w: Wave, x: number, y: number, gain: number) {
  const dx = x - w.x, dy = y - w.y, d = Math.hypot(dx, dy) || 1, u = (d - w.t * w.v) / 60;
  const s = w.amp && u > -3 && u < 3
    ? gain * w.amp * Math.exp(-u * u) * Math.cos(2.2 * u) / (1 + d / (0.5 * w.span)) * smooth(w.rad * 1.2, w.rad * 3, d) : 0;
  WV.x = x + dx / d * s; WV.y = y + dy / d * s; WV.k = 1;
  const d1 = Math.abs(d + s), since = w.t - d1 / w.v;
  if (since > -50 && since < 1300)
    WV.k = 1 - 0.75 * smooth(-50, 120, since) * (1 - smooth(450, 1300, since)) / (1 + d1 / w.span) * smooth(w.rad * 1.2, w.rad * 3, d1);
}

/** 背景的深空场：三层远处的星系，加上正在发生的微透镜和超新星 */
function drawDeepField(tp: number, z: number, wv: Wave | null, alpha: number) {
  const { W, H, dpr } = V, sw = W * 1.4, sh = H * 1.4, ts = REDUCED ? 0 : tp / 1000;
  // 同一层的点平移一样多（视差 + 漂移），每层的偏移每帧算一次。位置绕回到 [0, sw) 以后再往左上挪 0.2 屏
  const offX = LAYERS.map(L => -U.cam.x * z * L.deep * 0.05 + DRIFT[0] * L.drift * ts);
  const offY = LAYERS.map(L => -U.cam.y * z * L.deep * 0.05 + DRIFT[1] * L.drift * ts);
  const posX = (p: BgPt) => frac((p.x * sw + offX[p.L]) / sw) * sw - W * 0.2;
  const posY = (p: BgPt) => frac((p.y * sh + offY[p.L]) / sh) * sh - H * 0.2;

  // 新的事件：微透镜大约每一两秒一个（落在远的两层），超新星大约每七八秒一个（落在近的两层，发生在某个背景星系里）
  if (!REDUCED) {
    if (tp > nextLens) {
      const u0 = 0.12 + Math.random() * 0.45;
      lensEv.push({ i: pickBg(0, 1), t0: tp, tE: 700 + Math.random() * 900, u0, a3: lensA(Math.hypot(u0, 3)) });
      nextLens = tp + 700 + Math.random() * 1800;
    }
    if (tp > nextSn) {
      if (nextSn) { const i = pickBg(1, 2), f = bgPts[i].fz || 1.5;
        snEv.push({ i, t0: tp, dx: (Math.random() - 0.5) * f, dy: (Math.random() - 0.5) * f, peak: 0.45 + Math.random() * 0.45 }); }
      nextSn = tp + 5000 + Math.random() * 6000;
    }
  }
  // 微透镜：前景天体从背景点前面掠过，放大倍数先升后降、前后对称。持续 ±3 个爱因斯坦时间
  for (let j = lensEv.length - 1; j >= 0; j--) {
    const e = lensEv[j], tau = (tp - e.t0) / e.tE - 3;
    if (tau > 3) { bgMag[e.i] = 1; lensEv.splice(j, 1); continue; }
    bgMag[e.i] = lensA(Math.hypot(e.u0, tau)) / e.a3;
  }

  // 点是按层存的：每层只设一次颜色
  for (let li = 0; li < LAYERS.length; li++) {
    ctx.fillStyle = LAYERS[li].fill;
    for (let i = LSTART[li]; i < LSTART[li + 1]; i++) {
      const p = bgPts[i];
      let x = posX(p), y = posY(p), k = 1;
      if (x < -8 || x > W + 8 || y < -8 || y > H + 8) continue;
      if (wv) { waveApply(wv, x, y, 1.4); x = WV.x; y = WV.y; k = WV.k; }
      const mag = bgMag[i];
      if (p.fz) {   // 能看出形状的：一个压扁、带转角的光斑。直接设矩阵（转、压扁、挪过去），不 save/restore
        ctx.setTransform(dpr * p.cr, dpr * p.sr, -dpr * p.sr * p.flat, dpr * p.cr * p.flat, dpr * x, dpr * y);
        ctx.globalAlpha = alpha * p.a * 0.75 * k; ctx.drawImage(SPR_FUZZ, -p.fz, -p.fz, 2 * p.fz, 2 * p.fz);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      if (mag > 1.25) {   // 被透镜放大：亮起来，周围带一点光晕
        const r = 1.5 + 1.6 * Math.log2(mag);
        ctx.globalAlpha = alpha * Math.min(1, p.a * (mag - 1) * 0.5) * k; ctx.drawImage(SPR_FUZZ, x + p.s / 2 - r, y + p.s / 2 - r, 2 * r, 2 * r);
      }
      ctx.globalAlpha = alpha * Math.min(0.95, p.a * mag) * k;
      ctx.fillRect(x, y, p.s, p.s);
    }
  }

  // 超新星：0.35 秒升到最亮，然后按指数慢慢暗下去；颜色从蓝白慢慢变红（爆发后的物质在冷却）
  for (let j = snEv.length - 1; j >= 0; j--) {
    const e = snEv[j], t = tp - e.t0;
    if (t > 9000) { snEv.splice(j, 1); continue; }
    const lum = (t < 350 ? t / 350 : Math.exp(-(t - 350) / 2200)) * e.peak, p = bgPts[e.i];
    let x = posX(p) + e.dx + p.s / 2, y = posY(p) + e.dy + p.s / 2, k = 1;
    if (wv) { waveApply(wv, x, y, 1.4); x = WV.x; y = WV.y; k = WV.k; }
    const c = smooth(0, 6000, t), rgb = `${Math.round(lerp(225, 255, c))},${Math.round(lerp(232, 196, c))},${Math.round(lerp(255, 170, c))}`;
    const R = 3 + 6 * lum;
    const g = ctx.createRadialGradient(x, y, 0, x, y, R);
    g.addColorStop(0, col(rgb, 0.5 * lum * k)); g.addColorStop(1, col(rgb, 0));
    ctx.globalAlpha = alpha; ctx.fillStyle = g; ctx.fillRect(x - R, y - R, 2 * R, 2 * R);
    ctx.fillStyle = col(rgb, Math.min(1, 0.4 + lum) * lum * k); ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
  }
  ctx.globalAlpha = alpha;
}

/** 一个星系的活跃程度（0～1），亮度和闪动跟着它 */
const clMass = new Float32Array(WEB.nodes.length);   // 每个星系团里有多少星系（按高斯分量加权）：团内光的亮度跟着它
const activity = (r: GalaxyRow) => r.n ? clamp((r.think + r.act + r.wait * 0.8 + r.bg * 0.4) / Math.max(2, r.n) * 1.4, 0, 1) : 0;

export function universeFrame(tp: number, dt: number, alpha: number, boost: { id: string; k: number } | null, run: number) {
  const { W, H } = V;
  if (namesVer !== ATT.cardVer) { namesVer = ATT.cardVer; for (const r of U.rows.values()) if (r.card) r.name = nameOf(r.id, r.card); }
  const e = 1 - Math.exp(-dt / 0.25);
  U.R += (U.Rt - U.R) * e;
  U.gk += ((groupLayout ? 1 : 0) - U.gk) * (1 - Math.exp(-dt / 0.8));
  for (const r of U.rows.values()) placeRow(r, tp);
  if (!userZoomed) U.cam.lz += (U.cam.tlz - U.cam.lz) * e;
  stepFly(tp);
  const z = Math.exp(U.cam.lz);
  let bst: { x: number; y: number; k: number } | undefined;
  if (boost) {
    const r = U.rows.get(boost.id);
    if (r) { const [wx, wy] = worldOf(r); const [x, y] = uscr(wx, wy); bst = { x, y, k: boost.k }; }
  }

  const wv = waveAt(tp, z, bst);

  ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#0B0C0E"; ctx.fillRect(0, 0, W, H);
  // 星系团中间一层极淡的冷光：团内光（被潮汐从成员星系里剥出来的恒星）和热气体。宇宙本身没有中心，所以不再有居中的暖光。
  // 这层光来自团里的星系，所以按团里实际有几个星系来定亮度：没有成员的空位置不发光，八九个成员时接近最亮
  // 每个团的分量（clMass）是上一帧画星系时顺手加起来的，差一帧看不出来
  const Rs = U.R * z * (bst ? bst.k : 1);
  WEB.nodes.forEach((n, i) => {
    const k = (1 - Math.exp(-clMass[i] / 4)) * (1 - U.gk);
    if (k < 0.02) return;
    const [x, y] = uscr(n.x * U.R, n.y * U.R, bst), R = Math.max(30, (0.07 + 0.08 * n.rich) * Rs);
    if (x < -R || x > W + R || y < -R || y > H + R) return;
    ctx.globalAlpha = alpha * (0.022 + 0.03 * n.rich) * k; ctx.drawImage(SPR_ICL, x - R, y - R, 2 * R, 2 * R);
  });
  // 星系群：群内的热气体（X 射线波段很亮，可见光里极淡），中心在质心、越往外越淡，亮度跟着群里有几个星系
  if (U.gk > 0.01) {
    let n = 0;
    for (const r of U.rows.values()) n += r.shown;
    const [cx, cy] = uscr(0, 0, bst), R = U.GR * 1.5 * z * (bst ? bst.k : 1);
    const a = alpha * U.gk * 0.05 * (1 - Math.exp(-n / 3));
    if (a > 0.003) { ctx.save(); ctx.translate(cx, cy); ctx.scale(1, GROUP_TILT); ctx.globalAlpha = a; ctx.drawImage(SPR_ICL, -R, -R, 2 * R, 2 * R); ctx.restore(); }
  }
  ctx.globalAlpha = alpha;
  clMass.fill(0);
  ctx.fillStyle = grain; ctx.fillRect(0, 0, W, H);
  drawDeepField(tp, z, wv, alpha);

  // ---- 星系
  const m = U.mouse;
  let best = 1e9;
  U.hover = null;
  const labels: { x: number; y: number; r: number; row: GalaxyRow; a: number; pri: number }[] = [];
  const gl = blobGl && blobGl.ok ? blobGl : null;
  if (gl && glData.length < U.rows.size * FLOATS) glData = new Float32Array(Math.max(1024, U.rows.size * 2) * FLOATS);
  let nGl = 0;
  const overlays: GalaxyRow[] = [], ox: number[] = [], oy: number[] = [], orad: number[] = [];
  const fade = 1 - Math.exp(-dt / 0.5), heatE = 1 - Math.exp(-dt / 0.8), z1 = z * (bst ? bst.k : 1);
  let liveN = 0, liveS = 0, liveB = 0;   // 底部的总数：星系、会话、在忙的会话。顺手数，不另外遍历
  for (const r of U.rows.values()) {
    // 出现、消失：慢慢亮起、慢慢熄灭
    r.shown += ((r.goneAt == null ? 1 : 0) - r.shown) * fade;
    if (r.goneAt != null && r.shown < 0.01) { U.rows.delete(r.id); continue; }
    if (r.goneAt == null) { liveN++; liveS += r.n; liveB += r.think + r.act; }
    for (const c of r.web) clMass[c.i] += r.shown * c.w;
    r.heat += (activity(r) - r.heat) * heatE;
    let x = W / 2 + (r.wx - U.cam.x) * z, y = H / 2 + (r.wy - U.cam.y) * z;
    if (bst) { x = bst.x + (x - bst.x) * bst.k; y = bst.y + (y - bst.y) * bst.k; }
    // 密度波：别的星系被推开、变暗；你的星系（波源）亮一下
    let wk = 1;
    if (wv) {
      if (r.id === wv.id) wk = 1 + 0.6 * Math.exp(-wv.t / 250);
      else { waveApply(wv, x, y, 1); x = WV.x; y = WV.y; wk = WV.k; }
    }
    const rad = blobR(r) * z1, R = rad * 2.7;
    if (x < -R || x > W + R || y < -R || y > H + R) continue;
    // 闪动只在核心：整个星系有十万光年宽，不可能几秒内整体变亮；能这么快变化的只有很小的星系核（活动星系核）。
    // 活跃的核心亮度起伏，偶尔一下尖峰；完全待命的几乎不动
    const ft = tp / 1000 * r.tw * run;
    const flick = 1 + r.heat * (0.18 * Math.sin(ft * 2.1 + r.ph) + 0.9 * Math.pow(Math.max(0, Math.sin(ft * 0.77 + r.ph * 3)), 24));
    const staleOnly = r.n > 0 && r.stale === r.n;
    const base = (staleOnly ? 0.16 : 0.3 + 0.55 * r.heat) * r.shown * wk;
    const dm = Math.hypot(m.x - x, m.y - y);
    const hov = m.inside && dm < Math.max(10, rad * 1.6);
    if (hov && dm < best && alpha > 0.9 && !bst) { best = dm; U.hover = r.id; }
    const rot = r.rot + tp / 1000 * 0.02 * run;
    const hot = r.n ? (r.think + r.act) / r.n : 0;
    const hotA = hot > 0 ? (0.35 + 0.65 * hot) * r.heat * r.shown * wk : 0;
    const coreA = (0.22 + 0.58 * r.heat) * flick * r.shown * (staleOnly ? 0.4 : 1) * wk;
    if (gl) {
      const o = nGl++ * FLOATS;
      glData[o] = x; glData[o + 1] = y; glData[o + 2] = rad; glData[o + 3] = rot;
      glData[o + 4] = r.flat; glData[o + 5] = Math.min(1, base); glData[o + 6] = Math.min(1, hotA); glData[o + 7] = Math.min(1, coreA);
    } else if (R < 2) {   // 太小了：一个点就够
      ctx.globalAlpha = alpha * Math.min(1, base + coreA * 0.5);
      ctx.fillStyle = hotA > 0.05 ? "rgb(240,170,140)" : "rgb(214,220,232)"; ctx.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);
    } else {
      const cosr = Math.cos(rot), sinr = Math.sin(rot);
      const put = (spr: HTMLCanvasElement, size: number, a: number, flat: number) => {
        if (a < 0.004) return;
        ctx.globalAlpha = alpha * Math.min(1, a);
        const s = size / 64, d = V.dpr;
        ctx.setTransform(d * cosr * s, d * sinr * s, -d * sinr * s * flat, d * cosr * s * flat, d * x, d * y);
        ctx.drawImage(spr, -64, -64);
      };
      put(SPR_INK, R, base, r.flat);
      if (hotA > 0) put(SPR_CLAUDE, R * 0.85, hotA, r.flat);
      put(SPR_CORE, rad * 0.9, coreA, 1);
      ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
    }
    if (r.wait > 0 || r.err > 0 || r.id === U.mine) { overlays.push(r); ox.push(x); oy.push(y); orad.push(rad); }
    if (rad > 6 || r.id === U.mine || hov) labels.push({ x, y, r: rad, row: r, a: r.shown * (hov ? 1 : r.id === U.mine ? 0.9 : smooth(6, 12, rad) * (0.35 + 0.4 * r.heat)), pri: hov ? 3 : r.id === U.mine ? 2 : r.heat });
  }
  ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  if (gl) {
    const img = gl.draw(glData, nGl, W, H, V.dpr);
    if (img) { ctx.globalAlpha = alpha; ctx.drawImage(img, 0, 0, W, H); }
  }
  ctx.globalAlpha = alpha;
  // 密度波的波前：很淡的一圈，帮眼睛看出波在往外走
  if (wv && wv.amp) {
    const a = 0.09 * (1 - smooth(500, 1500, wv.t));
    if (a > 0.005) { ctx.strokeStyle = col(INK, a); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(wv.x, wv.y, wv.t * wv.v, 0, TAU); ctx.stroke(); }
  }
  // 等你的波纹、出错的红点：星系多的时候有几百个，一个一个画（每个一次 stroke / fill）很慢。
  // 按不透明度分成 QA 档，同一档的合成一条路径一次画完；相邻两档只差 1/64 的不透明度，看不出来
  const QA = 64, rip: number[][] = [], dot: number[][] = [], rp: number[] = [], ek: number[] = [];
  ctx.lineWidth = 1;
  overlays.forEach((r, i) => {
    const x = ox[i], y = oy[i], rad = orad[i];
    // 等你：一圈圈向外的白色波纹
    if (r.wait > 0) {
      const p = (tp / 2600 + r.ph) % 1, l = Math.round(0.45 * (1 - p) * r.shown * QA);
      rp[i] = p;
      if (l > 0) (rip[l] ??= []).push(i);
    }
    if (r.err > 0) {   // 有会话出错：核心旁边一颗红色的「超新星」。光变曲线：很快亮到顶，再慢慢暗成一个常亮的小点（遗迹）
      // errAt 来自 performance.now()，可能比这一帧的时间戳 tp 还晚（同一帧里先收到消息、或者这一帧开始得早）：
      // 不夹住的话 since 是负的、k 是负的，红点半径变成负数，arc() 抛异常
      const since = Math.max(0, tp - (r.errAt ?? -1e9)), k = since < 160 ? since / 160 : Math.exp(-(since - 160) / 1100);
      ek[i] = k;
      if (k > 0.02) {   // 刚出错的那一下才有光晕，同时亮着的没几个：照旧一个一个画
        const sx = x + rad * 0.9, sy = y - rad * 0.9, gr = 3 + 7 * k, g = ctx.createRadialGradient(sx, sy, 0, sx, sy, gr);
        g.addColorStop(0, col("255,214,210", 0.9 * k * r.shown)); g.addColorStop(0.35, col(ERR, 0.45 * k * r.shown)); g.addColorStop(1, col(ERR, 0));
        ctx.fillStyle = g; ctx.fillRect(sx - gr, sy - gr, gr * 2, gr * 2);
      }
      const l = Math.round(clamp((0.6 + 0.4 * k) * r.shown, 0, 1) * QA);
      if (l > 0) (dot[l] ??= []).push(i);
    }
  });
  rip.forEach((list, l) => {   // 稀疏数组：forEach 跳过空着的档
    ctx.beginPath();
    for (const i of list) { const R = orad[i] * (1.1 + rp[i] * 1.5); ctx.moveTo(ox[i] + R, oy[i]); ctx.arc(ox[i], oy[i], R, 0, TAU); }
    ctx.strokeStyle = col(INK, l / QA); ctx.stroke();
  });
  dot.forEach((list, l) => {
    ctx.beginPath();
    for (const i of list) {
      const sx = ox[i] + orad[i] * 0.9, sy = oy[i] - orad[i] * 0.9, R = 1.5 + 0.9 * ek[i];
      ctx.moveTo(sx + R, sy); ctx.arc(sx, sy, R, 0, TAU);
    }
    ctx.fillStyle = col(ERR, l / QA); ctx.fill();
  });
  ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.font = `500 10.5px ${FONT}`;
  // 字间距只给拉丁字母和数字：中文本来就是方块字，再加间距会散
  const spacing = (s: string) => /[⺀-鿿豈-﫿＀-￯]/.test(s) ? "0px" : "1.2px";
  // 名字只写在放得下的地方：先写鼠标指着的、你的，再按活跃程度，压到别的名字的就不写
  const boxes: number[][] = [];
  for (const L of labels.sort((a, b) => b.pri - a.pri)) {
    const mine = L.row.id === U.mine;
    // 你的：名字亮一点，后面的「· 你的星系」暗一档（外面那圈虚线已经说明了这是你的）
    const tail = mine ? ` · ${T.yourGalaxy}` : "";
    ctx.letterSpacing = spacing(tail);
    const tw = tail ? textW(tail) : 0;
    ctx.letterSpacing = spacing(L.row.name);
    const name = fit(L.row.name, 200 - tw), nw = textW(name), w = nw + tw;
    let ty = Math.round(L.y + Math.max(8, L.r * 1.7));
    if (mine) {
      // 你的星系外面一圈虚线。名字压在圈的最下面，圈在名字那里断开（和行星系里轨道上的项目名一样）；圈太小放不下名字时，名字写在圈外
      const ringR = Math.max(9, L.r * 1.9), half = w / 2 + 6, onRing = half < ringR * 0.8, cut = onRing ? Math.asin(half / ringR) : 0;
      ctx.strokeStyle = col(INK, 0.5 * L.row.shown); ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.arc(L.x, L.y, ringR, Math.PI / 2 + cut, Math.PI / 2 - cut + TAU); ctx.stroke(); ctx.setLineDash([]);
      ty = Math.round(onRing ? L.y + ringR - 7 : L.y + ringR + 4);
    }
    if (L.a < 0.02) continue;
    const box = [L.x - w / 2 - 6, ty - 3, L.x + w / 2 + 6, ty + 16];
    if (L.pri < 2 && boxes.some(b => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) continue;
    boxes.push(box);
    const x0 = Math.round(L.x - w / 2);
    ctx.letterSpacing = spacing(name); ctx.fillStyle = col(INK, (mine ? 0.72 : 0.55) * L.a);
    ctx.fillText(name, x0, ty);
    if (tail) { ctx.letterSpacing = spacing(tail); ctx.fillStyle = col(INK, 0.32 * L.a); ctx.fillText(tail, x0 + nw, ty); }
  }
  ctx.letterSpacing = "0px";
  ctx.restore();
  if (alpha > 0.9 && !bst) setStyle("c", "cursor", U.drag.on && U.drag.moved >= 6 ? "grabbing" : U.hover ? "pointer" : "grab");

  // ---- 文字层：卡片、底部的总数
  updateCard(alpha, bst != null);
  setStyle("caption", "opacity", (alpha * (bst ? 1 - bst.k / 3 : 1)).toFixed(3));
  // 还没进任何星系群（没有邀请链接、链接被拒）：中间的面板在问要链接，这里不说「群里没有星系」
  const outside = conn.hello && !conn.local && (!ATT.keys || conn.denied);
  setText("caption", outside ? "" : liveN ? T.universeCaption(liveN, liveS, liveB) : T.universeEmpty);
  setText("hint", T.hintUniverse);
  setStyle("hint", "opacity", (alpha * 0.75 * (bst ? 0 : 1)).toFixed(3));
}

let cardKey = "";
function updateCard(alpha: number, flying: boolean) {
  const el = $("card");
  const r = U.hover ? U.rows.get(U.hover) : null;
  if (!r || flying || alpha < 0.9) { setStyle("card", "opacity", "0"); return; }
  const key = r.id + "|" + r.projects + "|" + r.codes + "|" + (r.id === U.mine);
  if (key !== cardKey) {
    cardKey = key;
    const C = T.counts;
    const parts = [r.think && C.think(r.think), r.act && C.act(r.act), r.wait && C.wait(r.wait), r.bg && C.bg(r.bg),
      r.err && C.err(r.err), r.done && C.done(r.done), r.idle && C.idle(r.idle), r.stale && C.stale(r.stale)].filter(Boolean);
    $("c-proj").textContent = r.id === U.mine ? T.yourGalaxy : T.galaxy;
    $("c-title").textContent = r.name;
    $("c-state").textContent = T.galaxySize(r.projects, r.n);
    $("c-step").textContent = parts.join(" · ") || "—";
    setStyle("c-subrow", "display", "none");
    el.dataset.status = r.think + r.act ? "working" : r.wait ? "waiting" : r.err ? "error" : "idle";
  }
  const [wx, wy] = worldOf(r), [x, y] = uscr(wx, wy), rad = blobR(r) * Math.exp(U.cam.lz);
  const above = y - rad * 2 - 18 > 150;
  setStyle("card", "left", clamp(x, 170, V.W - 170).toFixed(1) + "px");
  setStyle("card", "top", (above ? y - rad * 2 - 14 : y + rad * 2 + 14).toFixed(1) + "px");
  setStyle("card", "transform", `translate(-50%, ${above ? "-100%" : "0"})`);
  setStyle("card", "opacity", "1");
}

export function zoomAt(mx: number, my: number, dz: number) {
  userMovedCamera();
  const z0 = Math.exp(U.cam.lz);
  const wx = U.cam.x + (mx - V.W / 2) / z0, wy = U.cam.y + (my - V.H / 2) / z0;
  U.cam.lz = clamp(U.cam.lz + dz, Math.log(0.05), Math.log(40));
  const z1 = Math.exp(U.cam.lz);
  U.cam.x = wx - (mx - V.W / 2) / z1; U.cam.y = wy - (my - V.H / 2) / z1;
}

export function panBy(dx: number, dy: number) {
  userMovedCamera();
  const z = Math.exp(U.cam.lz);
  U.cam.x -= dx / z; U.cam.y -= dy / z;
}

export { lerp };
