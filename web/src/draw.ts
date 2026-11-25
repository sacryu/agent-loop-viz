// 星系视图里的画法：球（对话）、射线（步骤）、子 agent 小球、后台任务卫星、雾和尘埃。
import { capsulePath, ctx, fit, V } from "./canvas.ts";
import {
  M, RING_F, SUB_BACK_MS, SUB_BIRTH_MS, SUB_MAX, SWEEP_MS, bgOnly, subTypeOf, subsAlive, wordOf,
  type Ring, type Seg, type Session, type Step, type Sub,
} from "./model.ts";
import { F, cam, scr, view } from "./scene.ts";
import { CLAUDE, COOL, ERR, FONT, HOT, INK, TAU, clamp, col, fmtMs, lenFor, lerp, now, rand, smooth } from "./util.ts";
import { T } from "./i18n.ts";

// 一步在球面上的方向。球的自转轴垂直于轨道面，北极朝你这边倾 EPS；
// 放大时 (m → 1) 北极转过来正对着你、各步落回赤道：球摊平成一个表盘，角度 a 从 12 点顺时针。
// 结果写在 DIR 里：[屏幕 x 方向, 屏幕 y 方向, 朝向你的深度]。每帧要算上万次，不每次新建数组；下一次调用会覆盖它
const EPS = 0.5, SIN_E = Math.sin(EPS), COS_E = Math.cos(EPS);
const DIR: [number, number, number] = [0, 0, 0];
const setDir = (x: number, y: number, z: number) => { DIR[0] = x; DIR[1] = y; DIR[2] = z; return DIR; };
export function dirOf(lon: number, sl: number, cl: number, spin: number, a: number, m: number): Readonly<[number, number, number]> {
  if (m >= 0.999) return setDir(Math.sin(a), -Math.cos(a), 0);
  const ph = lon + spin, y0 = sl, z0 = -cl * Math.cos(ph);
  const sx = cl * Math.sin(ph), sy = y0 * COS_E - z0 * SIN_E, sz = y0 * SIN_E + z0 * COS_E;
  if (m <= 0.001) return setDir(sx, -sy, sz);
  const fx = Math.sin(a), fy = Math.cos(a);
  const om = Math.acos(clamp(sx * fx + sy * fy, -1, 1)), so = Math.sin(om);
  if (so < 1e-3) return setDir(fx, -fy, 0);
  const ka = Math.sin((1 - m) * om) / so, kb = Math.sin(m * om) / so;
  return setDir(ka * sx + kb * fx, -(ka * sy + kb * fy), ka * sz);
}

// 这个对话现在停在哪一步：正在跑的那一步，否则是最后一步
export function currentStep(S: Ring, t: number): { text: string; sub: string; err: boolean } {
  const active = S.status === "working" || S.status === "waiting";
  let cur: Step | null = null;   // 最后一个还没结束的（从后往前找，不复制整个数组）
  if (active) for (let i = S.steps.length - 1; i >= 0; i--) if (S.steps[i].end == null) { cur = S.steps[i]; break; }
  if (cur) {
    // 等你授权：「想 改 app.ts」（问你问题、确认计划本身就是在问你，不加「想」）
    const want = S.status === "waiting" && !S.waitSub && cur.kind !== "ask" && cur.kind !== "plan";
    return { text: want ? T.want(cur.phrase) : cur.phrase, sub: want ? T.waitPermission + " · " + fmtMs(t - cur.start) : fmtMs(t - cur.start), err: false };
  }
  if (bgOnly(S)) return { text: T.bgRunning(S.bg), sub: T.waited(fmtMs(t - (S.bgSince || S.phaseSince))), err: false };
  if (S.status === "working" && (S.phase === "think" || !S.steps.length)) return { text: "thinking...", sub: fmtMs(t - S.phaseSince), err: false };
  const last = S.steps[S.steps.length - 1];
  return last ? { text: last.phrase, sub: last.end == null ? "" : fmtMs(last.end - last.start) + (last.err ? " · " + (last.errText || T.failed) : ""), err: last.err }
              : { text: "", sub: "", err: false };
}

// ---- 后台任务：回合结束了，shell 之类还在跑。每个任务是一颗绕着球转的小卫星，
// 走在一条斜着的虚线轨道上，拖一小段尾巴，转到球后面会被挡住。出发时从球里飞出去，任务跑完时盘旋着落回球上，荡开一圈。
// 不用珊瑚色：那是「模型在干活」，这时候模型是闲着的。
const SAT_OUT_MS = 650, SAT_IN_MS = 750, SAT_PERIOD = 5.5;
export function syncSats(S: Ring, tp: number, dt: number) {
  const live = S.sats.filter(x => x.endAt == null), want = Math.min(3, S.bg || 0);
  for (let i = live.length; i < want; i++)
    S.sats.push({ bornAt: tp, endAt: null, ph: (S.sats.length ? S.sats[S.sats.length - 1].ph : rand(0, TAU)) + TAU / Math.max(2, want) + rand(-0.3, 0.3),
                  tilt: rand(-0.5, -0.2) + (i % 2 ? 0.55 : 0), flat: rand(0.3, 0.42) });
  for (let i = live.length - 1; i >= want; i--) { live[i].endAt = tp; }   // 任务跑完了：落回去
  for (let i = S.sats.length - 1; i >= 0; i--) {
    const x = S.sats[i], q = x.endAt == null ? 0 : clamp((tp - x.endAt) / SAT_IN_MS, 0, 1);
    x.ph += (1 + 2.5 * q * q) * TAU / SAT_PERIOD * dt;   // 落回去时越转越快
    if (x.endAt != null && tp - x.endAt > SAT_IN_MS) {
      if (!x.pinged) { x.pinged = true; M.pings.push({ sid: S.sid, t0: tp, ink: true }); }
      S.sats.splice(i, 1);
    }
  }
}

