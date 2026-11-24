// 星系视图的镜头、投影和每一帧共用的状态。
import type { Step, Sub } from "./model.ts";

// 镜头钉在一个平面坐标点 (px,py) 上：它在屏幕上的位置是 (sx,sy)，缩放 e^lz。
// 放大时这个点就是被点中的对话，所以它在屏幕上的移动是单调的，不会先甩出去再回来。
export const cam = { px: 0, py: 0, sx: 0, sy: 0, lz: 0, f: 0, sid: null as string | null, ready: false, subK: 0 };

// 轨道所在的圆盘是斜着看的，带一点透视：靠近你的一侧更大、更疏，远的一侧更小、更密
export const PERSP = 0.27;
/** rout：画面能容下的最大轨道半径（透视按它算）；rsys：现在最外面一条轨道的半径 */
export const view = { rout: 1, tilt: 0.4, oy: 0, rsys: 1 };
export const project = (X: number, Y: number) => { const s = 1 / (1 - PERSP * Y / view.rout); return [X * s, Y * view.tilt * s, s]; };
export const scr = (wx: number, wy: number) => { const z = Math.exp(cam.lz); return [cam.sx + (wx - cam.px) * z, cam.sy + (wy - cam.py) * z]; };

export const F = {
  frameDt: 1 / 60,
  hoverSub: null as Sub | null,
  hoverSubStep: null as Step | null,
  subSpots: new Map<string, { x: number; y: number; r: number }>(),   // 子 agent 这一帧画在屏幕上的哪里：光点、悬停要用
  offline: false,   // 和服务断开：球上的随机闪烁停下
};
