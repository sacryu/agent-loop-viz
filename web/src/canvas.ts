// 画布和视口：全局只有一块主画布
export const cv = document.getElementById("c") as HTMLCanvasElement;
export const ctx = cv.getContext("2d")!;
export const V = { W: 0, H: 0, dpr: 1 };

export function resize() {
  V.dpr = Math.min(2, window.devicePixelRatio || 1);
  V.W = innerWidth; V.H = innerHeight;
  cv.width = Math.round(V.W * V.dpr); cv.height = Math.round(V.H * V.dpr);
}

// 量字宽很慢（每次都要排版一遍），而每帧量的几乎都是同样几段字：按「字体 + 字距 + 文字」记下来。
// 字体都是系统字体（没有后加载的网页字体），同样的字量出来永远一样。记太多了就整个清掉重来
const widths = new Map<string, number>(), fits = new Map<string, string>();
const fontKey = () => ctx.font + "|" + ctx.letterSpacing + "|";
export function textW(text: string): number {
  const k = fontKey() + text;
  let w = widths.get(k);
  if (w == null) { if (widths.size > 4000) widths.clear(); w = ctx.measureText(text).width; widths.set(k, w); }
  return w;
}

export function fit(text: string, maxW: number): string {
  if (textW(text) <= maxW) return text;
  const k = fontKey() + maxW.toFixed(1) + "|" + text;
  let s = fits.get(k);
  if (s == null) {
    let lo = 0, hi = text.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid; else hi = mid - 1; }
    s = text.slice(0, lo) + "…";
    if (fits.size > 2000) fits.clear();
    fits.set(k, s);
  }
  return s;
}

/** 两个圆的外包轮廓 */
export function capsulePath(ax: number, ay: number, ra: number, bx: number, by: number, rb: number) {
  const TAU = Math.PI * 2;
  const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy);
  ctx.beginPath();
  if (d <= Math.abs(ra - rb) + 0.01) { if (ra > rb) ctx.arc(ax, ay, ra, 0, TAU); else ctx.arc(bx, by, rb, 0, TAU); return; }
  const th = Math.atan2(dy, dx), ph = Math.acos((ra - rb) / d);
  ctx.arc(ax, ay, ra, th + ph, th - ph + TAU);
  ctx.arc(bx, by, rb, th - ph, th + ph);
  ctx.closePath();
}

// 背景的颗粒
export const grain = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const g = c.getContext("2d")!, im = g.createImageData(256, 256);
  for (let i = 0; i < im.data.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255;
    im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = Math.random() * 6;
  }
  g.putImageData(im, 0, 0);
  return ctx.createPattern(c, "repeat")!;
})();