function drawSats(S: Ring, x: number, y: number, r: number, alpha: number, lod: number, m: number, tp: number, front: boolean) {
  if (!S.sats.length || alpha < 0.02) return;
  const R0 = r * lerp(2.2, 1.72, lod), flatK = lerp(1, 0.55, m);   // 放大成表盘时轨道摊开一些
  for (const sat of S.sats) {
    let rad = R0, a = 1;
    if (sat.endAt == null) {
      const q = clamp((tp - sat.bornAt) / SAT_OUT_MS, 0, 1), e = 1 - (1 - q) * (1 - q) * (1 - q);
      rad = lerp(r * 0.6, R0, e); a = smooth(0, 0.35, q);
    } else {
      const q = clamp((tp - sat.endAt) / SAT_IN_MS, 0, 1), e = q * q;
      rad = lerp(R0, r * 0.55, e); a = 1 - smooth(0.7, 1, q);
    }
    const flat = lerp(sat.flat, 1, 1 - flatK), ct = Math.cos(sat.tilt), st = Math.sin(sat.tilt);
    const at = (th: number) => { const ex = Math.cos(th) * rad, ey = Math.sin(th) * rad * flat; return [x + ex * ct - ey * st, y + ex * st + ey * ct, Math.sin(th)]; };
    const lw = lerp(0.8, 1.1, lod), A = alpha * a;
    // 虚线轨道：只画属于这一面的那一半
    ctx.save();
    ctx.setLineDash([lerp(1.5, 3, lod), lerp(3.5, 6, lod)]); ctx.lineWidth = lw;
    ctx.strokeStyle = col(COOL, (front ? lerp(0.4, 0.26, lod) : 0.12) * A);
    ctx.beginPath();
    const N = 40, from = front ? 0 : Math.PI;
    for (let i = 0; i <= N; i++) { const [px, py] = at(from + Math.PI * i / N); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
    ctx.stroke();
    ctx.restore();
    // 尾巴：沿轨道往回拖一段，越往后越淡
    const [hx, hy, hz] = at(sat.ph), isFront = hz >= 0;
    const TAIL = 14, span = 0.95;
    for (let i = TAIL; i >= 1; i--) {
      const [ax, ay, az] = at(sat.ph - span * i / TAIL), [bx, by] = at(sat.ph - span * (i - 1) / TAIL);
      if ((az >= 0) !== front) continue;
      ctx.strokeStyle = col(INK, lerp(0.75, 0.55, lod) * (1 - i / TAIL) * A * (front ? 1 : 0.45));
      ctx.lineWidth = lerp(1.5, 2, lod) * (1 - i / TAIL * 0.7);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
    if (isFront !== front) continue;
    const d = lerp(2.6, 3.2, lod), da = A * (front ? 1 : 0.5);
    const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, d * 4);
    g.addColorStop(0, col(INK, lerp(0.5, 0.35, lod) * da)); g.addColorStop(1, col(INK, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hx, hy, d * 4, 0, TAU); ctx.fill();
    ctx.fillStyle = col(INK, 0.95 * da); ctx.beginPath(); ctx.arc(hx, hy, d, 0, TAU); ctx.fill();
  }
}

// ---- 子 agent 的小球（规则见 model.ts 的 syncSubs）
function drawSubs(S: Ring, x: number, y: number, r: number, alpha: number, lod: number, m: number, tp: number, solid: number) {
  if (!S.subs.size || alpha < 0.02) return;
  const { W, H } = V;
  const t = now(), [gx, gy] = scr(0, 0), ease = 1 - Math.exp(-F.frameDt / 0.25);
  const alive = subsAlive(S), shown = alive.slice(0, SUB_MAX), extra = alive.length - shown.length;
  const nFan = shown.length + (extra > 0 ? 1 : 0), out = Math.atan2(y - gy, x - gx);
  const fanAt = (i: number) => out + (i - (nFan - 1) / 2) * 0.62;   // 平时：在主球背对星系中心的一侧排成扇形
  // 放大时：在屏幕右边排成一列，细线从派出它的那根射线的尖上拉过来
  const colX = W - clamp(W * 0.085, 110, 150), gapY = Math.min(170, (H - 190) / Math.max(1, nFan));
  const colAt = (i: number) => [colX, H / 2 + (i - (nFan - 1) / 2) * gapY - 22];
  shown.forEach((A, i) => {
    const [px, py] = colAt(i), ao = fanAt(i);
    const tx = lerp(Math.cos(ao) * 2.9, (px - x) / r, m), ty = lerp(Math.sin(ao) * 2.9, (py - y) / r, m);
    if (A.fx == null || A.fy == null) { A.fx = tx; A.fy = ty; } else { A.fx += (tx - A.fx) * ease; A.fy += (ty - A.fy) * ease; }
  });
  const rs = Math.max(4.5, r * lerp(0.42, 0.16, m));
  for (const A of S.subs.values()) {
    if (A.fx == null || A.fy == null || (A.endAt == null && !shown.includes(A))) continue;
    const st = A.toolId ? S.byId.get(A.toolId) : undefined, g = st && st.g;
    const slotX = x + A.fx * r, slotY = y + A.fy * r, toward = Math.atan2(A.fy, A.fx);
    const ax = g ? g.x1 : x + Math.cos(toward) * r, ay = g ? g.y1 : y + Math.sin(toward) * r, back = !!(g && g.back);
    let sx = slotX, sy = slotY, rad = rs, a = 1, neck = 0;
    const qb = clamp((tp - A.bornAt) / SUB_BIRTH_MS, 0, 1);
    if (qb < 1) {   // 出生：先在射线尖上鼓起来，再被拉出去，颈越拉越细、断开
      const e = 1 - Math.pow(1 - smooth(0.12, 1, qb), 3);
      sx = lerp(ax, slotX, e); sy = lerp(ay, slotY, e);
      rad = rs * lerp(0.2, 1, smooth(0, 0.55, qb));
      neck = 1 - smooth(0.25, 0.5, qb);
    }
    if (A.endAt != null) {   // 结束：顺着细线收回去，越收越快、越小
      const q = clamp((tp - A.endAt) / SUB_BACK_MS, 0, 1), e = q * q;
      sx = lerp(slotX, ax, e); sy = lerp(slotY, ay, e); rad = rs * lerp(1, 0.2, e); a = 1 - smooth(0.82, 1, q);
      if (q >= 1 && !A.returned) {   // 交回结果：那根射线亮一下，主球荡开一圈
        A.returned = true;
        if (st) st.flashAt = tp;
        M.pings.push({ sid: S.sid, t0: tp, ink: true });
      }
    }
    const A0 = alpha * a, la = A0 * (back ? 0.45 : 1);
    const dx = sx - ax, dy = sy - ay, L = Math.hypot(dx, dy) || 1;
    if (neck > 0.01) {
      capsulePath(ax, ay, rad * 0.5 * neck, sx, sy, rad * 0.85);
      ctx.fillStyle = `rgba(13,14,17,${(solid * a).toFixed(3)})`; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = col(INK, 0.5 * la); ctx.stroke();
    }
    if (qb > 0.4 && qb < 0.9) {   // 断开的那一下
      const q = (qb - 0.4) / 0.5;
      ctx.lineWidth = 1; ctx.strokeStyle = col(INK, 0.6 * (1 - q) * la);
      ctx.beginPath(); ctx.arc(ax, ay, 2 + rs * 0.9 * q, 0, TAU); ctx.stroke();
    }
    // 细线：射线尖 → 小球边上，微微弯一点。在跑时上面有往回流的小点
    const tA = la * smooth(0.3, 0.6, qb);
    if (tA > 0.01 && L > rad + 2) {
      const ex = sx - dx / L * rad, ey = sy - dy / L * rad;
      const cx = (ax + ex) / 2 - dy * 0.12, cy = (ay + ey) / 2 + dx * 0.12;
      ctx.lineWidth = lerp(0.9, 1.2, m);
      ctx.strokeStyle = col(INK, 0.24 * tA);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, ex, ey); ctx.stroke();
      if (A.status === "working" || A.status === "waiting") {
        ctx.save();
        ctx.setLineDash([1.6, lerp(6, 9, m)]); ctx.lineDashOffset = tp / 45;
        ctx.lineWidth = lerp(1.3, 1.8, m); ctx.lineCap = "round";
        ctx.strokeStyle = A.status === "waiting" ? col(INK, 0.7 * tA) : col(CLAUDE, 0.75 * tA);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, ex, ey); ctx.stroke();
        ctx.restore();
      }
    }
    const hov = A === F.hoverSub;
    drawRing(A, sx, sy, rad * (hov ? 1.06 : 1), A0, 0, hov ? F.hoverSubStep : null, tp, solid * a, m);
    A.spot = { x: sx, y: sy, r: rad }; F.subSpots.set(A.sid, A.spot);
    // 放大时下面写着：类型、现在（或鼠标指着的）那一步、状态和耗时
    const ta = A0 * smooth(0.55, 1, m);
    if (ta > 0.02) {
      const hs = hov && F.hoverSubStep;
      const cur = hs ? { text: hs.phrase, err: hs.err, sub: hs.end == null ? fmtMs(t - hs.start) : fmtMs(hs.end - hs.start) + (hs.err ? " · " + (hs.errText || T.failed) : "") }
                     : currentStep(A, t);
      const ty0 = sy + rad * 1.8 + 6;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.font = `500 10.5px ${FONT}`; ctx.letterSpacing = "1.2px";
      ctx.fillStyle = col(INK, 0.5 * ta); ctx.fillText(fit(subTypeOf(A).toUpperCase(), 170), Math.round(sx), Math.round(ty0));
      ctx.letterSpacing = "0px";
      ctx.font = `400 12.5px ${FONT}`;
      ctx.fillStyle = col(cur.err ? ERR : INK, 0.92 * ta); ctx.fillText(fit(cur.text || "—", 180), Math.round(sx), Math.round(ty0 + 17));
      ctx.font = `400 11px ${FONT}`;
      ctx.fillStyle = col(INK, 0.45 * ta);
      ctx.fillText([hs ? "" : wordOf(A), cur.sub, A.steps.length ? T.steps(A.steps.length) : ""].filter(Boolean).join(" · "), Math.round(sx), Math.round(ty0 + 35));
    }
  }
  if (extra > 0) {   // 多出来的不画，只写个数
    const ao = fanAt(shown.length), [px, py] = colAt(shown.length);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `400 ${Math.round(clamp(rs * 1.1, 10, 14))}px ${FONT}`;
    ctx.fillStyle = col(INK, 0.55 * alpha);
    ctx.fillText(m > 0.5 ? T.moreSubagents(extra) : `+${extra}`, Math.round(lerp(x + Math.cos(ao) * r * 2.9, px, m)), Math.round(lerp(y + Math.sin(ao) * r * 2.9, py, m)));
  }
}

