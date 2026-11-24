// 行星系中心的恒星：模型。物理依据见 docs/physics.md 的「行星系」。
//   一个会自转的球：表面纹理按球面上的 3D 位置生成，跟着恒星转，转到边上被压扁、变暗，再转到背面去。
//   自转轴垂直于行星的轨道面（行星系是从同一团旋转的气体里形成的），所以球的倾斜跟着轨道面的倾斜；拖着行星系转，恒星跟着转。
//   赤道比两极转得快：较差自转（黑子按各自的纬度转；米粒活得短，看不出来，整个表面按一个速度转）。
//   表面：米粒组织（对流）、成对的黑子（领头的那个更靠赤道：乔伊定律）、靠边才看得清的光斑、边缘暗而偏红（临边昏暗）。
//   黑子按星系编号生成，会出生、长大、衰退，跟着这颗恒星的活动周期变多变少、往赤道移（见下面的 activeARs）。
//   模型回复时：耀斑（M.flare），亮在当时最朝着你的那个活动区。
//   颜色和大小跟模型的档次走：赫罗图的主序上，恒星质量越大，越亮、越热、越蓝。真实的大小差上千倍，这里压缩了。
// 球用 WebGL 逐像素画在一块离屏画布上，再贴回主画布；WebGL 不可用（或 ?star3d=0）时退回 2D：只有临边昏暗的圆盘，没有表面纹理。
// 珊瑚色只表示「在干活」（Hα 发射线的颜色），不是恒星的颜色。
import { ctx, V } from "./canvas.ts";
import { M } from "./model.ts";
import { TAU, clamp, col, params, glProgram } from "./util.ts";

// ---- 测性能用：?bench 在每帧记录恒星花的时间和帧间隔；?stress=N 每帧把恒星画 N 遍，放大差别
export const PERF = {
  on: params.has("bench"), stress: Math.max(1, Math.min(200, +(params.get("stress") || 1) || 1)),
  star: [] as number[], frame: [] as number[], cpu: [] as number[],
};

export interface StarClass {
  cls: "M" | "G" | "B" | "O";
  /** 光球的颜色（中心）和边缘的颜色，r,g,b */
  core: string; limb: string;
  /** 相对大小（压缩过的） */
  size: number;
  /** 亮度：外面那层光的强弱跟着它 */
  lum: number;
}

// 颜色取自对应温度的黑体颜色（M 约 3200 K、G 约 5800 K、B 约 15000 K、O 约 35000 K），亮度压过一道以免刺眼
export const STARS: Record<StarClass["cls"], StarClass> = {
  M: { cls: "M", core: "255,196,150", limb: "214,104,64", size: 0.72, lum: 0.7 },
  G: { cls: "G", core: "255,246,228", limb: "236,178,118", size: 1, lum: 1 },
  B: { cls: "B", core: "232,240,255", limb: "150,176,236", size: 1.22, lum: 1.25 },
  O: { cls: "O", core: "214,226,255", limb: "118,146,236", size: 1.4, lum: 1.45 },
};

/** 模型名 → 恒星。认不出或拿不到时是类太阳的 G 型 */
export function starOf(model: string | null | undefined): StarClass {
  const m = (model || "").toLowerCase();
  if (m.includes("haiku")) return STARS.M;
  if (m.includes("sonnet")) return STARS.G;
  if (m.includes("opus")) return STARS.B;
  if (m.includes("fable") || m.includes("mythos")) return STARS.O;
  return STARS.G;
}

/** 行星系用的模型：最近有动静的那个对话的模型 */
export function galaxyModel(): string | null {
  let best: string | null = null, t = -Infinity;
  for (const S of M.sessions.values()) if (S.model && S.goneAt == null && S.lastEvent > t) { t = S.lastEvent; best = S.model; }
  return best;
}

