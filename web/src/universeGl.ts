// 宇宙里的光团用 WebGL 一次画完：每个星系一个四边形，光的分布在着色器里算，画在一块离屏的 WebGL 画布上，
// 再整块贴回主画布。几千个星系也只有一次绘制调用。WebGL 不可用时 universeView.ts 退回 2D 的贴图画法。
import { glProgram } from "./util.ts";

/** 每个星系一份：中心 x、y（CSS 像素），半径，旋转，压扁，冷光、珊瑚光、核心的亮度 */
export const FLOATS = 8;

export interface BlobGl { ok: boolean; draw: (data: Float32Array, n: number, W: number, H: number, dpr: number) => HTMLCanvasElement | null }

export function createBlobGl(): BlobGl | null {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true, depth: false, stencil: false });
  if (!gl) return null;
  const VS = `
attribute vec2 aCorner;
attribute vec4 aA;   // x, y, r, rot
attribute vec4 aB;   // flat, ink, hot, core
uniform vec2 uView;
varying vec2 vP;
varying vec4 vB;
void main(){
  float ext = 2.7;
  vec2 q = aCorner * ext;                       // 四边形覆盖光团半径的 2.7 倍
  vP = q;
  vB = aB;
  float c = cos(aA.w), s = sin(aA.w);
  vec2 off = vec2(q.x, q.y * aB.x) * aA.z;      // 压扁
  off = vec2(off.x * c - off.y * s, off.x * s + off.y * c);
  vec2 px = aA.xy + off;
  gl_Position = vec4(px.x / uView.x * 2.0 - 1.0, 1.0 - px.y / uView.y * 2.0, 0.0, 1.0);
}`;
  const FS = `precision mediump float;
varying vec2 vP;
varying vec4 vB;
void main(){
  float d = length(vP) / 2.7;                   // 0 = 中心，1 = 外沿
  if (d >= 1.0) discard;
  // 和 2D 贴图同样的光分布：中心实、0.1 处半亮、0.45 处很淡、外沿为 0
  float halo = d < 0.1 ? mix(1.0, 0.55, d / 0.1) : d < 0.45 ? mix(0.55, 0.16, (d - 0.1) / 0.35) : mix(0.16, 0.0, (d - 0.45) / 0.55);
  float hd = d / 0.85;
  float hot = hd >= 1.0 ? 0.0 : hd < 0.08 ? mix(1.0, 0.55, hd / 0.08) : hd < 0.45 ? mix(0.55, 0.16, (hd - 0.08) / 0.37) : mix(0.16, 0.0, (hd - 0.45) / 0.55);
  float cd = length(vec2(vP.x, vP.y * vB.x)) / 0.9;   // 核心不压扁，半径是光团的 0.9
  float core = cd >= 1.0 ? 0.0 : cd < 0.04 ? mix(1.0, 0.55, cd / 0.04) : cd < 0.45 ? mix(0.55, 0.16, (cd - 0.04) / 0.41) : mix(0.16, 0.0, (cd - 0.45) / 0.55);
  vec3 ink = vec3(214.0, 220.0, 232.0) / 255.0, cla = vec3(217.0, 119.0, 87.0) / 255.0, cor = vec3(1.0, 240.0 / 255.0, 230.0 / 255.0);
  float a1 = halo * vB.y, a2 = hot * vB.z, a3 = core * vB.w;
  // 依次叠上去（source-over，预乘）
  vec4 o = vec4(ink * a1, a1);
  o = vec4(cla * a2, a2) + o * (1.0 - a2);
  o = vec4(cor * a3, a3) + o * (1.0 - a3);
  gl_FragColor = o;
}`;
  const pr = glProgram(gl, VS, FS, "[universe-gl]");
  if (!pr) return null;
  const ext = gl.getExtension("ANGLE_instanced_arrays");
  if (!ext) return null;
  const corner = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, corner);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const aCorner = gl.getAttribLocation(pr, "aCorner");
  gl.enableVertexAttribArray(aCorner); gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);
  const inst = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, inst);
  const aA = gl.getAttribLocation(pr, "aA"), aB = gl.getAttribLocation(pr, "aB");
  gl.enableVertexAttribArray(aA); gl.vertexAttribPointer(aA, 4, gl.FLOAT, false, FLOATS * 4, 0); ext.vertexAttribDivisorANGLE(aA, 1);
  gl.enableVertexAttribArray(aB); gl.vertexAttribPointer(aB, 4, gl.FLOAT, false, FLOATS * 4, 16); ext.vertexAttribDivisorANGLE(aB, 1);
  const uView = gl.getUniformLocation(pr, "uView");
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  let lost = false;
  c.addEventListener("webglcontextlost", e => { e.preventDefault(); lost = true; });
  const api: BlobGl = {
    get ok() { return !lost && !gl.isContextLost(); },
    draw(data, n, W, H, dpr) {
      const w = Math.round(W * dpr), h = Math.round(H * dpr);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (!n) return c;
      gl.uniform2f(uView, W, H);
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * FLOATS), gl.DYNAMIC_DRAW);
      ext.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, n);
      return c;
    },
  } as BlobGl;
  return api;
}