/** 这个球受光的方向（指向中心恒星的单位向量）。子 agent 跟着派出它的对话；都没有时按屏幕上的方向，算半边亮 */
function lightOf(S: Ring, x: number, y: number): [number, number, number] {
  const L = S.light ?? (S as Sub).parent?.light;
  if (L) return L;
  const [gx, gy] = scr(0, 0), d = Math.hypot(gx - x, gy - y);
  return d > 1 ? [(gx - x) / d, (gy - y) / d, 0] : [0, -1, 0];
}

// 一个球的射线按「背面 / 正面 × 亮度四档」分好桶，同一桶一次画完。桶在模块里复用，每个球开头清空。
// drawRing 会经由 drawSubs 再调自己（画子 agent），那时这个球已经用完了桶，所以共用一份没问题
const BUCKETS = { back: [[], [], [], []] as Seg[][], front: [[], [], [], []] as Seg[][], spBack: [] as Seg[], spFront: [] as Seg[] };

export function drawRing(S: Ring, x: number, y: number, r: number, alpha: number, lod: number, hover: Step | null, tp: number, solid: number, m: number) {
  if (alpha < 0.01) return;
  const t = now(), w3 = 1 - m;   // w3：还有多少是球
  const working = S.status === "working", waiting = S.status === "waiting", active = working || waiting;
  const lw = lerp(1, 1.3, lod);
  ctx.lineCap = "round";

  // ---- 每一步：一根细线，尖上一个点。耗时越长，线越长、点越大
  const Lmax = r * lerp(0.7, 0.58, lod), gap = Math.max(1.5, r * 0.04);
  const stemW = lerp(0.9, 1.1, lod), stemA = lerp(0.62, 0.4, lod), dotMax = clamp(r * S.slot * 0.36, 1.05, 4.4);
  const sweepP = (tp - S.sweepAt) / SWEEP_MS * 1.2 - 0.1, sweeping = sweepP > -0.1 && sweepP < 1.1;
  const n = S.steps.length;
  const { back, front, spBack, spFront } = BUCKETS;
  for (let b = 0; b < 4; b++) { back[b].length = 0; front[b].length = 0; }
  spBack.length = 0; spFront.length = 0;
  let hasLive = false;
  for (let i = 0; i < n; i++) {
    const s = S.steps[i], f = lerp(1, s.f, m);
    s.g = null;
    if (s.f < 0.505) continue;
    const live = s.end == null && active;
    if (live) hasLive = true;
    const ms = live ? t - s.start : (s.end == null ? 0 : s.end - s.start);
    const ls = s.f >= 0.8 ? lerp(0.3, 1, (s.f - 0.8) / 0.2) : lerp(0.26, 0.3, (s.f - 0.62) / 0.18);
    let al = s.f >= 0.8 ? lerp(0.5, 1, (s.f - 0.8) / 0.2) : s.f >= 0.62 ? lerp(0.28, 0.5, (s.f - 0.62) / 0.18) : lerp(0, 0.28, (s.f - 0.5) / 0.12);
    const grow = live ? 1 : smooth(0, 1, (tp - s.bornAt) / 260);
    const flash = clamp(1 - (tp - s.flashAt) / 650, 0, 1);
    const sw = sweeping ? Math.max(0, 1 - Math.abs(sweepP - (i + 0.5) / n) / 0.1) : 0;
    const g = lenFor(ms), L = Lmax * g * ls * grow * (1 + 0.14 * sw);
    const D = dirOf(s.lon, s.sl, s.cl, S.spin, s.a ?? 0, m), ux = D[0], uy = D[1], uz = D[2];
    const r0 = r * f + gap, r1 = r0 + L, near = (uz + 1) / 2;
    let d = dotMax * lerp(lerp(0.8, 0.5, lod), 1, g) * lerp(0.62, 1, ls) * (0.4 + 0.6 * grow);
    if (w3 > 0.001) {   // 球：朝你的一面亮、点大；背面暗；正对着你的那几根淡掉，别盖住圆心的数字
      al *= lerp(1, lerp(0.34, 1, near) * (uz > 0 ? smooth(0.3, 0.74, Math.hypot(ux, uy) * r1 / r) : 1), w3);
      d *= lerp(1, lerp(0.72, 1.18, near), w3);
    }
    // 每一步一个固定的 seg 对象，每帧原地改写（一个星系里上千步，每帧新建会让垃圾回收忙不过来）
    const seg = s.seg ??= { x0: 0, y0: 0, x1: 0, y1: 0, al: 0, s, live: false, flash: 0, sw: 0, d: 0, back: false };
    seg.x0 = x + ux * r0; seg.y0 = y + uy * r0; seg.x1 = x + ux * r1; seg.y1 = y + uy * r1;
    seg.al = al; seg.live = live; seg.flash = flash; seg.sw = sw; seg.d = d; seg.back = uz < -0.02 && w3 > 0.02;
    s.g = seg;
    if (al < 0.02 && !live) continue;
    if (live || s.err || flash > 0 || sw > 0 || hover === s) (seg.back && !live ? spBack : spFront).push(seg);
    else (seg.back ? back : front)[Math.min(3, Math.floor(al * 4))].push(seg);
  }
  const plainPass = (buckets: Seg[][]) => {
    for (let b = 0; b < 4; b++) {
      const list = buckets[b];
      if (!list.length) continue;
      const a = (b + 0.75) / 4;
      ctx.beginPath();
      for (const g of list) { ctx.moveTo(g.x0, g.y0); ctx.lineTo(g.x1, g.y1); }
      ctx.lineWidth = stemW; ctx.strokeStyle = col(COOL, stemA * a * alpha); ctx.stroke();
      ctx.beginPath();
      for (const g of list) { ctx.moveTo(g.x1 + g.d, g.y1); ctx.arc(g.x1, g.y1, g.d, 0, TAU); }
      ctx.fillStyle = col(COOL, 0.86 * a * alpha); ctx.fill();
    }
  };
  const specialPass = (list: Seg[]) => {
    for (const g of list) {
      const s = g.s, hov = hover === s;
      const line = () => { ctx.beginPath(); ctx.moveTo(g.x0, g.y0); ctx.lineTo(g.x1, g.y1); ctx.stroke(); };
      const dot = (rad: number) => { ctx.beginPath(); ctx.arc(g.x1, g.y1, rad, 0, TAU); };
      if (g.live) {   // 正在跑的这一步：转到背面也透出来，只是暗一些
        const la = alpha * (g.back ? 0.5 : 1);
        ctx.save();
        ctx.shadowColor = col(CLAUDE, 0.95 * la); ctx.shadowBlur = lerp(8, 18, lod);
        ctx.lineWidth = stemW + lerp(0.5, 1, lod); ctx.strokeStyle = col(waiting ? INK : CLAUDE, la); line();
        ctx.fillStyle = col(waiting ? INK : HOT, la); dot(g.d + lerp(0.7, 1.6, lod)); ctx.fill();
        ctx.restore();
        continue;
      }
      const base = s.err ? ERR : COOL;
      ctx.lineWidth = stemW + (hov ? 0.7 : s.err ? 0.3 : 0);
      ctx.strokeStyle = hov ? col(s.err ? ERR : INK, alpha) : col(base, (s.err ? 0.9 : stemA) * g.al * alpha); line();
      if (s.err && g.d >= 1.5) {   // 出错的那一步是空心点：不只靠颜色
        ctx.lineWidth = 1.3; ctx.strokeStyle = col(ERR, (hov ? 1 : 0.95 * g.al) * alpha); dot(g.d + 0.5); ctx.stroke();
      } else { ctx.fillStyle = hov ? col(s.err ? ERR : INK, alpha) : col(base, (s.err ? 0.95 : 0.86) * g.al * alpha); dot(g.d); ctx.fill(); }
      const over = Math.max(g.flash * 0.9, g.sw);
      if (over > 0 && !hov) {
        ctx.lineWidth = stemW + 0.4; ctx.strokeStyle = col(INK, over * g.al * alpha); line();
        ctx.fillStyle = col(INK, over * g.al * alpha); dot(g.d + 0.6 * over); ctx.fill();
      }
      if (hov) { ctx.lineWidth = 1; ctx.strokeStyle = col(s.err ? ERR : INK, 0.4 * alpha); dot(g.d + 5); ctx.stroke(); }
    }
  };

  if (waiting && !S.waitSub) for (let i = 0; i < 2; i++) {   // 等你：一圈圈向外的波纹（是子 agent 在等时，荡的是它）
    const p = (tp / 2600 + i * 0.5) % 1;
    ctx.beginPath(); ctx.arc(x, y, r * (1 + p * 0.95), 0, TAU);
    ctx.strokeStyle = col(INK, 0.5 * (1 - p) * alpha); ctx.lineWidth = lw; ctx.stroke();
  }
  plainPass(back); specialPass(spBack);   // 背面的先画，再被球体挡住
  drawSats(S, x, y, r, alpha, lod, m, tp, false);

  // ---- 球体：一块比背景亮一点的底；轨道线不从中间穿过去，前面的球也能挡住后面的
  ctx.fillStyle = `rgba(13,14,17,${solid.toFixed(3)})`;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  // 受光：光从中心的恒星照过来，看得到的亮面就是月相。转到恒星后面（远的一侧）是满月，转到你和恒星之间（近的一侧）是月牙
  let ldx = 0, ldy = -1;   // 光在屏幕上从哪个方向来（单位向量）；摊成表盘时用不上
  if (w3 > 0.02) {
    const [lx, ly, lz] = lightOf(S, x, y), lp = Math.hypot(lx, ly);
    if (lp > 1e-3) { ldx = lx / lp; ldy = ly / lp; }
    const a = Math.atan2(ldy, ldx);   // 弧和椭圆都按这个角度转过去，让光从它们的 +x 方向来
    ctx.beginPath();
    ctx.arc(x, y, r, a - Math.PI / 2, a + Math.PI / 2, false);                                  // 朝光那一侧的半边轮廓
    ctx.ellipse(x, y, Math.max(0.01, r * Math.abs(lz)), r, a, Math.PI / 2, -Math.PI / 2, lz < 0);   // 明暗交界线：亮面多于一半时往暗侧鼓
    const gx = x + ldx * r * 0.5, gy = y + ldy * r * 0.5, g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r * 1.5);
    g.addColorStop(0, col(INK, 0.14 * w3 * solid)); g.addColorStop(1, col(INK, 0.035 * w3 * solid));
    ctx.fillStyle = g; ctx.fill();
  }
  if (w3 < 0.98) {   // 摊成表盘时：淡淡的一层底光，不分明暗
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.2);
    g.addColorStop(0, col(INK, 0.055 * (1 - w3) * solid)); g.addColorStop(1, col(INK, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  if (w3 > 0.02) {   // 经纬线跟着自转，没有步骤的球也看得出在转
    ctx.lineWidth = 1; ctx.strokeStyle = col(INK, 0.085 * w3 * alpha);
    ctx.beginPath();
    const curve = (j: number) => {   // j < 0：赤道；否则第 j 条经线（连同对面那半条，绕一整圈）
      let pen = false;
      for (let i = 0; i <= 28; i++) {
        const u = i / 28 * TAU;
        let lon = u, lat = 0;
        if (j >= 0) { lon = j * Math.PI / 2 + (u > Math.PI ? Math.PI : 0); lat = u > Math.PI ? 1.5 * Math.PI - u : u - Math.PI / 2; }
        const D = dirOf(lon, Math.sin(lat), Math.cos(lat), S.spin, 0, 0);
        if (D[2] < 0) { pen = false; continue; }
        if (pen) ctx.lineTo(x + D[0] * r, y + D[1] * r); else ctx.moveTo(x + D[0] * r, y + D[1] * r);
        pen = true;
      }
    };
    curve(-1);
    for (let j = 0; j < 2; j++) curve(j);
    ctx.stroke();
  }
  const edge = (active ? 0.62 : S.status === "done" ? 0.46 : 0.34) * alpha, tone = S.status === "error" ? ERR : INK;
  if (w3 > 0.02) {   // 轮廓也是朝着恒星的一侧亮、背着的一侧暗
    const g = ctx.createLinearGradient(x + ldx * r * 0.7, y + ldy * r * 0.7, x - ldx * r * 0.7, y - ldy * r * 0.7);
    g.addColorStop(0, col(tone, edge * lerp(1, 1.3, w3))); g.addColorStop(1, col(tone, edge * lerp(1, 0.5, w3)));
    ctx.strokeStyle = g;
  } else ctx.strokeStyle = col(tone, edge);
  ctx.lineWidth = lw;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
  // ---- 在想：球边从里面透出珊瑚色的光，一道彗星沿着球边转。远看也认得出（等你是白波纹，动手是亮起的那根线）
  const thinking = working && !hasLive && !bgOnly(S);
  S.thinkK = (S.thinkK || 0) + ((thinking ? 1 : 0) - (S.thinkK || 0)) * (1 - Math.exp(-F.frameDt / 0.25));
  if (S.thinkK > 0.01) {
    const k = S.thinkK * alpha * lerp(1, 0.5, lod), b = 0.5 + 0.5 * Math.sin(tp / 380);
    const gl = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
    gl.addColorStop(0, col(CLAUDE, 0)); gl.addColorStop(0.7, col(CLAUDE, (0.05 + 0.07 * b) * k)); gl.addColorStop(1, col(CLAUDE, (0.16 + 0.16 * b) * k));
    ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    if (S.thinkPh == null) S.thinkPh = rand(0, TAU);   // 各转各的，不齐步
    const head = S.thinkPh + tp / 1400 * TAU, len = 2.1, R = r + lw + 0.5;
    const cg = ctx.createConicGradient(head - len, x, y);
    cg.addColorStop(0, col(CLAUDE, 0)); cg.addColorStop(len / TAU, col(CLAUDE, 0.95 * k)); cg.addColorStop(len / TAU + 0.002, col(CLAUDE, 0));
    ctx.save();
    ctx.lineWidth = lerp(1.8, 2.2, lod); ctx.strokeStyle = cg;
    ctx.shadowColor = col(CLAUDE, 0.8 * k); ctx.shadowBlur = lerp(6, 12, lod);
    ctx.beginPath(); ctx.arc(x, y, R, head - len, head); ctx.stroke();
    ctx.fillStyle = col(HOT, k); ctx.beginPath(); ctx.arc(x + Math.cos(head) * R, y + Math.sin(head) * R, lerp(1.4, 2, lod), 0, TAU); ctx.fill();
    ctx.restore();
  }
  for (let k = 1; k <= 2; k++) {
    const a = clamp(S.ringsAnim - (k - 1), 0, 1) * [0, 0.14, 0.08][k] * alpha * m;
    if (a > 0.004) { ctx.strokeStyle = col(INK, a); ctx.beginPath(); ctx.arc(x, y, r * RING_F[k], 0, TAU); ctx.stroke(); }
  }

  plainPass(front); specialPass(spFront);
  drawSats(S, x, y, r, alpha, lod, m, tp, true);

  // ---- 随机的闪烁：某一步的点亮一下，荡开一个小圈。只是气氛，所以用中性的白，不占珊瑚色
  for (let i = S.twinkles.length - 1; i >= 0; i--) {
    const tw = S.twinkles[i], q = (tp - tw.t0) / 1100, g = tw.s.g;
    if (q >= 1 || !g) { if (q >= 1 || !S.byId.has(tw.s.id)) S.twinkles.splice(i, 1); continue; }
    if (g.back || g.live) continue;
    const a = Math.sin(Math.min(1, q * 2.2) * Math.PI / 2) * (1 - q) * alpha * Math.max(0.5, g.al);
    ctx.fillStyle = col(INK, 0.95 * a); ctx.beginPath(); ctx.arc(g.x1, g.y1, g.d + 0.5, 0, TAU); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = col(INK, 0.6 * a);
    ctx.beginPath(); ctx.arc(g.x1, g.y1, g.d + 1.5 + lerp(5, 9, lod) * (1 - (1 - q) * (1 - q)), 0, TAU); ctx.stroke();
  }

  if (working && !hasLive && !bgOnly(S)) {   // 在想：下一步要落的位置上有个呼吸的点
    const b = 0.5 + 0.5 * Math.sin(tp / 380);
    const [ux, uy, uz] = dirOf(S.nextLon, S.nextSl, S.nextCl, S.spin, S.curA, m);
    const ca = alpha * (uz < 0 ? lerp(1, 0.45, w3) : 1);
    ctx.save();
    ctx.shadowColor = col(CLAUDE, 0.9 * ca); ctx.shadowBlur = lerp(8, 16, lod);
    ctx.fillStyle = col(CLAUDE, (0.65 + 0.35 * b) * ca);
    ctx.beginPath(); ctx.arc(x + ux * r, y + uy * r, lerp(1.8, 3.4, lod) + b * lerp(0.8, 1.6, lod), 0, TAU); ctx.fill();
    ctx.restore();
  }

  drawSubs(S, x, y, r, alpha, lod, m, tp, solid);

  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  // 小球：圆心只有圈数，底下垫一小块暗色
  const miniA = (1 - smooth(0, 0.5, Math.max(lod, cam.f))) * alpha * (active ? 0.9 : 0.42);
  if (miniA > 0.02 && r >= 12 && S.lapsShown > 0) {
    // 滚轮放大近看时数字不跟着无限变大（也不拿暗底盖住整个球）：按半径 40 封顶。点进去飞向表盘时照旧跟着放大、淡掉
    const rn = lerp(Math.min(r, 40), r, smooth(0, 0.3, cam.f));
    const g = ctx.createRadialGradient(x, y, 0, x, y, rn * 0.72);
    g.addColorStop(0, `rgba(13,14,17,${(0.9 * solid).toFixed(3)})`); g.addColorStop(0.6, `rgba(13,14,17,${(0.7 * solid).toFixed(3)})`); g.addColorStop(1, "rgba(13,14,17,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rn * 0.72, 0, TAU); ctx.fill();
    ctx.font = `300 ${Math.round(rn * (S.lapsShown > 99 ? 0.56 : 0.72))}px ${FONT}`;
    ctx.fillStyle = col(INK, miniA); ctx.fillText(String(S.lapsShown), Math.round(x), Math.round(y + rn * 0.04));
  }
  if (lod < 0.02) return;

  // ---- 详情：状态、圈数、当前（或鼠标指着的）那一步
  const ta = lod * alpha;
  const u = r * (S.ringsAnim > 1.5 ? 0.57 : S.ringsAnim > 0.5 ? 0.75 : 0.9);
  let word = wordOf(S), wordCol = working && !bgOnly(S) ? col(CLAUDE, ta) : col(INK, 0.55 * ta), cur;
  if (hover) {
    word = T.lap(hover.lap); wordCol = col(INK, 0.55 * ta);
    cur = { text: hover.phrase, err: hover.err,
            sub: hover.end == null ? (active ? fmtMs(t - hover.start) : "") : fmtMs(hover.end - hover.start) + (hover.err ? " · " + (hover.errText || T.failed) : "") };
  } else cur = currentStep(S, t);
  ctx.font = `400 ${Math.round(clamp(u * 0.075, 11, 15))}px ${FONT}`;
  ctx.fillStyle = wordCol; ctx.fillText(word, x, y - u * 0.5);
  ctx.font = `200 ${Math.round(u * 0.5)}px ${FONT}`;
  ctx.fillStyle = col(INK, ta); ctx.fillText(String(S.lapsShown), x, y - u * 0.12);
  ctx.font = `400 ${Math.round(clamp(u * 0.07, 11, 14))}px ${FONT}`;
  ctx.fillStyle = col(INK, 0.5 * ta); ctx.fillText(T.lapsUnder(S.lapsShown, Math.max(S.stepsTotal, S.steps.length)), x, y + u * 0.2);
  if (cur.text) {
    ctx.font = `400 ${Math.round(clamp(u * 0.085, 12, 17))}px ${FONT}`;
    ctx.fillStyle = col(cur.err ? ERR : INK, 0.95 * ta); ctx.fillText(fit(cur.text, u * 1.55), x, y + u * 0.44);
    ctx.font = `400 ${Math.round(clamp(u * 0.07, 11, 14))}px ${FONT}`;
    ctx.fillStyle = col(INK, 0.5 * ta); ctx.fillText(fit(cur.sub, u * 1.55), x, y + u * 0.6);
  }
}

// ---- 背景
// 尘埃按开普勒转：w 是角速度（乘公转时钟），同一半径同一速度，越外越慢。al 是不透明度
export const dust = Array.from({ length: 240 }, () => {
  const r = Math.pow(Math.random(), 0.6) * 1.3;
  return { r, th: rand(0, TAU), w: 0.008 / Math.pow(0.3 + r, 1.5), size: rand(0.6, 1.6), al: rand(0.04, 0.256), deep: rand(0.4, 1.8) };
});
// 雾：几条很淡的横向光带，一半在最后面，一半压在远处的环前面
const FOG = [{ x: -0.55, y: -0.62, w: 1.0, h: 0.2, a: 0.065, sp: 0.021, ph: 0.3, layer: 0 },
             { x: 0.5, y: -0.3, w: 0.9, h: 0.16, a: 0.055, sp: 0.017, ph: 1.9, layer: 1 },
             { x: 0.1, y: -0.95, w: 1.3, h: 0.16, a: 0.05, sp: 0.011, ph: 0.9, layer: 0 },
             { x: -0.25, y: 0.2, w: 1.2, h: 0.2, a: 0.05, sp: 0.013, ph: 4.0, layer: 1 },
             { x: 0.65, y: 0.62, w: 1.0, h: 0.24, a: 0.06, sp: 0.019, ph: 2.6, layer: 0 },
             { x: -0.75, y: 0.9, w: 0.9, h: 0.22, a: 0.055, sp: 0.015, ph: 5.2, layer: 0 }];
const FOGC = "186,196,216";

export function drawFog(layer: number, tp: number, alpha: number, parx: number, pary: number) {
  for (const b of FOG) {
    if (b.layer !== layer) continue;
    const wx = (b.x + 0.09 * Math.sin(tp / 1000 * b.sp * 6 + b.ph)) * view.rout, wy = b.y * view.rout * view.tilt;
    const [x, y] = scr(wx, wy), R = b.w * view.rout * Math.exp(cam.lz);
    ctx.save();
    ctx.translate(x + parx * 0.5, y + pary * 0.5); ctx.scale(1, b.h / b.w);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, col(FOGC, b.a * alpha)); g.addColorStop(0.5, col(FOGC, b.a * 0.4 * alpha)); g.addColorStop(1, col(FOGC, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.restore();
  }
}

export type { Session, Sub };