// ---- 几何。恒星坐标：y 轴 = 自转轴；视图坐标：x 右、y 上、z 朝你。e = 你在轨道面上方的仰角，app 里的 view.tilt = sin(e)
const W_EQ = 0.16;   // 赤道的自转角速度（弧度/秒）：约 40 秒一圈，真实的太阳是 25 天
const omega = (lat: number) => { const s = Math.sin(lat); return W_EQ * (1 - 0.2 * s * s - 0.15 * s ** 4); };   // 较差自转，系数取自太阳
const sph = (lat: number, lon: number) => [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
/** 绕自转轴转 a：经度 + a */
const rotY = (v: number[], a: number) => { const c = Math.cos(a), s = Math.sin(a); return [v[0] * c - v[2] * s, v[1], v[0] * s + v[2] * c]; };

// ---- 活动区（一对黑子 + 周围的光斑）：按星系编号生成，会出生、长大、衰退
//   时间用真实的钟（断线时停住）：同一个星系、同一时刻，谁打开看到的都一样；隔一阵再来，黑子已经换了一批。
//   时间切成 SLOT 秒一格，每格按「星系编号 + 格号」决定这一格有没有冒出一个活动区、在哪、多大。不存状态，随时能算出来。
//   活动周期（太阳约 11 年）压缩成 CYCLE 秒：周期中段冒得多、两头冒得少；新活动区的纬度从约 30° 随周期移向赤道（斯波勒定律）。
//   寿命跟最大面积成正比（大的活得久，Gnevyshev–Waldmeier 规律），真实的是几天到几个月，这里压到一两分钟到六七分钟。
const SLOT = 30, CYCLE = 1200, MAX_AR = 8, PLAGE = 1.35;
const lifeOf = (size: number) => 90 + 300 * size;
const MAX_SPAN = lifeOf(1) * PLAGE;
interface AR { born: number; life: number; sep: number; rate: number; lead: number[]; foll: number[]; mid: number[] }

function hashStr(s: string) {   // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function rng(seed: number) {   // mulberry32
  return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

let arSeed = -1;
const arCache = new Map<number, AR | null>();
function arOf(seed: number, k: number): AR | null {
  const hit = arCache.get(k);
  if (hit !== undefined) return hit;
  const r = rng(seed ^ Math.imul(k, 0x9E3779B1));
  const born = k * SLOT + r() * SLOT;
  const ph = ((born / CYCLE + seed / 4294967296) % 1 + 1) % 1;   // 这个星系的活动周期走到哪了
  const activity = 0.08 + 0.92 * Math.sin(Math.PI * ph) ** 2;
  const roll = r(), size = r() ** 1.6, hemi = r() < 0.5 ? 1 : -1, jitter = r() - 0.5, lon = r() * TAU;
  let ar: AR | null = null;
  if (roll < 0.55 * activity) {
    const lat = hemi * (30 - 22 * ph + jitter * 10) * Math.PI / 180, sep = 0.16 + 0.22 * size;
    const dl = 0.22 * sep * hemi;   // 领头的（自转方向在前）更靠赤道：乔伊定律
    ar = { born, life: lifeOf(size), sep, rate: omega(lat), lead: sph(lat - dl, lon + sep / 2), foll: sph(lat + dl, lon - sep / 2), mid: sph(lat, lon) };
  }
  arCache.set(k, ar);
  return ar;
}

/** 此刻还在的活动区（连同只剩光斑的），新的在前，最多 MAX_AR 个 */
function activeARs(seed: number, T: number) {
  if (seed !== arSeed) { arSeed = seed; arCache.clear(); }
  const k1 = Math.floor(T / SLOT), k0 = Math.floor((T - MAX_SPAN) / SLOT) - 1, out: AR[] = [];
  for (let k = k1; k >= k0 && out.length < MAX_AR; k--) {
    const ar = arOf(seed, k);
    if (ar && T >= ar.born && T < ar.born + ar.life * PLAGE) out.push(ar);
  }
  if (arCache.size > 200) for (const k of arCache.keys()) if (k < k0) arCache.delete(k);
  return out;
}

/** 面积随时间：很快冒出来（寿命的前 10%），然后按固定速率缩小，到 end 时没了。u = 已过的时间 / 寿命 */
const area = (u: number, end: number) => u <= 0 || u >= end ? 0 : u < 0.1 ? u / 0.1 : 1 - (u - 0.1) / (end - 0.1);

// ---- WebGL：光球
const VS = `attribute vec2 a; varying vec2 vUv; void main(){ vUv = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`;
const FS = `precision highp float;
varying vec2 vUv;
uniform float uM, uRot, uTg, uE, uPx, uGran, uFlare;
uniform vec3 uCore, uLimb, uFlareDir;
uniform vec4 uSpot[16];   // 黑子：xyz 方向（恒星坐标），w 半径（弧度，0 = 没有）
uniform vec4 uFac[8];     // 光斑：xyz 活动区中心，w 半径

vec3 h3(vec3 p) {
  return fract(sin(vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)))) * 43758.5453);
}
float h1(vec3 p) { return fract(sin(dot(p, vec3(17.1, 113.7, 41.3))) * 43758.5453); }
float vn(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h1(i), h1(i + vec3(1,0,0)), f.x), mix(h1(i + vec3(0,1,0)), h1(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h1(i + vec3(0,0,1)), h1(i + vec3(1,0,1)), f.x), mix(h1(i + vec3(0,1,1)), h1(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vn(p); p *= 2.03; a *= 0.5; } return s; }
// 米粒：沃罗诺伊格子，格子中间亮、格子之间的缝暗；格点随时间晃，米粒就在慢慢变
vec2 worley(vec3 p, float t) {
  vec3 i = floor(p), f = fract(p); float F1 = 9.0, F2 = 9.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    vec3 g = vec3(float(x), float(y), float(z)), o = h3(i + g);
    o = 0.5 + 0.42 * sin(t * 0.5 + 6.2831 * o);
    vec3 r = g + o - f; float d = dot(r, r);
    if (d < F1) { F2 = F1; F1 = d; } else if (d < F2) { F2 = d; }
  }
  return sqrt(vec2(F1, F2));
}
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * uM;
  float rr = length(p);
  // 球外：贴着边的一圈光（色球、内冕和散射），到贴图边上降到 0
  float d = max(rr - 1.0, 0.0);
  float g = (exp(-d * 14.0) * 0.3 + exp(-d * 4.5) * 0.18) * (1.0 + 0.8 * uFlare) * (1.0 - smoothstep(uM * 0.7, uM, rr));
  vec4 outside = vec4(mix(uCore, uLimb, 0.45) * g, g);
  if (rr >= 1.0 + uPx) { gl_FragColor = outside; return; }

  float z = sqrt(max(0.0, 1.0 - rr * rr));
  float ce = cos(uE), se = sin(uE);
  vec3 s = vec3(p.x, ce * p.y + se * z, -se * p.y + ce * z);   // 视图坐标 → 恒星坐标
  float sl = s.y, lat = asin(clamp(sl, -1.0, 1.0)), cl = cos(lat);
  // 转回跟着表面一起转的坐标。米粒只活几分钟，看不出较差自转，整个表面按一个角速度转（否则开久了米粒会被拉成条纹）
  float lon = atan(s.z, s.x) - uRot;
  vec3 q = vec3(cl * cos(lon), sl, cl * sin(lon));
  float mu = z, k = 1.0 - mu;

  vec2 Wd = worley(q * uGran, uTg);
  float cell = smoothstep(0.0, 0.22, Wd.y - Wd.x);
  float gran = mix(0.9, 1.0, cell) * mix(1.02, 0.96, clamp(Wd.x, 0.0, 1.0));
  float mott = fbm(q * 4.0);

  // 黑子和光斑跟着各自的活动区转（较差自转），方向已经在 JS 里算好，所以这里用恒星坐标 s
  float spot = 1.0, fac = 0.0;
  for (int i = 0; i < 16; i++) {
    float R = uSpot[i].w;
    if (R > 0.0) {
      float ang = acos(clamp(dot(s, uSpot[i].xyz), -1.0, 1.0));
      float pen = smoothstep(R, R * 0.55, ang), umb = smoothstep(R * 0.5, R * 0.28, ang);
      spot *= 1.0 - 0.45 * pen - 0.4 * umb;
    }
  }
  for (int i = 0; i < 8; i++) {
    float R = uFac[i].w;
    if (R > 0.0) fac += smoothstep(R, R * 0.3, acos(clamp(dot(s, uFac[i].xyz), -1.0, 1.0))) * (0.6 + 0.4 * cell);
  }
  fac *= spot * spot;   // 黑子里面没有光斑
  float I = 1.0 - 0.6 * k - 0.12 * k * k;                        // 临边昏暗
  vec3 base = mix(uLimb, uCore, pow(mu, 0.5));
  base = mix(base, vec3(1.0), 0.45 * mu * mu);
  float gk = mix(1.0, gran, smoothstep(0.08, 0.4, mu));          // 越靠边米粒越看不清
  vec3 c = base * I * gk * (0.88 + 0.24 * mott) * spot * 1.12;
  c += uCore * fac * 0.55 * pow(k, 1.2);                         // 光斑：靠边才显出来
  float fa = acos(clamp(dot(s, uFlareDir), -1.0, 1.0));
  c += vec3(1.0) * uFlare * smoothstep(0.17, 0.0, fa) * (0.5 + 0.5 * cell) * 1.4;
  c *= 1.0 + 0.12 * uFlare;
  float aa = clamp((1.0 - rr) / uPx * 0.5 + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(c, 1.0) * aa + outside * (1.0 - aa);
}`;

const U_NAMES = ["uM", "uRot", "uTg", "uE", "uPx", "uGran", "uFlare", "uCore", "uLimb", "uFlareDir", "uSpot", "uFac"] as const;
interface SphereGl { cv: HTMLCanvasElement; gl: WebGLRenderingContext; U: Record<(typeof U_NAMES)[number], WebGLUniformLocation | null>; lost: boolean }

function createSphereGl(): SphereGl | null {
  const cv = document.createElement("canvas");
  const gl = cv.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true, depth: false, stencil: false });
  if (!gl) return null;
  const pr = glProgram(gl, VS, FS, "[star-gl]");
  if (!pr) return null;
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(pr, "a"); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  const U = {} as SphereGl["U"];
  for (const n of U_NAMES) U[n] = gl.getUniformLocation(pr, n);
  const S: SphereGl = { cv, gl, U, lost: false };
  cv.addEventListener("webglcontextlost", e => { e.preventDefault(); S.lost = true; });
  return S;
}

