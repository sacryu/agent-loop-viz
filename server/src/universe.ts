// 服务器里的全部星系，按星系群分开。负责接收前的最后几道关（限流、时钟、乱序重排）、看门狗、清理、概要层和大附件。
// 一切都只在内存里：不落盘，重启即清空。IP 只用于限流，不保存、不显示、不打日志。
//
// 星系群不需要在服务器上注册：编号由口令算出来（sha256(口令) 的前 32 个十六进制字符），第一条事件到达时星系群就存在了。
// 本机模式只有一个固定的隐含星系群 LOCAL_GROUP，不需要口令。
import { createHash } from "node:crypto";
import { isIPv6 } from "node:net";
import { ID_HEX, PLUGIN_NAG_BELOW, pluginOutdated, slotsOf, type Event, type SummaryRow } from "@agent-loop/shared";
import { FullStore } from "./fullstore.ts";
import { DEFAULT_LIMITS, Galaxy, type Limits } from "@agent-loop/shared";

export const LOCAL_GROUP = "local";
/** 插件旧了的记录：这么久没再收到它的上报就忘掉 */
export const OLD_PLUGIN_MS = 30 * 60_000;
/** 星系退出星系群以后，这么久之内它发到这个群的事件丢掉（见 Universe.leave） */
export const LEFT_MS = 15_000;
/**
 * 大附件超了服务器总量以后，丢到比上限低这么多（见 Universe.evictFull）：上限的 1%，至少 1MB，
 * 默认的 256MB 下是 2.56MB，再存进五十多个最大的（48KB）大附件才会再扫一次所有安装。上限调得很小时（自己部署、测试）
 * 1MB 会把大半甚至全部丢掉，所以不超过上限的四分之一
 */
export function fullSlack(cap: number): number {
  return Math.min(Math.max(1024 * 1024, cap / 100), cap / 4);
}

export interface UniverseOptions {
  maxGalaxies: number;          // 星系总数上限：满了对新安装返回 503
  maxGroups: number;            // 星系群总数上限：满了对新的星系群返回 503
  maxPerGroup: number;          // 每个星系群最多几个星系
  /** 白名单：只接受这些星系群（自己部署时用）。null 表示开放：任何口令都接受（官网） */
  groups: Set<string> | null;
  newInstallsPerIpPerMin: number;
  newGroupsPerIpPerHour: number; // 开放模式：每个 IP 每小时最多新建几个星系群
  groupIdleMs: number;          // 开放模式：星系群满了时，这么久没有事件的星系群可以被新的挤掉
  ratePerSec: number;           // 每个安装每秒多少条
  burst: number;                // 每个安装的突发上限
  reorderMs: number;            // 每个会话的重排缓冲
  galaxyEmptyMs: number;        // 星系里没有会话以后多久移除
  maxFullBytes: number;         // 单个大附件的上限（字节）。0 表示不收大附件
  fullPerGalaxyBytes: number;   // 每个星系的大附件总量上限，满了丢最旧的
  fullTotalBytes: number;       // 整个服务器的大附件总量上限，超了从占得最多的星系里丢最旧的，丢到比上限低一截（fullSlack；开放模式下防止被灌满内存）
  limits: Limits;
}

export const DEFAULT_OPTIONS: UniverseOptions = {
  maxGalaxies: 5000, maxGroups: 1000, maxPerGroup: 50, groups: null,
  newInstallsPerIpPerMin: 20, newGroupsPerIpPerHour: 10, groupIdleMs: 30 * 60_000, ratePerSec: 50, burst: 200, reorderMs: 200,
  galaxyEmptyMs: 10 * 60_000, maxFullBytes: 48 * 1024, fullPerGalaxyBytes: 8 * 1024 * 1024, fullTotalBytes: 256 * 1024 * 1024,
  limits: DEFAULT_LIMITS,
};

interface Pending { ev: Event; recv: number; seq: number }

