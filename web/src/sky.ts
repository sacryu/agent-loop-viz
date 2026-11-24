// 行星系视图的星空：远处的恒星和一条很淡的银河。
//
// 物理：这些是我们所在星系里、几光年到几千光年外的恒星。和行星系的尺度比，它们等于在无穷远——
// 镜头在行星系里怎么移动、放大（往前飞），它们在屏幕上都不动，也不跟着鼠标视差（只有近处的尘埃动）。
// 太空里没有大气，所以不闪烁。
//   - 亮度：暗星远比亮星多。按星等取样，每暗 1 等，数量约多 3 倍（银盘附近的实测计数，log N ∝ 0.5 m）
//   - 颜色：按光谱型取黑体颜色。肉眼看得到的星里，亮的 B、A 型（蓝白）和 K 型巨星（橙）占得多；
//     暗星的颜色几乎看不出来（视网膜在暗处靠视杆细胞，不分颜色），所以越暗越接近白
//   - 银河：从银盘里面看出去，盘上的恒星连成一条带；带上的星更密，还有一层没分辨开的星光
// 每个星系的星空由星系编号决定：同一个星系，谁打开看到的都一样；换一个星系，天空也换了。
//
// 性能：整片星空只在第一次、换星系、窗口大小变了时画一遍到一块离屏画布上，之后每帧只贴一次图。
import { ctx, V } from "./canvas.ts";
import { TAU } from "./util.ts";

function seedOf(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function rng(seed: number) {   // mulberry32
  return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// 光谱型：黑体颜色和在「看得到的星」里的占比（亮星表里大致的比例）
const TYPES: [string, number][] = [
  ["160,185,255", 0.1],    // O/B：上万度，蓝
  ["202,215,255", 0.22],   // A：约 9000 K，蓝白
  ["246,245,255", 0.18],   // F：约 7000 K，白
  ["255,241,224", 0.17],   // G：约 5800 K，黄白
  ["255,210,160", 0.25],   // K：约 4500 K，橙（多是巨星）
  ["255,180,120", 0.08],   // M：约 3200 K，橙红
];
const MLIM = 7;   // 最暗画到几等（相对的；最亮的约 0 等）

let cache: { key: string; cv: HTMLCanvasElement } | null = null;

function paint(seed: number, W: number, H: number, dpr: number) {
  const cv = cache?.cv ?? document.createElement("canvas");
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const r = rng(seed);
  // 天空按一个正方形取样（边长 = 窗口的长边），窗口变了只是裁的范围变，同一颗星还在原来的方向上
  const S = Math.max(W, H), cx = W / 2, cy = H / 2;
  const toX = (u: number) => cx + u * S, toY = (v: number) => cy + v * S;

  // 银河：一条斜着穿过画面的带。方向、位置由星系决定
  const th = (r() - 0.5) * 1.2 + (r() < 0.5 ? 0 : Math.PI / 2), nx = -Math.sin(th), ny = Math.cos(th);
  const off = (r() - 0.5) * 0.3, width = 0.07 + r() * 0.05;
  // 没分辨开的星光：沿带撒一串很淡的大光斑，疏密不均，看起来是一团一团的
  g.globalCompositeOperation = "lighter";
  for (let i = 0; i < 70; i++) {
    const t = (r() - 0.5) * 1.6, d = gauss(r) * width * 0.6;
    const u = -ny * t + nx * (d + off), v = nx * t + ny * (d + off);
    const x = toX(u), y = toY(v), R = S * width * (0.5 + r() * 1.1);
    const grad = g.createRadialGradient(x, y, 0, x, y, R);
    const c = r() < 0.7 ? "196,204,224" : "224,206,186";
    grad.addColorStop(0, `rgba(${c},${(0.007 + r() * 0.011).toFixed(4)})`); grad.addColorStop(1, `rgba(${c},0)`);
    g.fillStyle = grad; g.fillRect(x - R, y - R, 2 * R, 2 * R);
  }

  // 恒星：一半均匀撒，一半落在银河里
  const n = Math.round(W * H / 900);
  for (let i = 0; i < n; i++) {
    let u: number, v: number;
    if (r() < 0.55) { u = r() - 0.5; v = r() - 0.5; }
    else { const t = (r() - 0.5) * 1.6, d = gauss(r) * width * 0.7; u = -ny * t + nx * (d + off); v = nx * t + ny * (d + off); }
    const x = toX(u), y = toY(v);
    if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue;
    // 星等：每暗 1 等数量多 10^0.5 ≈ 3.2 倍
    const m = MLIM + Math.log10(1 - r() * (1 - Math.pow(10, -0.5 * MLIM))) / 0.5;
    const L = Math.max(0, (MLIM - m) / MLIM);   // 0 = 最暗，1 = 最亮
    let k = r(), c = TYPES[TYPES.length - 1][0];
    for (const [tc, p] of TYPES) { if (k < p) { c = tc; break; } k -= p; }
    c = mix(c, "236,238,244", 1 - Math.min(1, L * 1.6));   // 暗星看不出颜色
    const a = 0.16 + 0.8 * Math.pow(L, 0.8), rad = 0.42 + 1.1 * Math.pow(L, 1.6);
    if (L > 0.5) {   // 亮星：一圈很淡的光晕（光学系统的散射）
      const R = rad * (5 + 6 * L), grad = g.createRadialGradient(x, y, 0, x, y, R);
      grad.addColorStop(0, `rgba(${c},${(0.16 * L).toFixed(3)})`); grad.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = grad; g.fillRect(x - R, y - R, 2 * R, 2 * R);
    }
    g.fillStyle = `rgba(${c},${Math.min(1, a).toFixed(3)})`;
    g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
  }
  g.globalCompositeOperation = "source-over";
  return cv;
}

function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(TAU * r()); }
function mix(a: string, b: string, t: number) {
  const A = a.split(",").map(Number), B = b.split(",").map(Number);
  return A.map((x, i) => Math.round(x + (B[i] - x) * t)).join(",");
}

/** 画星空（主画布的变换是 CSS 像素）。id：星系编号，决定这片天空长什么样 */
export function drawSky(id: string, alpha: number) {
  if (alpha < 0.01) return;
  const { W, H, dpr } = V, key = `${id}|${W}x${H}@${dpr}`;
  if (cache?.key !== key) cache = { key, cv: paint(seedOf(id), W, H, dpr) };
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(cache.cv, 0, 0, W, H);
  ctx.restore();
}
