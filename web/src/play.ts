// 演示站：在浏览器里播放编好的剧本（web/src/demo/script.json，由 tools/demo/build.mjs 从剧本展开），不连任何服务器。
// 剧本是事件流，和本机模式下插件发的同一种格式；这里把它喂给和服务器同一份的状态机（shared/src/state.ts），
// 再拼出和服务器一样的消息（概要层、细节层、大附件）交给页面。所以画面走的是和真实数据完全相同的路径。
//
// 每段对话从 SessionStart 开始，之后它的那几轮一直循环：每循环一次，工具、prompt、子 agent 的编号换一套，
// 状态机看到的就是一轮轮新的对话。打开页面时先快进一段，画面一开始就是热闹的。
import { Galaxy, fullKey, slotsOf, type ServerMsg, type SummaryRow } from "@agent-loop/shared/browser";
import type { Event } from "@agent-loop/shared";
import script from "./demo/script.json";

interface ScriptSession { start: number; first: Event; cycle: { at: number; ev: Event }[]; period: number; outPer: number }
interface ScriptGalaxy { id: string; sessions: ScriptSession[] }

/** 打开页面时快进多少（毫秒）：大部分对话已经出场、跑了一两轮 */
const WARM_MS = 75_000;

interface Track { s: ScriptSession; g: Galaxy; started: boolean; loop: number; i: number; base: number }

export function startPlayback(send: (m: ServerMsg) => void) {
  const t0 = Date.now() - WARM_MS;
  // 剧本里的星系没有名字：每次打开换一套随机编号，名字就是由编号生成的星表编号（galaxyName），每次都不一样
  const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  const gals = (script.galaxies as unknown as ScriptGalaxy[]).map(() => { const id = randomId(); return { id, g: new Galaxy(id, t0) }; });
  const tracks: Track[] = [];
  (script.galaxies as unknown as ScriptGalaxy[]).forEach((sg, i) => {
    for (const s of sg.sessions) tracks.push({ s, g: gals[i].g, started: false, loop: 0, i: 0, base: t0 + s.start });
  });
  const full = new Map<string, object | string>();
  let focus: string | null = null;
  const lastRows = new Map<string, string>();

  /** 第 k 次循环：编号换一套（加一个后缀），状态机就把它当成新的一轮、新的步骤 */
  const remap = (ev: Event, k: number, outPer: number): Event => {
    if (!k) return ev;
    const sfx = (id?: string) => (id ? id.slice(0, 12) + k.toString(16).padStart(4, "0") : id);
    // 累计输出的 token 数接着上一次循环往上加
    const out_tok = ev.out_tok != null ? ev.out_tok + k * outPer : undefined;
    return { ...ev, tool: sfx(ev.tool), prompt: sfx(ev.prompt), agent: sfx(ev.agent), out_tok } as Event;
  };

  const feed = (g: Galaxy, ev: Event, t: number) => {
    const e = { ...ev, ts: t } as Event;
    g.handle(e, t);
    if (e.detail_full !== undefined && e.detail_full !== null) {
      const slot = slotsOf(e).full;
      if (slot) {
        full.set(`${g.id}|${fullKey(slot.sid, slot.slot, slot.k)}`, typeof e.detail_full === "object" ? e.detail_full : String(e.detail_full));
        if (full.size > 3000) full.delete(full.keys().next().value!);
      }
    }
  };

  /** 把剧本推进到 now */
  const advance = (now: number) => {
    for (const tr of tracks) {
      if (!tr.started) {
        if (now < tr.base) continue;
        feed(tr.g, tr.s.first, tr.base);
        tr.started = true;
      }
      for (let guard = 0; guard < 5000; guard++) {
        const c = tr.s.cycle[tr.i];
        if (!c) { tr.loop++; tr.i = 0; tr.base += tr.s.period; continue; }
        const at = tr.base + c.at;
        if (at > now) break;
        feed(tr.g, remap(c.ev, tr.loop, tr.s.outPer || 0), at);
        tr.i++;
      }
    }
  };

  const summary = (fullRows: boolean) => {
    const rows: SummaryRow[] = [];
    for (const { id, g } of gals) {
      if (!g.sessions.size) continue;
      const row = g.summary(), key = JSON.stringify(row);
      if (!fullRows && lastRows.get(id) === key) continue;
      lastRows.set(id, key); rows.push(row);
    }
    send({ t: "sum", now: Date.now(), full: fullRows, rows, gone: [] });
  };

  // 快进：每 100 毫秒走一步，看门狗也跟着走，和服务器上一样
  for (let t = t0; t < Date.now(); t += 100) { advance(t); if ((t - t0) % 500 < 100) for (const { g } of gals) g.watchdog(t); }
  for (const { g } of gals) g.discardDelta();
  send({ t: "hello", now: Date.now(), local: false, open: false });
  summary(true);

  let lastSum = Date.now(), lastDog = Date.now();
  const tick = () => {
    const now = Date.now();
    advance(now);
    if (now - lastDog >= 500) { lastDog = now; for (const { g } of gals) g.watchdog(now); }
    for (const { id, g } of gals) {
      if (id !== focus) { g.discardDelta(); continue; }
      const d = g.delta();
      if (d) send({ t: "gal", now, id, full: false, ...d });
    }
    if (now - lastSum >= 1000) { lastSum = now; summary(false); }
  };
  setInterval(tick, 100);

  return {
    setFocus(id: string | null) {
      focus = id;
      const g = gals.find(x => x.id === id)?.g;
      if (g) { g.discardDelta(); send({ t: "gal", now: Date.now(), id: g.id, full: true, galaxy: g.full() }); }
    },
    full: async (sid: string, slot: string, k: string) => (focus ? full.get(`${focus}|${fullKey(sid, slot, k)}`) ?? null : null),
  };
}
