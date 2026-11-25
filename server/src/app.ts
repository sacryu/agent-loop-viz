// HTTP 和 WebSocket。接口：
//   POST /v1/events   插件上传事件（成功 204）。非本机模式要带 X-Group: <星系群的口令>
//   POST /v1/leave    星系退出星系群（插件的 /agent-loop:leave，成功 204）。和上传一样带安装密钥和口令，只能移走自己；只在非本机模式下有
//   GET  /ws          浏览器订阅（WebSocket）。非本机模式下第一条消息必须是 {"join": "<口令>"}
//   GET  /healthz     存活检查。本机模式另外给出星系群数、星系数、会话数、每秒事件数；非本机只答 ok 和收不收新的星系群（open，
//                     /agent-loop:create 建群前先问；和 WebSocket 打招呼时给页面的是同一个值）。两种都带 version（这一版的插件版本，
//                     插件据此判断页面认不认 #galaxy=、&created：插件和私有部署是分开升级的）
//   GET  /debug       原始事件流，只在本机模式下开放
//   其余             web/ 的构建产物
//
// 两种模式：
//   本机（local）：只有一个隐含的星系群，不需要口令；附件是明文（LocalEvent）。
//   非本机：按星系群隔离；附件只能是密文（RemoteEvent 里没有明文附件的字段，收到就拒绝）。
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { ID_RE, KEY43_RE, LocalEvent, PLUGIN_HEADER, PLUGIN_VERSION, RemoteEvent, SECRET_RE, VERSION_RE, type ClientMsg, type Event, type ServerMsg } from "@agent-loop/shared";
import { DEBUG_HTML } from "./debug-page.ts";
import { LOCAL_GROUP, Universe, rateKey, type UniverseOptions } from "./universe.ts";

export interface AppOptions {
  /** 本机模式：一个隐含的星系群、明文附件、调试页 */
  local: boolean;
  staticDir: string | null;
  trustProxy: boolean;
  universe?: Partial<UniverseOptions>;
  now?: () => number;
  /** 测试用：不自动跑定时器，由测试手动推进 */
  manualTimers?: boolean;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2",
};

const SUMMARY_MS = 1000, DETAIL_MS = 100, FLUSH_MS = 50, WATCHDOG_MS = 500;
/** 一个浏览器还没收走的数据超过这么多就断开它：读得太慢（或故意不读）的连接，别让服务器替它攒内存。
 *  这个分支没有自动测试：在回环地址上要先塞满内核的 socket 缓冲区才会积压到这里，测试又慢又不稳 */
const WS_MAX_BUFFERED = 8 * 1024 * 1024;
/** 非本机模式下，同一个地址（IPv6 按 /64）同时开着的 WebSocket 上限，包括还没发 join 的 */
const WS_PER_IP = 64;
/** 发 focus / full 的速度：突发 60 条，之后每秒 20 条；超了的直接不理。非本机模式下同一个地址的所有连接共用这一份
 *  （每条 focus 都要把整个星系拼一遍，开一堆连接不该换来更多次数） */
const WS_MSG_BURST = 60, WS_MSG_PER_SEC = 20;

export interface App {
  server: Server;
  universe: Universe;
  tick: (what?: "flush" | "watchdog" | "push" | "all") => void;
  close: () => Promise<void>;
}

