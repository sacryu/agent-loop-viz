export const TAU = Math.PI * 2, DEG = Math.PI / 180;
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const rint = (a: number, b: number) => Math.floor(rand(a, b + 1));
export const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const els = new Map<string, HTMLElement>();
export const $ = (id: string) => { let el = els.get(id); if (!el) { el = document.getElementById(id) as HTMLElement; if (el) els.set(id, el); } return el; };
/** 新建一个元素：文字（可以没有）、class（可以没有） */
export function el(tag: string, text?: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

// 每帧都要更新的文字、样式：只在值变了的时候写。写一样的值也会让浏览器重新算样式、重新排版（textContent 尤其如此：
// 它把文字节点整个换掉）。同一个元素的同一项必须都经过这里写，否则这里记的「上次的值」就不对了
const lastDom = new Map<string, string>();
export function setText(id: string, s: string) {
  const k = id + "|text";
  if (lastDom.get(k) !== s) { lastDom.set(k, s); $(id).textContent = s; }
}
export function setStyle(id: string, prop: "opacity" | "left" | "top" | "transform" | "display" | "cursor", v: string) {
  const k = id + "|" + prop;
  if (lastDom.get(k) !== v) { lastDom.set(k, v); $(id).style[prop] = v; }
}

// 颜色只留给事件：做完的步骤是冷灰，正在跑的那一步是 Claude 的珊瑚色，出错是红
export const INK = "236,233,228", COOL = "168,178,192", CLAUDE = "217,119,87", HOT = "255,224,208", ERR = "242,84,91";
export const col = (c: string, a: number) => `rgba(${c},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
export const FONT = '"Segoe UI","Microsoft YaHei UI",system-ui,sans-serif';

export const T0 = performance.now();

/** 编译、链接一个 WebGL 程序并用上它。出错时打日志（带 tag）并返回 null */
export function glProgram(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string, tag: string): WebGLProgram | null {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(tag, gl.getShaderInfoLog(s)); return null; }
    return s;
  };
  const vs = sh(gl.VERTEX_SHADER, vsSrc), fs = sh(gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const pr = gl.createProgram()!; gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { console.warn(tag, gl.getProgramInfoLog(pr)); return null; }
  gl.useProgram(pr);
  return pr;
}
export const params = new URLSearchParams(location.search);

/** 服务器时钟：每条消息带着服务器的 now。和服务断开后时钟停在那一刻，各步的计时不再往上走 */
export const clock = { off: 0, stop: null as number | null };
export const now = () => clock.stop ?? Date.now() + clock.off;

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms)) return "";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  return Math.floor(ms / 60000) + "m " + String(Math.floor(ms % 60000 / 1000)).padStart(2, "0") + "s";
}
// 20ms → 0.08，200ms → 0.32，2s → 0.57，20s → 0.81，2 分钟 → 1
export const lenFor = (ms: number) => clamp(0.08 + 0.92 * Math.log(Math.max(ms, 20) / 20) / Math.log(6000), 0.08, 1);

export const frac = (x: number) => x - Math.floor(x);

/** 由字符串得到稳定的伪随机数（0～1），布局、名字用 */
export function hashUnit(s: string, seed = 0): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export const pctl = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