let sgl: SphereGl | null | undefined;   // undefined：还没试过
function sphereGl(): SphereGl | null {
  if (sgl === undefined) sgl = params.get("star3d") === "0" ? null : createSphereGl();
  return sgl && !sgl.lost && !sgl.gl.isContextLost() ? sgl : null;
}

const QUAD = 1.35;   // 贴图半边长 = 1.35 个恒星半径，留出边上那圈光
const rgb01 = (c: string) => c.split(",").map(v => +v / 255);
const spotBuf = new Float32Array(MAX_AR * 8), facBuf = new Float32Array(MAX_AR * 4);
const mod = (a: number, m: number) => ((a % m) + m) % m;
/** 活动区此刻在恒星坐标里的方向：按它自己纬度的角速度转过的角度 */
const arAngle = (ar: AR, T: number, az: number) => mod(ar.rate * T + az, TAU);

/**
 * 把光球画在 WebGL 画布左下角的 N×N 里（WebGL 的原点在左下角），返回 N。
 * 画布按 64 的整数倍取大小，只在跨档时才重设：镜头飞进飞出时 R 每帧都变，不能每帧重新分配画布
 */
function renderSphere(S: SphereGl, R: number, star: StarClass, T: number, e: number, az: number, flare: number, ars: AR[]) {
  const { cv, gl, U } = S, dpr = V.dpr, N = Math.min(2048, Math.ceil(2 * R * QUAD * dpr)), C = Math.ceil(N / 64) * 64;
  if (cv.width !== C) cv.width = cv.height = C;
  gl.viewport(0, 0, N, N);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  // T 是真实时间（十几亿秒），着色器里只有单精度：转过的角度和米粒的晃动都先在这里取模
  gl.uniform1f(U.uM, QUAD); gl.uniform1f(U.uRot, mod(W_EQ * T + az, TAU)); gl.uniform1f(U.uTg, mod(T, 4 * Math.PI)); gl.uniform1f(U.uE, e);
  gl.uniform1f(U.uPx, QUAD * 2 / N); gl.uniform1f(U.uGran, clamp(R / 3.2, 6, 42)); gl.uniform1f(U.uFlare, flare);
  gl.uniform3fv(U.uCore, rgb01(star.core)); gl.uniform3fv(U.uLimb, rgb01(star.limb));
  spotBuf.fill(0); facBuf.fill(0);
  ars.forEach((ar, i) => {
    const a = arAngle(ar, T, az), u = (T - ar.born) / ar.life;
    // 半径 ∝ √面积。后面的黑子先散（寿命的 70%）；光斑比黑子留得久（寿命的 PLAGE 倍）
    spotBuf.set(rotY(ar.lead, a), i * 8); spotBuf[i * 8 + 3] = ar.sep * 0.4 * Math.sqrt(area(u, 1));
    spotBuf.set(rotY(ar.foll, a), i * 8 + 4); spotBuf[i * 8 + 7] = ar.sep * 0.3 * Math.sqrt(area(u, 0.7));
    facBuf.set(rotY(ar.mid, a), i * 4); facBuf[i * 4 + 3] = ar.sep * 1.1 * Math.sqrt(area(u, PLAGE));
  });
  gl.uniform4fv(U.uSpot, spotBuf); gl.uniform4fv(U.uFac, facBuf);
  gl.uniform3fv(U.uFlareDir, flareAR ? rotY(flareAR.mid, arAngle(flareAR, T, az)) : [0, 0, 0]);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return N;
}