export function createApp(opt: AppOptions): App {
  const now = opt.now ?? Date.now;
  const local = opt.local;
  const universe = new Universe(opt.universe);
  universe.keepRaw = local;
  const maxBody = local ? 256 * 1024 : 64 * 1024;

  // ---------------------------------------------------------------- 浏览器
  // group：这个浏览器加入的星系群（本机模式下一连上就是那个隐含的群；否则发了 join 才有）
  interface Client { ws: WebSocket; group: string | null; focus: string | null; alive: boolean; goneSent: boolean; bucket: Bucket }
  interface Bucket { tokens: number; at: number }
  const clients = new Set<Client>();
  /** 星系群编号 → 看着它的浏览器。只有有人看的群在里面 */
  const watchers = new Map<string, Set<Client>>();
  /** 每个地址开着几个 WebSocket、共用的发消息额度（只在非本机模式下算；连接都断了就删掉） */
  const wsPerIp = new Map<string, number>();
  const bucketOfIp = new Map<string, Bucket>();
  /** 积压太多：断开它，返回 true */
  const choked = (c: Client) => {
    if (c.ws.bufferedAmount <= WS_MAX_BUFFERED) return false;
    c.ws.terminate();
    return true;
  };
  const send = (c: Client, m: ServerMsg | string) => {
    if (c.ws.readyState !== WebSocket.OPEN || choked(c)) return;
    c.ws.send(typeof m === "string" ? m : JSON.stringify(m));
  };

  function sendFull(c: Client) {
    if (c.ws.readyState !== WebSocket.OPEN || choked(c)) return;   // 先看积压，再拼整个星系
    const g = c.focus && universe.groupOf(c.focus) === c.group ? universe.galaxy(c.focus) : undefined;
    c.goneSent = false;
    if (c.focus && g) send(c, { t: "gal", now: now(), id: g.id, full: true, galaxy: g.full() });
    else if (c.focus) { send(c, { t: "gal-gone", now: now(), id: c.focus }); c.goneSent = true; }
  }

  // 插件旧了的星系：每个群上次发出去的名单（没有就是空的），变了才再发。群里每个浏览器手上的名单都和它一样
  const lastOld = new Map<string, { key: string; old: [string, string][] }>();
  const pluginMsg = (old: [string, string][]) => JSON.stringify({ t: "plugin", now: now(), latest: PLUGIN_VERSION, old } satisfies ServerMsg);
  /** 名单变了就发给群里所有人，返回发没发 */
  function pushGroupPlugins(gid: string): boolean {
    const old = universe.outdated(gid), key = JSON.stringify(old);
    if ((lastOld.get(gid)?.key ?? "[]") === key) return false;
    lastOld.set(gid, { key, old });
    const m = pluginMsg(old);
    for (const c of watchers.get(gid) ?? []) send(c, m);
    return true;
  }
  function pushPlugins() {
    for (const gid of lastOld.keys()) if (!watchers.has(gid)) lastOld.delete(gid);   // 没人看了：下次有人来时从空的算起
    for (const gid of watchers.keys()) pushGroupPlugins(gid);
  }
  /** 刚加入星系群的浏览器（c.group 已经设好）：名单变了就连同别人一起发；没变而且不是空的，单独发给它 */
  function sendPlugins(c: Client) {
    if (!c.group) return;
    const before = lastOld.get(c.group);
    if (!pushGroupPlugins(c.group) && before?.old.length) send(c, pluginMsg(before.old));
  }

  /** 浏览器加入星系群：发这个群的全部概要和插件名单。第一个来看的，全量同时记成上次发出去的（之后的增量不重复这些行）；
   *  已经有人在看时不动那份记录，别人还等着这以后的增量 */
  function joinGroup(c: Client, gid: string) {
    c.group = gid;
    let set = watchers.get(gid);
    const first = !set;
    if (!set) watchers.set(gid, set = new Set());
    set.add(c);
    send(c, { t: "sum", now: now(), full: true, rows: first ? universe.summaryJoin(gid) : universe.summaryFull(gid), gone: [] });
    sendPlugins(c);
  }
  /** 浏览器断开（可能来不止一次）。群里最后一个人走了：群不再算概要，走光了的群马上删掉 */
  function dropClient(c: Client) {
    clients.delete(c);
    const set = c.group ? watchers.get(c.group) : undefined;
    if (!set?.delete(c) || set.size) return;
    watchers.delete(c.group!);
    universe.unwatched(c.group!);
  }

  /** 只算有人看的群：没人看的群概要算了也没人收 */
  function pushSummary() {
    pushPlugins();
    for (const [gid, set] of watchers) {
      const { rows, gone } = universe.summaryDelta(gid);
      if (!rows.length && !gone.length) continue;
      // 同一个群里发给每个人的都一样：只序列化一次
      const m = JSON.stringify({ t: "sum", now: now(), full: false, rows, gone } satisfies ServerMsg);
      for (const c of set) send(c, m);
    }
  }

  const focusedOn = new Set<string>();
  function pushDetail() {
    focusedOn.clear();
    for (const c of clients) if (c.focus) focusedOn.add(c.focus);
    for (const ins of universe.installs.values()) {
      const g = ins.galaxy;
      // 没人看的星系只清掉变化记录，不拼增量（每 0.1 秒一次，星系多了白白拼一堆没人要的对象）
      if (!focusedOn.has(g.id)) { g.discardDelta(); continue; }
      const d = g.delta();
      if (!d) continue;
      const m = JSON.stringify({ t: "gal", now: now(), id: g.id, full: false, ...d } satisfies ServerMsg);
      for (const c of clients) if (c.focus === g.id && c.group === ins.group) { send(c, m); c.goneSent = false; }
    }
    // 看着的星系没了，或者它不在这个浏览器的群里（每次只说一遍）
    for (const c of clients) if (c.focus && !c.goneSent && universe.groupOf(c.focus) !== c.group) {
      send(c, { t: "gal-gone", now: now(), id: c.focus }); c.goneSent = true;
    }
  }

  // ---------------------------------------------------------------- HTTP
  const server = createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });

  function clientIp(req: IncomingMessage): string {
    if (opt.trustProxy) {
      const xf = req.headers["x-forwarded-for"];
      const first = (Array.isArray(xf) ? xf[0] : xf || "").split(",")[0].trim();
      if (first) return first;
    }
    return req.socket.remoteAddress || "?";
  }

  function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
    return new Promise(res => {
      const len = Number(req.headers["content-length"] || 0);
      if (len > limit) { res(null); req.resume(); return; }
      const chunks: Buffer[] = [];
      let size = 0, over = false;
      req.on("data", (c: Buffer) => {
        if (over) return;
        size += c.length;
        if (size > limit) { over = true; chunks.length = 0; return; }
        chunks.push(c);
      });
      req.on("end", () => res(over ? null : Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => res(null));
    });
  }

  /**
   * 本机模式下只认本机：Host 必须是回环的名字（挡住 DNS 重绑定：别的网站把自己的域名解析到 127.0.0.1），
   * Origin 要么没有（插件的 fetch 不带），要么是本机的页面（挡住任意网站在你浏览器里连 ws://127.0.0.1:4317）。
   * 非本机模式不需要：看和传都要星系群的口令
   */
  function trusted(req: IncomingMessage): boolean {
    if (!local) return true;
    const loop = (h: string) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(h.toLowerCase());
    const hostname = (h: string) => { try { return new URL("http://" + h).hostname; } catch { return ""; } };
    if (!loop(hostname(req.headers.host || ""))) return false;
    const origin = req.headers.origin;
    if (origin == null || origin === "") return true;
    try { const o = new URL(origin); return (o.protocol === "http:" || o.protocol === "https:") && loop(o.hostname); } catch { return false; }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!trusted(req)) { req.resume(); return void res.writeHead(403).end(); }
    const url = new URL(req.url || "/", "http://x");
    const path = url.pathname;
    if (path === "/v1/events" || path === "/v1/leave") {
      if (req.method !== "POST") return void res.writeHead(405).end();
      const auth = req.headers.authorization || "";
      const secret = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!SECRET_RE.test(secret)) { req.resume(); return void res.writeHead(401).end(); }
      let group = LOCAL_GROUP;
      if (!local) {
        const xg = req.headers["x-group"];
        const access = (Array.isArray(xg) ? xg[0] : xg || "").trim();
        if (!KEY43_RE.test(access)) { req.resume(); return void res.writeHead(401).end(); }
        group = Universe.groupIdOf(access);
        if (!universe.allowed(group)) { req.resume(); return void res.writeHead(403).end(); }
      }
      if (path === "/v1/leave") {
        // 星系自己退出星系群。本机模式只有一个隐含的群，没有「退出」可言
        req.resume();
        if (local) return void res.writeHead(404).end();
        universe.leave(group, Universe.galaxyIdOf(secret), now());
        return void res.writeHead(204).end();
      }
      // 插件的版本：在校验事件之前记，协议变了（事件会被拒）的旧插件也能在页面上提示更新
      const pv = req.headers[PLUGIN_HEADER];
      universe.notePlugin(group, Universe.galaxyIdOf(secret), typeof pv === "string" && VERSION_RE.test(pv) ? pv : "", now());
      const body = await readBody(req, maxBody);
      if (body == null) return void res.writeHead(413).end();
      let data: unknown;
      try { data = JSON.parse(body); } catch { return void res.writeHead(400).end(); }
      // 非本机：schema 里没有明文附件的字段，带着明文附件来的事件直接拒绝
      const ev = (local ? LocalEvent : RemoteEvent).safeParse(data);
      if (!ev.success) return void res.writeHead(400).end();
      const code = universe.accept(group, Universe.galaxyIdOf(secret), ev.data as Event, clientIp(req), now());
      return void res.writeHead(code).end();
    }
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      // 非本机：这个接口不要口令，所以只答「活着」。星系数、会话数、每秒事件数等于在说「这个群现在有没有人在干活」，
      // 那是要口令才能看的东西
      return void res.end(JSON.stringify(local ? { ok: true, local, version: PLUGIN_VERSION, ...universe.health(now()) } : { ok: true, local, open: !universe.opt.groups, version: PLUGIN_VERSION }));
    }
    if (path === "/debug" || path === "/debug/events") {
      if (!local) return void res.writeHead(404).end();
      if (path === "/debug") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return void res.end(DEBUG_HTML);
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      for (const x of universe.rawLog) res.write(`data: ${JSON.stringify(x)}\n\n`);
      const on = (x: unknown) => res.write(`data: ${JSON.stringify(x)}\n\n`);
      debugListeners.add(on);
      req.on("close", () => debugListeners.delete(on));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
    return serveStatic(path, res);
  }

  const debugListeners = new Set<(x: unknown) => void>();
  universe.onRaw = x => { for (const f of debugListeners) f(x); };

  function serveStatic(path: string, res: ServerResponse) {
    if (!opt.staticDir) return void res.writeHead(404).end();
    const root = resolve(opt.staticDir);
    let file = normalize(join(root, decodeURIComponent(path)));
    if (!file.startsWith(root + sep) && file !== root) return void res.writeHead(403).end();
    if (path === "/" || !existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
    if (!existsSync(file)) return void res.writeHead(404).end();
    const hashed = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache" });
    // 文件可能刚好在 existsSync 之后被删掉（push-live 会清理旧资源）：读出错就断开这个请求，别让进程崩掉
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
  }

  // ---------------------------------------------------------------- WebSocket
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  server.on("upgrade", (req, sock, head) => {
    // 这里抛出去的异常没人接，会让整个进程退出：解析不了的请求行（比如 "GET http://[ HTTP/1.1"）只断开这一个连接
    let path = "";
    try { path = new URL(req.url || "/", "http://x").pathname; } catch { /* 当作不是 /ws */ }
    if (path !== "/ws" || !trusted(req)) { sock.destroy(); return; }
    const ip = local ? "" : rateKey(clientIp(req));
    if (ip && (wsPerIp.get(ip) ?? 0) >= WS_PER_IP) { sock.destroy(); return; }
    if (ip) {   // 从握手开始算，到这条 TCP 连接断开为止
      wsPerIp.set(ip, (wsPerIp.get(ip) ?? 0) + 1);
      sock.once("close", () => {
        const n = (wsPerIp.get(ip) ?? 1) - 1;
        if (n > 0) wsPerIp.set(ip, n); else wsPerIp.delete(ip);   // 额度留着：断开重连不能换来满额度（sweepBuckets 再删）
      });
    }
    wss.handleUpgrade(req, sock, head, ws => {
      let bucket = ip ? bucketOfIp.get(ip) : undefined;
      if (!bucket) { bucket = { tokens: WS_MSG_BURST, at: Date.now() }; if (ip) bucketOfIp.set(ip, bucket); }
      const c: Client = { ws, group: null, focus: null, alive: true, goneSent: false, bucket };
      clients.add(c);
      send(c, { t: "hello", now: now(), local, open: !local && !universe.opt.groups });
      if (local) joinGroup(c, LOCAL_GROUP);
      // 非本机：10 秒内没发 join 就断开
      const joinTimer = local ? null : setTimeout(() => { if (!c.group) ws.close(4401, "join"); }, 10_000);
      ws.on("pong", () => { c.alive = true; });
      ws.on("message", data => {
        let m: ClientMsg;
        try { m = JSON.parse(String(data)); } catch { return; }
        if (!m || typeof m !== "object") return;
        if ("join" in m) {
          if (local || c.group) return;
          const access = typeof m.join === "string" ? m.join : "";   // 别人发来的可能不是字符串
          const gid = KEY43_RE.test(access) ? Universe.groupIdOf(access) : null;
          if (!gid || !universe.allowed(gid)) { ws.close(4403, "group"); return; }
          if (joinTimer) clearTimeout(joinTimer);
          joinGroup(c, gid);
          return;
        }
        if (!c.group) { ws.close(4401, "join"); return; }
        const b = c.bucket, tNow = Date.now();
        b.tokens = Math.min(WS_MSG_BURST, b.tokens + (tNow - b.at) * WS_MSG_PER_SEC / 1000);
        b.at = tNow;
        if (b.tokens < 1) return;
        b.tokens -= 1;
        if ("focus" in m) {
          const f = m.focus;
          if (f !== null && (typeof f !== "string" || !ID_RE.test(f))) return;
          // 只能看自己这个群里的星系（别的群的，就当它不存在）
          c.focus = f;
          sendFull(c);
          return;
        }
        if ("full" in m) {
          const q = m.full;
          if (!q || typeof q !== "object" || !c.focus) return;
          const { sid, slot, k } = q as { sid: unknown; slot: unknown; k: unknown };
          if (typeof sid !== "string" || typeof slot !== "string" || typeof k !== "string" || sid.length > 40 || slot.length > 20 || k.length > 40) return;
          const x = universe.groupOf(c.focus) === c.group ? universe.full(c.focus, sid, slot, k) : null;
          send(c, { t: "full", now: now(), id: c.focus, sid, slot, k, x });
        }
      });
      ws.on("close", () => dropClient(c));
      ws.on("error", () => dropClient(c));
    });
  });

  // ---------------------------------------------------------------- 定时器
  /** 删掉没有连接、额度也已经补满的地址：这时删掉和留着没有区别（补满只要 WS_MSG_BURST / WS_MSG_PER_SEC 秒） */
  function sweepBuckets() {
    const t = Date.now();
    for (const [ip, b] of bucketOfIp)
      if (!wsPerIp.has(ip) && b.tokens + (t - b.at) * WS_MSG_PER_SEC / 1000 >= WS_MSG_BURST) bucketOfIp.delete(ip);
  }

  const tick = (what: "flush" | "watchdog" | "push" | "all" = "all") => {
    const t = now();
    if (what === "flush" || what === "all") universe.flush(t);
    if (what === "watchdog" || what === "all") { universe.watchdog(t); sweepBuckets(); }
    if (what === "push" || what === "all") { pushDetail(); pushSummary(); }
  };
  const timers: NodeJS.Timeout[] = [];
  if (!opt.manualTimers) {
    timers.push(setInterval(() => universe.flush(now()), FLUSH_MS));
    timers.push(setInterval(() => { universe.watchdog(now()); sweepBuckets(); }, WATCHDOG_MS));
    timers.push(setInterval(pushDetail, DETAIL_MS));
    timers.push(setInterval(pushSummary, SUMMARY_MS));
    timers.push(setInterval(() => {   // 断掉的连接清掉
      for (const c of clients) {
        if (!c.alive) { c.ws.terminate(); dropClient(c); continue; }
        c.alive = false; c.ws.ping();
      }
    }, 30_000));
  }

  return {
    server, universe, tick,
    close: () => new Promise<void>(r => {
      for (const t of timers) clearInterval(t);
      for (const c of clients) c.ws.terminate();
      wss.close();
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}