/** 一个安装：令牌桶、时钟偏移、每个会话一个按 ts 排序的重排队列、大附件 */
class Install {
  tokens: number;
  last: number;
  offsets: number[] = [];
  offset = 0;
  queues = new Map<string, Pending[]>();
  full: FullStore;
  /** 服务器最近一次收到它的事件的时刻（服务器的钟，不是对方报的 ts） */
  seen: number;
  constructor(public galaxy: Galaxy, public group: string, burst: number, t: number, fullCap: number, fullTotal: { bytes: number }) {
    this.tokens = burst; this.last = t; this.seen = t; this.full = new FullStore(fullCap, fullTotal);
    galaxy.onRemove = sid => this.full.dropSession(sid);
  }

  take(now: number, rate: number, burst: number): boolean {
    this.tokens = Math.min(burst, this.tokens + (now - this.last) / 1000 * rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** 各人机器的时钟不准：偏移量取近期「服务器收到时间减 ts」的最小值（最小的那个网络延迟最接近真实偏差） */
  sample(recv: number, ts: number) {
    this.offsets.push(recv - ts);
    if (this.offsets.length > 64) this.offsets.shift();
    this.offset = Math.min(...this.offsets);
  }
}

/** lastRows：有人看的群上次发出去的概要（星系编号 → rowKey）。没人看的群是空的 */
interface Group { id: string; members: Set<string>; lastRows: Map<string, string> }

/** 概要的一行里会变的部分，用来比较变没变 */
const rowKey = (row: SummaryRow) => row[1] + "|" + row[2] + "|" + (row[3] ? JSON.stringify(row[3]) : "");

export type AcceptResult = 204 | 403 | 429 | 503;

/**
 * 限流用的地址。IPv6 按 /64 算：一个用户手里通常是一整个 /64（2^64 个地址），按单个地址限流等于没限。
 * IPv4 映射的 IPv6 地址（::ffff:1.2.3.4）按 IPv4 算。认不出的原样返回
 */
export function rateKey(ip: string): string {
  const s = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return mapped[1];
  if (!isIPv6(s)) return s;
  // 展开 ::，取前 4 组。末尾点分的 IPv4 占两组
  const groups = (part: string) => part.split(":").filter(Boolean).flatMap(x => (x.includes(".") ? ["0", "0"] : [x]));
  const [head, tail] = s.includes("::") ? s.split("::") : [s, ""];
  const h = groups(head), t = groups(tail);
  const all = [...h, ...new Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return all.slice(0, 4).map(x => (parseInt(x, 16) || 0).toString(16)).join(":") + "::/64";
}

/** 统一的出口：事件经过校验、重排之后，交给状态机之前，都从这里过（落盘、回放以后接在这里） */
export type EventSink = (group: string, galaxy: string, ev: Event, t: number) => void;

/** 一条事件里能存下的大附件 */
type FullItem = { slot: NonNullable<ReturnType<typeof slotsOf>["full"]>; box: string | object; n: number };

/** 每个 IP 在一个时间窗里做了几次（新安装、新建群）：窗口从第一次算起，过了 ms 重新数 */
class IpWindow {
  private m = new Map<string, { n: number; since: number }>();
  constructor(private ms: number) {}
  /** 这个窗口里已经到了 max 次 */
  full(ip: string, now: number, max: number): boolean {
    const w = this.m.get(ip);
    return !!w && now - w.since < this.ms && w.n >= max;
  }
  bump(ip: string, now: number) {
    const w = this.m.get(ip);
    if (!w || now - w.since >= this.ms) this.m.set(ip, { n: 1, since: now }); else w.n += 1;
  }
  prune(now: number) {
    for (const [ip, w] of this.m) if (now - w.since >= this.ms) this.m.delete(ip);
  }
}

export class Universe {
  opt: UniverseOptions;
  installs = new Map<string, Install>();   // 星系编号 → 安装
  groups = new Map<string, Group>();       // 星系群编号 → 群里的星系
  private ipNew = new IpWindow(60_000);
  private ipGroups = new IpWindow(3600_000);
  private seq = 0;
  events = 0;
  // 最近 10 秒每秒收到多少条：10 个按秒的格子轮着用
  private evBins = new Array<number>(10).fill(0);
  private evBinSec = new Array<number>(10).fill(-1);
  /** 本机的原样事件（调试页用），只在本机模式下有 */
  rawLog: { seq: number; t: number; galaxy: string; ev: Event }[] = [];
  private rawSeq = 0;
  keepRaw = false;
  onRaw?: (x: { seq: number; t: number; galaxy: string; ev: Event }) => void;
  onEvent?: EventSink;
  /** 所有星系的大附件加起来占了多少字节 */
  fullTotal = { bytes: 0 };
  /** 插件旧了的星系：星系群编号 → (星系编号 → 插件版本、最近一次上报)。事件因为协议对不上被拒的旧插件也记，
   *  所以和 installs 分开：它们可能根本进不了星系群 */
  oldPlugins = new Map<string, Map<string, { v: string; seen: number }>>();
  /** 刚退出的：「星系群编号|星系编号」→ 退出的时刻 */
  private left = new Map<string, number>();

  constructor(opt: Partial<UniverseOptions> = {}) {
    this.opt = { ...DEFAULT_OPTIONS, ...opt, limits: { ...DEFAULT_LIMITS, ...(opt.limits || {}) } };
  }

  /** sha256 的前 32 个十六进制字符 */
  private static idOf(x: string): string {
    return createHash("sha256").update(x).digest("hex").slice(0, ID_HEX);
  }
  /** 星系编号：由安装密钥算出 */
  static galaxyIdOf(secret: string): string { return Universe.idOf(secret); }
  /** 星系群编号：由口令算出。口令推不回邀请链接里的密钥 */
  static groupIdOf(access: string): string { return Universe.idOf(access); }

  galaxy(id: string): Galaxy | undefined { return this.installs.get(id)?.galaxy; }
  groupOf(galaxyId: string): string | undefined { return this.installs.get(galaxyId)?.group; }
  /** 白名单模式下，这个星系群让不让进 */
  allowed(group: string): boolean { return group === LOCAL_GROUP || !this.opt.groups || this.opt.groups.has(group); }

  /**
   * 一次上报带来的插件版本（v 为空：旧插件没带）。在 schema 校验之前调用，协议变了的旧插件也能被认出来。
   * 只在口令（本机模式下是本机）验过以后调用；条数有上限，过了 OLD_PLUGIN_MS 没再上报就忘掉
   */
  notePlugin(group: string, galaxyId: string, v: string, now: number) {
    if (!this.allowed(group) || this.justLeft(group, galaxyId, now)) return;
    const m = this.oldPlugins.get(group);
    if (!pluginOutdated(v, PLUGIN_NAG_BELOW)) {
      if (m?.delete(galaxyId) && !m.size) this.oldPlugins.delete(group);
      return;
    }
    if (m) {
      if (!m.has(galaxyId) && m.size >= this.opt.maxPerGroup) return;
      m.set(galaxyId, { v, seen: now });
    } else if (this.oldPlugins.size < this.opt.maxGroups) {
      this.oldPlugins.set(group, new Map([[galaxyId, { v, seen: now }]]));
    }
  }

  /** 一个星系群里插件旧了的星系，按编号排好 */
  outdated(group: string): [string, string][] {
    const m = this.oldPlugins.get(group);
    return m ? [...m].map(([id, x]): [string, string] => [id, x.v]).sort((a, b) => (a[0] < b[0] ? -1 : 1)) : [];
  }

  /**
   * 星系自己退出星系群（插件的 /agent-loop:leave）：马上从群里移走，连同存着的大附件。
   * 只能移走自己：要带安装密钥（galaxyId 由它算出）和这个群的口令。不在这个群里就什么都不做。
   * 之后 LEFT_MS 内这个星系发到这个群的事件照单收下但丢掉：退出那一刻已经在路上的 hook（比如敲命令时的
   * UserPromptSubmit）晚到一步，不能把星系又带回群里。只在确实移走了星系时才记，所以记录数不超过星系数
   */
  leave(group: string, galaxyId: string, now: number) {
    this.oldPlugins.get(group)?.delete(galaxyId);
    if (this.oldPlugins.get(group)?.size === 0) this.oldPlugins.delete(group);
    if (this.installs.get(galaxyId)?.group !== group) return;
    this.removeInstall(galaxyId);
    this.left.set(`${group}|${galaxyId}`, now);
  }

  private justLeft(group: string, galaxyId: string, now: number): boolean {
    const t = this.left.get(`${group}|${galaxyId}`);
    return t != null && now - t < LEFT_MS;
  }

  /** 一条已通过 schema 校验的事件。返回 HTTP 状态码 */
  accept(group: string, galaxyId: string, ev: Event, addr: string, now: number): AcceptResult {
    if (!this.allowed(group)) return 403;
    if (this.justLeft(group, galaxyId, now)) return 204;
    let ins = this.installs.get(galaxyId);
    const moving = !!ins && ins.group !== group;
    if (!ins || moving) {
      // 新的安装，或者换了星系群（粘了一条新的邀请链接）。先看新的群放不放得下，放得下才从原来的群里搬出来
      const ip = rateKey(addr);
      if (!moving && this.installs.size >= this.opt.maxGalaxies) return 503;
      let g = this.groups.get(group);
      // 开放模式下建群不需要注册，所以要另外设限：每个 IP 每小时新建的群数；群满了时只挤掉闲着的
      const creating = (!g || !g.members.size) && !this.opt.groups && group !== LOCAL_GROUP;
      let evict: Group | null = null;
      if ((!g || !g.members.size) && this.liveGroups() >= this.opt.maxGroups) {
        evict = creating ? this.idleGroup(now) : null;
        if (!evict) return 503;
      }
      if (g && g.members.size >= this.opt.maxPerGroup) return 503;
      if (this.ipNew.full(ip, now, this.opt.newInstallsPerIpPerMin)) return 429;
      if (creating && this.ipGroups.full(ip, now, this.opt.newGroupsPerIpPerHour)) return 429;
      this.ipNew.bump(ip, now);
      if (creating) this.ipGroups.bump(ip, now);
      if (evict) for (const id of [...evict.members]) this.removeInstall(id);
      if (moving) { this.removeInstall(galaxyId); g = this.groups.get(group); }
      if (!g) { g = { id: group, members: new Set(), lastRows: new Map() }; this.groups.set(group, g); }
      ins = new Install(new Galaxy(galaxyId, now, this.opt.limits), group, this.opt.burst, now, this.opt.fullPerGalaxyBytes, this.fullTotal);
      this.installs.set(galaxyId, ins);
      g.members.add(galaxyId);
    }
    if (!ins.take(now, this.opt.ratePerSec, this.opt.burst)) return 429;
    ins.seen = now;
    ins.sample(now, ev.ts);
    let q = ins.queues.get(ev.sid);
    if (!q) { q = []; ins.queues.set(ev.sid, q); }
    // 按 ts 插入（同一毫秒按到达先后）
    const item = { ev, recv: now, seq: ++this.seq };
    let i = q.length;
    while (i > 0 && (q[i - 1].ev.ts > ev.ts || (q[i - 1].ev.ts === ev.ts && q[i - 1].seq > item.seq))) i--;
    q.splice(i, 0, item);
    this.events++;
    const sec = Math.floor(now / 1000), b = sec % 10;
    if (this.evBinSec[b] !== sec) { this.evBinSec[b] = sec; this.evBins[b] = 0; }
    this.evBins[b]++;
    if (this.keepRaw && ev.raw !== undefined) {
      const x = { seq: ++this.rawSeq, t: now, galaxy: galaxyId, ev };
      this.rawLog.push(x);
      if (this.rawLog.length > 600) this.rawLog.shift();
      this.onRaw?.(x);
    }
    return 204;
  }

  /** 里面还有星系的星系群有几个（有人看的群走光了要等下一次概要推送才从表里删掉，不算数） */
  private liveGroups(): number {
    let n = 0;
    for (const g of this.groups.values()) if (g.members.size) n++;
    return n;
  }

  /** 闲得最久的星系群：所有星系都超过 groupIdleMs 没有事件。没有就返回 null */
  private idleGroup(now: number): Group | null {
    let best: Group | null = null, bestAt = Infinity;
    for (const g of this.groups.values()) {
      if (!g.members.size || g.id === LOCAL_GROUP) continue;
      let last = 0;
      for (const id of g.members) {
        const ins = this.installs.get(id);
        if (ins) last = Math.max(last, ins.seen);
      }
      if (now - last > this.opt.groupIdleMs && last < bestAt) { best = g; bestAt = last; }
    }
    return best;
  }

  private removeInstall(id: string) {
    const ins = this.installs.get(id);
    if (!ins) return;
    ins.full.clear();
    this.installs.delete(id);
    const g = this.groups.get(ins.group);
    if (g) { g.members.delete(id); if (!g.members.size && !g.lastRows.size) this.groups.delete(g.id); }
  }

  /** 把重排缓冲里到期的事件交给状态机：队首（ts 最小）收到后满 reorderMs 才放行。
   *  任何 ts 更小的事件都最晚在 ts + 延迟上限 到达，所以晚到不超过 reorderMs 的乱序都能排回来。 */
  flush(now: number) {
    for (const [gid, ins] of this.installs) {
      for (const [sid, q] of ins.queues) {
        while (q.length && now - q[0].recv >= this.opt.reorderMs) {
          const { ev: got } = q.shift()!;
          const t = got.ts + ins.offset;
          this.onEvent?.(ins.group, gid, got, t);
          // 存不下的大附件先从事件上去掉：状态机见到大附件才把那一步标成能点开，不能标了却取不到
          const full = this.fullOf(got);
          const ev = full || (got.detail_full === undefined && got.enc_full === undefined) ? got
            : { ...got, detail_full: undefined, enc_full: undefined };
          ins.galaxy.handle(ev, t);
          if (full) this.keepFull(ins, ev, full);
        }
        if (!q.length) ins.queues.delete(sid);
      }
    }
  }

  /** 事件里的大附件能不能存：有对应的槽、没超过单个的上限。能存就返回要存的东西和字节数 */
  private fullOf(ev: Event): FullItem | null {
    const x = ev.detail_full !== undefined ? ev.detail_full : ev.enc_full;
    if (x === undefined || x === null || !this.opt.maxFullBytes) return null;
    const slot = slotsOf(ev).full;
    if (!slot) return null;
    const box = typeof x === "object" ? x : typeof x === "string" ? x : { v: x };
    const n = typeof box === "string" ? box.length : Buffer.byteLength(JSON.stringify(box));
    return n > this.opt.maxFullBytes ? null : { slot, box, n };
  }

  /** 大附件按「对话 + 槽 + 键」存起来，浏览器点开时才来要。会话已经不在了（比如刚结束）就不存 */
  private keepFull(ins: Install, ev: Event, f: FullItem) {
    if (!ins.galaxy.sessions.has(ev.sid)) return;
    ins.full.put(f.slot.sid, f.slot.slot, f.slot.k, f.box, f.n);
    if (this.fullTotal.bytes > this.opt.fullTotalBytes) this.evictFull();
  }

  /**
   * 整个服务器超了总量：从占得最多的星系里丢最旧的，丢到比上限低 fullSlack 为止。开放服务器跑一阵就一直贴着上限，
   * 只丢到刚好不超的话，之后每存一个大附件都要扫一遍所有安装；多丢这一截，要再存进这么多才会再扫。
   * 扫一遍建一个按占用字节排的大顶堆，每丢一个只调整堆顶（丢谁和每丢一个都重扫一样）。不只记第二大的：
   * 各星系占得差不多时，最大的丢一个就比第二大的小了，那样还是每丢一个扫一遍
   */
  private evictFull() {
    const cap = this.opt.fullTotalBytes;
    const target = cap - fullSlack(cap);
    const h = [...this.installs.values()].filter(x => x.full.size);
    const less = (i: number, j: number) => h[i].full.bytes < h[j].full.bytes;
    const down = (i: number) => {
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && less(m, l)) m = l;
        if (r < h.length && less(m, r)) m = r;
        if (m === i) return;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    };
    for (let i = (h.length >> 1) - 1; i >= 0; i--) down(i);
    // 只有堆顶在变小，往下调就够了
    while (this.fullTotal.bytes > target && h.length) {
      h[0].full.dropOldest();
      if (!h[0].full.size) { h[0] = h[h.length - 1]; h.pop(); }
      down(0);
    }
  }

  /** 浏览器要一个大附件 */
  full(galaxyId: string, sid: string, slot: string, k: string): string | object | null {
    return this.installs.get(galaxyId)?.full.get(sid, slot, k) ?? null;
  }

  /** 看门狗和清理 */
  watchdog(now: number) {
    for (const [id, ins] of this.installs) {
      const g = ins.galaxy;
      g.watchdog(now);
      if (!g.sessions.size && !ins.queues.size && g.emptySince != null && now - g.emptySince > this.opt.galaxyEmptyMs) {
        this.removeInstall(id);
      }
    }
    for (const [gid, m] of this.oldPlugins) {
      for (const [id, x] of m) if (now - x.seen > OLD_PLUGIN_MS) m.delete(id);
      if (!m.size) this.oldPlugins.delete(gid);
    }
    for (const [k, t] of this.left) if (now - t >= LEFT_MS) this.left.delete(k);
    this.ipNew.prune(now);
    this.ipGroups.prune(now);
  }

  /** 一个星系群的概要层：和上次比变了的行、消失了的星系 */
  summaryDelta(group: string): { rows: SummaryRow[]; gone: string[] } {
    const rows: SummaryRow[] = [], gone: string[] = [];
    const g = this.groups.get(group);
    if (!g) return { rows, gone };
    const seen = new Set<string>();
    for (const id of g.members) {
      const ins = this.installs.get(id);
      if (!ins || !ins.galaxy.sessions.size) continue;
      const gal = ins.galaxy;
      seen.add(id);
      if (!gal.sumDirty && g.lastRows.has(id)) continue;
      gal.sumDirty = false;
      const row = gal.summary(), key = rowKey(row);
      if (g.lastRows.get(id) === key) continue;
      g.lastRows.set(id, key);
      rows.push(row);
    }
    for (const id of g.lastRows.keys()) if (!seen.has(id)) { g.lastRows.delete(id); gone.push(id); }   // 边遍历边删 Map 是安全的
    if (!g.members.size && !g.lastRows.size) this.groups.delete(group);
    return { rows, gone };
  }

  /** 新连上（加入了星系群）的浏览器：这个群的全部概要。群里已经有人在看时用这个，不动 lastRows（别人还等着这以后的增量） */
  summaryFull(group: string): SummaryRow[] {
    const rows: SummaryRow[] = [];
    for (const id of this.groups.get(group)?.members ?? []) {
      const gal = this.installs.get(id)?.galaxy;
      if (gal && gal.sessions.size) rows.push(gal.summary());
    }
    return rows;
  }

  /**
   * 第一个来看这个群的浏览器：全部概要，同时把它记成上次发出去的（lastRows）、清掉 sumDirty，
   * 之后的 summaryDelta 只发这以后的变化，不把刚发的全量再发一遍。没人看的群不算概要（见 unwatched），lastRows 是空的
   */
  summaryJoin(group: string): SummaryRow[] {
    const rows: SummaryRow[] = [];
    const g = this.groups.get(group);
    if (!g) return rows;
    g.lastRows.clear();
    for (const id of g.members) {
      const gal = this.installs.get(id)?.galaxy;
      if (!gal || !gal.sessions.size) continue;
      gal.sumDirty = false;
      const row = gal.summary();
      g.lastRows.set(id, rowKey(row));
      rows.push(row);
    }
    return rows;
  }

  /** 这个群没人看了：忘掉上次发出去的概要（下次有人来时从 summaryJoin 重新记），走光了就删群（有人看时由 summaryDelta 删） */
  unwatched(group: string) {
    const g = this.groups.get(group);
    if (!g) return;
    g.lastRows.clear();
    if (!g.members.size) this.groups.delete(group);
  }

  health(now = Date.now()) {
    let sessions = 0;
    for (const ins of this.installs.values()) sessions += ins.galaxy.sessions.size;
    // 最近 10 个整秒（含当前这一秒）里的事件
    const sec = Math.floor(now / 1000);
    let n = 0;
    for (let b = 0; b < 10; b++) if (sec - this.evBinSec[b] < 10 && this.evBinSec[b] >= 0) n += this.evBins[b];
    return { groups: this.groups.size, galaxies: this.installs.size, sessions, events_per_sec: +(n / 10).toFixed(1) };
  }
}