// 耀斑亮在哪个活动区：耀斑刚起来的那一刻，最朝着你的那个。一个活动区都没有时，只是整体变亮
let flareAR: AR | null = null, flarePrev = 0;
function pickFlare(T: number, e: number, az: number, ars: AR[]) {
  if (M.flare > 0.05 && flarePrev <= 0.05) {
    const ce = Math.cos(e), se = Math.sin(e);
    let bz = -9;
    flareAR = null;
    for (const ar of ars) { const v = rotY(ar.mid, arAngle(ar, T, az)), z = se * v[1] + ce * v[2]; if (z > bz) { bz = z; flareAR = ar; } }
  }
  flarePrev = M.flare;
}

/** WebGL 不可用时：临边昏暗的圆盘，没有表面纹理。边缘不描线，靠外面那圈光过渡 */
function drawFlat(x: number, y: number, r: number, star: StarClass, flare: number) {
  const disc = ctx.createRadialGradient(x, y, 0, x, y, r);
  disc.addColorStop(0, col("255,255,255", 1)); disc.addColorStop(0.45, col(star.core, 1));
  disc.addColorStop(0.85, col(star.core, 0.95)); disc.addColorStop(1, col(star.limb, 0.9));
  ctx.fillStyle = disc; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  if (flare > 0.02) { ctx.fillStyle = col("255,255,255", 0.3 * flare); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
}

/**
 * 画恒星。R：光球的半径（屏幕像素，已乘上档次的大小）；alpha：整体不透明度；tp：动画时钟（毫秒，断线时停住）；
 * tilt：轨道面压扁的比例（= 仰角的正弦）；az：整个行星系被拖着转过的角度
 */
export function drawStar(x: number, y: number, R: number, alpha: number, tp: number, star: StarClass, tilt: number, az: number) {
  const { W, H } = V, flare = M.flare;
  if (alpha < 0.01) return;
  const reach = R * 5 * Math.sqrt(star.lum);
  if (x < -reach || x > W + reach || y < -reach || y > H + reach) return;
  // 真实的钟（断线时停住）：同一个星系、同一时刻，谁打开看到的都一样
  const T = (performance.timeOrigin + tp) / 1000, e = Math.asin(clamp(tilt, 0, 1));
  const ars = activeARs(hashStr(M.galaxyId ?? ""), T);
  pickFlare(T, e, az, ars);
  ctx.save();
  ctx.globalAlpha *= alpha;
  // 外面一层光（散射在仪器和星际尘埃里的光），耀斑时更亮
  ctx.globalCompositeOperation = "lighter";
  const halo = ctx.createRadialGradient(x, y, R * 0.9, x, y, reach);
  halo.addColorStop(0, col(star.core, 0.16 * Math.sqrt(star.lum) * (1 + 0.5 * flare)));
  halo.addColorStop(0.2, col(star.limb, 0.05 * Math.sqrt(star.lum)));
  halo.addColorStop(1, col(star.limb, 0));
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y, reach, 0, TAU); ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  const S = sphereGl();
  if (S) { const h = R * QUAD, N = renderSphere(S, R, star, T, e, az, flare, ars); ctx.drawImage(S.cv, 0, S.cv.height - N, N, N, x - h, y - h, 2 * h, 2 * h); }
  else drawFlat(x, y, R, star, flare);
  ctx.restore();
}

export const starInfo = () => ({ model: galaxyModel(), cls: starOf(galaxyModel()).cls });
