// 接收这一侧：乱序重排、时钟偏移、限流、星系上限、请求体上限、严格校验、/debug 只在本机开放、两层推送、
// 附件（本机明文、别处密文）、星系群的隔离和白名单、大附件。
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { PLUGIN_HEADER, PLUGIN_VERSION, type Event, type ServerMsg } from "@agent-loop/shared";
import { createApp, type App } from "../src/app.ts";
import { LOCAL_GROUP, Universe, fullSlack, rateKey } from "../src/universe.ts";

const G0 = LOCAL_GROUP;

const REAL: Event[] = JSON.parse(readFileSync(resolve(__dirname, "../../test/fixtures/real-session.json"), "utf8"));
const SECRET = "a".repeat(64), SECRET2 = "b".repeat(64);
const GID = Universe.galaxyIdOf(SECRET);

function rng(seed: number) { return () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x6d2b79f5 | 0) >>> 0) / 4294967296; }

/** 按到达时间把事件喂进去，时钟一毫秒一毫秒地往前走 */
function replay(arrivals: { ev: Event; at: number }[], reorderMs = 200) {
  const u = new Universe({ reorderMs });
  const sorted = [...arrivals].sort((a, b) => a.at - b.at);
  const end = sorted[sorted.length - 1].at + 1000;
  let i = 0;
  for (let t = sorted[0].at; t <= end; t += 1) {
    while (i < sorted.length && sorted[i].at <= t) { expect(u.accept(G0, GID, sorted[i].ev, "ip", t)).toBe(204); i++; }
    u.flush(t);
  }
  return u.galaxy(GID)!;
}

describe("乱序", () => {
  it("把一段真实事件序列打乱 200 毫秒以内再喂进去，结果和按顺序到达一致", () => {
    const base = replay(REAL.map(ev => ({ ev, at: ev.ts })));
    const want = JSON.stringify(base.full());
    expect(base.sessions.size).toBe(0);   // 这段记录以 SessionEnd 收尾
    // 去掉 SessionEnd 再比一次，好比较会话的完整状态
    const noEnd = REAL.filter(e => e.ev !== "SessionEnd");
    const want2 = JSON.stringify(replay(noEnd.map(ev => ({ ev, at: ev.ts }))).full());
    expect(JSON.parse(want2).sessions.length).toBe(1);
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      // 第一条不晃：时钟偏移取的是最小延迟，两边一样才能逐字段比较
      const jitter = (k: number) => (k === 0 ? 0 : Math.floor(r() * 199));
      expect(JSON.stringify(replay(REAL.map((ev, k) => ({ ev, at: ev.ts + jitter(k) }))).full())).toBe(want);
      expect(JSON.stringify(replay(noEnd.map((ev, k) => ({ ev, at: ev.ts + jitter(k) }))).full())).toBe(want2);
    }
    // 对照：去掉重排缓冲，同样的打乱会得出不同的结果（说明上面的比较是有效的）
    let differs = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const jitter = (k: number) => (k === 0 ? 0 : Math.floor(r() * 199));
      if (JSON.stringify(replay(noEnd.map((ev, k) => ({ ev, at: ev.ts + jitter(k) })), 0).full()) !== want2) differs++;
    }
    expect(differs).toBeGreaterThan(5);
  });

  it("时钟不准：状态机的时间一律用 ts + 偏移量", () => {
    const u = new Universe();
    const skew = -3_600_000;   // 这台机器的表慢了一小时
    const t0 = 1_900_000_000_000;
    u.accept(G0, GID, { v: 2, level: 0, ev: "SessionStart", ts: t0 + skew, sid: "1111111111111111", proj: "2222222222222222" }, "ip", t0 + 40);
    u.accept(G0, GID, { v: 2, level: 0, ev: "UserPromptSubmit", ts: t0 + 500 + skew, sid: "1111111111111111", proj: "2222222222222222" }, "ip", t0 + 520);
    u.flush(t0 + 2000);
    const s = u.galaxy(GID)!.sessions.get("1111111111111111")!;
    expect(s.roundSince).toBe(t0 + 500 + 20);   // 偏移量 = 最小的「收到时间 − ts」
  });
});

describe("限流和上限（Universe）", () => {
  const ev = (sid = "1111111111111111", ts = 1): Event => ({ v: 2, level: 0, ev: "Stop", ts, sid, proj: "2222222222222222", bg: 0 });

  it("每个安装每秒 50 条，突发 200 条", () => {
    const u = new Universe();
    let ok = 0;
    for (let i = 0; i < 300; i++) if (u.accept(G0, GID, ev(), "ip", 1000) === 204) ok++;
    expect(ok).toBe(200);
    expect(u.accept(G0, GID, ev(), "ip", 1000)).toBe(429);
    let later = 0;
    for (let i = 0; i < 100; i++) if (u.accept(G0, GID, ev(), "ip", 2000) === 204) later++;
    expect(later).toBe(50);
  });

  it("每个 IP 每分钟新出现的安装数有上限；全局星系数满了返回 503", () => {
    const u = new Universe({ newInstallsPerIpPerMin: 3, maxGalaxies: 5 });
    const id = (i: number) => Universe.galaxyIdOf(String(i).padStart(64, "0"));
    expect([0, 1, 2, 3].map(i => u.accept(G0, id(i), ev(), "1.2.3.4", 1000))).toEqual([204, 204, 204, 429]);
    expect(u.accept(G0, id(0), ev(), "1.2.3.4", 1000)).toBe(204);   // 已有的安装不受影响
    expect(u.accept(G0, id(3), ev(), "1.2.3.4", 61_001)).toBe(204);   // 下一分钟
    expect(u.accept(G0, id(4), ev(), "5.6.7.8", 61_001)).toBe(204);
    expect(u.accept(G0, id(5), ev(), "9.9.9.9", 61_001)).toBe(503);
  });

  it("星系里没有会话了：10 分钟后移除", () => {
    const u = new Universe();
    u.accept(G0, GID, { ...ev(), ev: "SessionStart" }, "ip", 1000);
    u.flush(2000);
    u.accept(G0, GID, { ...ev(), ev: "SessionEnd", ts: 3000 }, "ip", 3000);
    u.flush(4000);
    u.watchdog(5000);
    expect(u.galaxy(GID)).toBeDefined();
    u.watchdog(4000 + 10 * 60_000 + 1);
    expect(u.galaxy(GID)).toBeUndefined();
  });
});

// ------------------------------------------------------------------ HTTP 和 WebSocket

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; });

async function start(local: boolean, clock = { t: 1_900_000_000_000 }, universe: Parameters<typeof createApp>[0]["universe"] = {}) {
  app = createApp({ local, staticDir: null, trustProxy: false, now: () => clock.t, manualTimers: true, universe });
  await new Promise<void>(r => app!.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const post = (body: unknown, secret = SECRET, raw?: string, access: string | null = local ? null : ACCESS) => fetch(base + "/v1/events", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", ...(access ? { "x-group": access } : {}) },
    body: raw ?? JSON.stringify(body),
  }).then(r => r.status);
  return { base, post, clock };
}

/** 两个星系群的口令（32 字节的 base64url） */
const ACCESS = "A".repeat(43), ACCESS2 = "B".repeat(43);
const GROUP = Universe.groupIdOf(ACCESS);

const good = (o: Partial<Event> = {}): Event => ({ v: 2, level: 0, ev: "SessionStart", ts: 1_900_000_000_000, sid: "1111111111111111",
  proj: "2222222222222222", source: "startup", ...o } as Event);

describe("POST /v1/events", () => {
  it("校验：要密钥、严格 schema、多余字段拒绝、请求体上限", async () => {
    const { post } = await start(false);
    expect(await post(good())).toBe(204);
    expect(await post(good(), "nope")).toBe(401);
    expect(await post({ ...good(), prompt_text: "hi" })).toBe(400);           // 多余字段
    expect(await post({ ...good(), sid: "C:\\Users\\me" })).toBe(400);       // 不是哈希
    expect(await post({ ...good(), kind: "Bash" })).toBe(400);               // 不在归类表里
    expect(await post({ ...good(), v: 1 })).toBe(400);                       // 旧协议
    expect(await post(null, SECRET, "{not json")).toBe(400);
    expect(await post(null, SECRET, JSON.stringify({ ...good(), pad: "x".repeat(70_000) }))).toBe(413);
  });

  it("非本机：要口令；明文附件、原样数据直接拒绝；密文照收", async () => {
    const { post, clock } = await start(false);
    expect(await post(good(), SECRET, undefined, null)).toBe(401);
    expect(await post(good(), SECRET, undefined, "short")).toBe(401);
    expect(await post({ ...good(), level: 1, detail: { proj: "secret" } })).toBe(400);
    expect(await post({ ...good(), level: 2, raw: { prompt: "secret" } })).toBe(400);
    expect(await post({ ...good(), level: 2, detail_full: "secret" })).toBe(400);
    expect(await post({ ...good(), level: 1, enc: "c2VhbGVk" })).toBe(204);
    expect(await post({ ...good(), level: 1, enc: "not base64url!" })).toBe(400);
    clock.t += 1000; app!.tick();
    expect(app!.universe.rawLog.length).toBe(0);
    expect(app!.universe.galaxy(GID)!.card).toEqual({ k: "2222222222222222", x: "c2VhbGVk" });
    expect(app!.universe.groupOf(GID)).toBe(GROUP);
  });

  it("本机：明文附件放到对应的位置，/debug 能看到原样数据；非本机模式下 /debug 不存在", async () => {
    const pub = await start(false);
    expect((await fetch(pub.base + "/debug")).status).toBe(404);
    await app!.close(); app = null;
    const { base, post, clock } = await start(true);
    const raw = { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "C:\\code\\myproj", tool_input: { command: "ls" } };
    expect(await post({ ...good(), level: 2, detail: { proj: "myproj", me: "Yu" } })).toBe(204);
    expect(await post({ ...good({ ev: "UserPromptSubmit", ts: 1_900_000_000_050 }), source: undefined, level: 2, prompt: "5555555555555555",
      task_note: false, detail: { label: "fix the bug" }, detail_full: "fix the bug in app.ts please" })).toBe(204);
    expect(await post({ ...good({ ev: "PreToolUse", ts: 1_900_000_000_100 }), source: undefined, level: 2, kind: "shell",
      tool: "3333333333333333", raw, detail: { name: "Bash", obj: "ls" }, detail_full: { command: "ls" } })).toBe(204);
    expect(await post({ ...good({ ev: "PostToolUseFailure", ts: 1_900_000_000_200 }), source: undefined, level: 2, kind: "shell",
      tool: "3333333333333333", detail: { err: "ls: no such file" }, detail_full: "ls: no such file\nmore" })).toBe(204);
    expect(await post({ ...good({ ev: "Stop", ts: 1_900_000_000_300 }), source: undefined, level: 2, prompt: "5555555555555555",
      bg: 0, model: "claude-opus-5-5", detail: { say: "Done." }, title: { label: "Fix app.ts bug" } })).toBe(204);
    clock.t += 1000; app!.tick();
    expect((await fetch(base + "/debug")).status).toBe(200);
    expect(app!.universe.rawLog.map(x => (x.ev as any).raw?.tool_name)).toContain("Bash");
    const g = app!.universe.galaxy(GID)!.full();
    expect(g.card).toEqual({ k: "2222222222222222", x: { proj: "myproj", me: "Yu" } });
    expect(g.projects[0].card?.x).toEqual({ proj: "myproj", me: "Yu" });
    const s = g.sessions[0];
    // 标题是 Claude Code 起的（随 Stop 带来）；第一句话另外留着，还没有标题时页面拿它当标题
    expect(s).toMatchObject({ model: "claude-opus-5-5", title: { k: "", x: { label: "Fix app.ts bug" } },
      first: { k: "5555555555555555", x: { label: "fix the bug" } },
      ask: { x: { label: "fix the bug" }, f: true }, ans: { k: "5555555555555555", x: { say: "Done." } } });
    expect(s.ans!.f).toBeUndefined();   // Stop 没带完整回答：页面上点不开
    expect(s.first!.f).toBeUndefined();
    expect(g.steps["1111111111111111"][0]).toMatchObject({ kind: "shell", err: true, d: { k: "3333333333333333", x: { name: "Bash", obj: "ls" } },
      e: { x: { err: "ls: no such file" } }, fin: true, fout: true });
    const U = app!.universe;
    expect(U.full(GID, "1111111111111111", "full-in", "3333333333333333")).toEqual({ command: "ls" });
    expect(U.full(GID, "1111111111111111", "full-out", "3333333333333333")).toBe("ls: no such file\nmore");
    expect(U.full(GID, "1111111111111111", "full-ask", "5555555555555555")).toBe("fix the bug in app.ts please");
    expect(U.full(GID, "1111111111111111", "full-ans", "5555555555555555")).toBeNull();
  });

  it("提问补发的名片：没收到 SessionStart（服务器重启过）时补上项目名和星系名；已有名片时不换", async () => {
    const { post, clock } = await start(false);
    const ask = (ts: number, card: string) => post({ ...good({ ev: "UserPromptSubmit", ts }), source: undefined, level: 1,
      prompt: "5555555555555555", task_note: false, enc: "YXNr", enc_card: card });
    expect(await ask(1_900_000_000_000, "Y2FyZDE")).toBe(204);
    clock.t += 1000; app!.tick();
    let g = app!.universe.galaxy(GID)!.full();
    expect(g.card).toEqual({ k: "2222222222222222", x: "Y2FyZDE" });
    expect(g.projects[0].card).toEqual({ k: "2222222222222222", x: "Y2FyZDE" });
    // 再问一次：名片不换（密文每次都不同，换了页面就要重新解）
    expect(await ask(1_900_000_000_100, "Y2FyZDI")).toBe(204);
    clock.t += 1000; app!.tick();
    g = app!.universe.galaxy(GID)!.full();
    expect(g.projects[0].card?.x).toBe("Y2FyZDE");
    // SessionStart 来了以它为准
    expect(await post({ ...good({ ts: 1_900_000_000_200 }), level: 1, enc: "c3RhcnQ" })).toBe(204);
    clock.t += 1000; app!.tick();
    g = app!.universe.galaxy(GID)!.full();
    expect(g.card?.x).toBe("c3RhcnQ");
    expect(g.projects[0].card?.x).toBe("c3RhcnQ");
    // 明文的名片发给非本机的服务器：拒绝
    expect(await post({ ...good({ ev: "UserPromptSubmit" }), source: undefined, level: 1, card: { proj: "secret" } })).toBe(400);
  });

  it("白名单：不在名单里的星系群上传 403", async () => {
    const { post } = await start(false, undefined, { groups: new Set([GROUP]) });
    expect(await post(good())).toBe(204);
    expect(await post(good(), SECRET2, undefined, ACCESS2)).toBe(403);
  });

  it("星系群和星系数的上限", async () => {
    const { post } = await start(false, undefined, { maxGroups: 1, maxPerGroup: 1 });
    expect(await post(good())).toBe(204);
    expect(await post(good(), SECRET2)).toBe(503);                 // 这个群满了
    expect(await post(good(), SECRET2, undefined, ACCESS2)).toBe(503);   // 星系群总数满了
  });

  it("/healthz：本机给出计数；非本机不要口令，所以只答活着和收不收新群（/agent-loop:create 先问），不透露有几个星系、几个会话", async () => {
    const remote = await start(false);
    await remote.post(good());
    remote.clock.t += 1000; app!.tick();
    expect(await (await fetch(remote.base + "/healthz")).json()).toEqual({ ok: true, local: false, open: true, version: PLUGIN_VERSION });
    await app!.close();
    const listed = await start(false, undefined, { groups: new Set([GROUP]) });
    expect(await (await fetch(listed.base + "/healthz")).json()).toEqual({ ok: true, local: false, open: false, version: PLUGIN_VERSION });
    await app!.close();
    const mine = await start(true);
    await mine.post(good());
    mine.clock.t += 1000; app!.tick();
    expect(await (await fetch(mine.base + "/healthz")).json()).toMatchObject({ ok: true, local: true, groups: 1, galaxies: 1, sessions: 1 });
  });
});

describe("开放模式下建群的限制", () => {
  const acc = (i: number) => Universe.groupIdOf(String(i).padStart(43, "A"));
  const gal = (i: number) => Universe.galaxyIdOf(String(i).padStart(64, "0"));

  it("编号是 32 个十六进制字符", () => {
    expect(acc(1)).toMatch(/^[0-9a-f]{32}$/);
    expect(gal(1)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("限流的地址：IPv6 按 /64 算，IPv4 映射的按 IPv4 算", () => {
    expect(rateKey("1.2.3.4")).toBe("1.2.3.4");
    expect(rateKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(rateKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(rateKey("2001:0DB8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(rateKey("[2001:db8:1:2::1]")).toBe("2001:db8:1:2::/64");
    expect(rateKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(rateKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateKey("::1")).toBe("0:0:0:0::/64");
    expect(rateKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(rateKey("?")).toBe("?");
  });

  it("同一个 /64 里换地址绕不过每分钟的新安装数", () => {
    const u = new Universe({ newInstallsPerIpPerMin: 2 });
    const from = (i: number) => u.accept(G0, gal(i), good(), `2001:db8:1:2::${(i + 1).toString(16)}`, 1000);
    expect([0, 1, 2].map(from)).toEqual([204, 204, 429]);
    expect(u.accept(G0, gal(3), good(), "2001:db8:1:3::1", 1000)).toBe(204);   // 另一个 /64
  });

  it("每个 IP 每小时新建的星系群有上限；加入已有的群不算；白名单模式不受这个限制", () => {
    const u = new Universe({ newGroupsPerIpPerHour: 2, newInstallsPerIpPerMin: 100 });
    expect([1, 2, 3].map(i => u.accept(acc(i), gal(i), good(), "1.2.3.4", 1000))).toEqual([204, 204, 429]);
    expect(u.accept(acc(1), gal(4), good(), "1.2.3.4", 1000)).toBe(204);       // 加入已有的群
    expect(u.accept(acc(3), gal(3), good(), "5.6.7.8", 1000)).toBe(204);       // 别的 IP
    expect(u.accept(acc(5), gal(5), good(), "1.2.3.4", 1000 + 3600_000)).toBe(204);   // 一小时以后
    const w = new Universe({ newGroupsPerIpPerHour: 1, groups: new Set([acc(1), acc(2)]) });
    expect([1, 2].map(i => w.accept(acc(i), gal(i), good(), "1.2.3.4", 1000))).toEqual([204, 204]);
  });

  it("星系群满了：有人在用的群不动，闲着的群里最久没动静的让给新来的", () => {
    const u = new Universe({ maxGroups: 2, groupIdleMs: 60_000 });
    expect(u.accept(acc(1), gal(1), good(), "1.1.1.1", 1000)).toBe(204);
    expect(u.accept(acc(2), gal(2), good(), "2.2.2.2", 5000)).toBe(204);
    expect(u.accept(acc(3), gal(3), good(), "3.3.3.3", 30_000)).toBe(503);     // 两个群都还在用
    expect(u.accept(acc(2), gal(2), good(), "2.2.2.2", 70_000)).toBe(204);     // 第 2 个群一直有事件
    expect(u.accept(acc(3), gal(3), good(), "3.3.3.3", 80_000)).toBe(204);     // 第 1 个群闲了一分多钟：让出来
    expect(u.groupOf(gal(1))).toBeUndefined();
    expect(u.groupOf(gal(2))).toBe(acc(2));
    expect(u.groupOf(gal(3))).toBe(acc(3));
    // 白名单模式不挤人：名单里的群数超过上限是配置的问题
    const w = new Universe({ maxGroups: 1, groupIdleMs: 60_000, groups: new Set([acc(1), acc(2)]) });
    expect(w.accept(acc(1), gal(1), good(), "1.1.1.1", 1000)).toBe(204);
    expect(w.accept(acc(2), gal(2), good(), "2.2.2.2", 500_000)).toBe(503);
    expect(w.groupOf(gal(1))).toBe(acc(1));
  });
});

/** 连一个 WebSocket，收下所有消息 */
async function wsOpen(base: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  const msgs: ServerMsg[] = [];
  let closed: number | null = null;
  ws.on("message", d => msgs.push(JSON.parse(String(d))));
  ws.on("close", code => { closed = code; });
  await new Promise(r => ws.on("open", r));
  return { ws, msgs, closed: () => closed };
}
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise(r => setTimeout(r, 10)); expect(f()).toBe(true); };

describe("本机模式只认本机", () => {
  it("别的网站的页面连不上 WebSocket；Host 不是本机（DNS 重绑定）的请求 403；插件（不带 Origin）照常", async () => {
    const { base, post } = await start(true);
    expect(await post(good())).toBe(204);
    const port = new URL(base).port;
    const http = await import("node:http");
    const status = (headers: Record<string, string>) => new Promise<number>(res => {
      http.get({ host: "127.0.0.1", port, path: "/healthz", headers }, r => { r.resume(); res(r.statusCode!); });
    });
    expect(await status({})).toBe(200);
    expect(await status({ host: "evil.example:" + port })).toBe(403);
    expect(await status({ origin: "https://evil.example" })).toBe(403);
    expect(await status({ origin: `http://localhost:5173` })).toBe(200);
    const evil = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { origin: "https://evil.example" } });
    const failed = await new Promise<boolean>(res => { evil.on("open", () => res(false)); evil.on("error", () => res(true)); });
    expect(failed).toBe(true);
    const ok = await wsOpen(base);
    await until(() => ok.msgs.some(m => m.t === "sum"));
    ok.ws.close();
  });
});

describe("大附件的总量上限", () => {
  it("整个服务器超了总量：从占得最多的星系里丢最旧的", () => {
    const u = new Universe({ fullTotalBytes: 30_000, fullPerGalaxyBytes: 1_000_000 });
    const pre = (secret: string, tool: string, ts: number) => u.accept(G0, Universe.galaxyIdOf(secret),
      { ...good({ ev: "PreToolUse", ts }), source: undefined, kind: "shell", tool, detail_full: { pad: "x".repeat(9000) } } as Event, "ip", ts);
    u.accept(G0, Universe.galaxyIdOf(SECRET), good(), "ip", 1);
    u.accept(G0, Universe.galaxyIdOf(SECRET2), good({ sid: "4444444444444444" }), "ip", 1);
    for (let i = 0; i < 4; i++) pre(SECRET, "a00000000000000" + i, 10 + i);
    u.flush(10_000);
    expect(u.fullTotal.bytes).toBeLessThanOrEqual(30_000);
    expect(u.full(GID, "1111111111111111", "full-in", "a000000000000000")).toBeNull();     // 最旧的被丢了
    expect(u.full(GID, "1111111111111111", "full-in", "a000000000000003")).not.toBeNull();
  });

  it("超了以后丢到比上限低一截，每丢一个都是从当时最大的星系丢最旧的；没超就不丢", () => {
    const cap = 110_000, slack = fullSlack(cap);
    expect(slack).toBe(27_500);                          // 上限很小：不超过四分之一
    expect(fullSlack(256 * 1024 * 1024)).toBeCloseTo(256 * 1024 * 1024 / 100);
    expect(fullSlack(10 * 1024 * 1024)).toBe(1024 * 1024);
    const u = new Universe({ fullTotalBytes: cap, fullPerGalaxyBytes: 1_000_000 });
    const who = [
      { gid: Universe.galaxyIdOf(SECRET), sid: "1111111111111111", p: "a" },
      { gid: Universe.galaxyIdOf(SECRET2), sid: "4444444444444444", p: "b" },
      { gid: Universe.galaxyIdOf("c".repeat(64)), sid: "5555555555555555", p: "c" },
    ];
    for (const w of who) u.accept(G0, w.gid, good({ sid: w.sid, ts: 1 }), "ip", 1);
    u.flush(10_000);
    let ts = 10;
    // a、c 的每个 9010 字节，b 的每个 9510 字节（大小都错开，不会有一样大的）
    const pre = (w: typeof who[number], i: number) => u.accept(G0, w.gid, { ...good({ ev: "PreToolUse", ts: ts++, sid: w.sid }),
      source: undefined, kind: "shell", tool: w.p + "00000000000000" + i, detail_full: { pad: "x".repeat(w.p === "b" ? 9500 : 9000) } } as Event, "ip", 20_000);
    const have = (w: typeof who[number], n: number) => Array.from({ length: n }, (_, i) => u.full(w.gid, w.sid, "full-in", w.p + "00000000000000" + i) !== null);
    // a 存 6 个（54060）、b 存 4 个（38040），c 存 2 个（18020）：c 的第二个让总量（110120）超过上限
    for (let i = 0; i < 6; i++) pre(who[0], i);
    for (let i = 0; i < 4; i++) pre(who[1], i);
    for (let i = 0; i < 2; i++) pre(who[2], i);
    u.flush(40_000);
    // 丢的顺序：a（54060 → 45050）、a（→ 36040，比 b 小了）、b（38040 → 28530）、a（36040 → 27030），总量 73580
    expect(have(who[0], 6)).toEqual([false, false, false, true, true, true]);
    expect(have(who[1], 4)).toEqual([false, true, true, true]);
    expect(have(who[2], 2)).toEqual([true, true]);
    expect(u.fullTotal.bytes).toBe(73_580);
    expect(u.fullTotal.bytes).toBeLessThanOrEqual(cap - slack);
    // 回到上限以内了：再存一个没超，什么都不丢
    pre(who[2], 2);
    u.flush(60_000);
    expect(u.fullTotal.bytes).toBe(73_580 + 9010);
    expect(have(who[0], 6)).toEqual([false, false, false, true, true, true]);
    expect(have(who[1], 4)).toEqual([false, true, true, true]);
  });
});

describe("哪些步骤能点开", () => {
  it("带着能存下的大附件才标；超过单个上限、或者服务器不收大附件时不标", () => {
    const run = (opt: ConstructorParameters<typeof Universe>[0]) => {
      const u = new Universe(opt);
      const step = (tool: string, ts: number, full?: unknown) => u.accept(G0, GID,
        { ...good({ ev: "PreToolUse", ts }), source: undefined, kind: "shell", tool, ...(full === undefined ? {} : { detail_full: full }) } as Event, "ip", ts);
      u.accept(G0, GID, good(), "ip", 1);
      step("a000000000000001", 10, { command: "ls" });
      step("a000000000000002", 11, { pad: "x".repeat(9000) });
      step("a000000000000003", 12);
      u.flush(10_000);
      return u.galaxy(GID)!.full().steps["1111111111111111"].map(x => !!x.fin);
    };
    expect(run({ maxFullBytes: 4096 })).toEqual([true, false, false]);
    expect(run({ maxFullBytes: 0 })).toEqual([false, false, false]);
  });
});

describe("星系群的隔离", () => {
  it("没发 join 什么都收不到；口令不对断开；另一个群的人看不到这个群", async () => {
    const { base, post, clock } = await start(false);
    await post(good());
    await post(good({ sid: "4444444444444444" }), SECRET2, undefined, ACCESS2);
    clock.t += 1000; app!.tick();

    const a = await wsOpen(base);
    await until(() => a.msgs.some(m => m.t === "hello"));
    await new Promise(r => setTimeout(r, 30));
    expect(a.msgs.some(m => m.t === "sum")).toBe(false);
    a.ws.send(JSON.stringify({ focus: GID }));   // 没加入就要看：断开
    await until(() => a.closed() === 4401);

    const bad = await wsOpen(base);
    bad.ws.send(JSON.stringify({ join: "nope" }));
    await until(() => bad.closed() === 4403);

    const b = await wsOpen(base);
    b.ws.send(JSON.stringify({ join: ACCESS2 }));
    await until(() => b.msgs.some(m => m.t === "sum"));
    expect((b.msgs.find(m => m.t === "sum") as any).rows.map((r: any) => r[0])).toEqual([Universe.galaxyIdOf(SECRET2)]);
    // 知道另一个群里星系的编号也看不到它
    b.ws.send(JSON.stringify({ focus: GID }));
    await until(() => b.msgs.some(m => m.t === "gal-gone"));
    expect(b.msgs.some(m => m.t === "gal")).toBe(false);
    b.ws.send(JSON.stringify({ full: { sid: "1111111111111111", slot: "full-in", k: "x" } }));
    await until(() => b.msgs.some(m => m.t === "full"));
    expect((b.msgs.find(m => m.t === "full") as any).x).toBeNull();
    // 概要的增量也只推给自己的群
    b.msgs.length = 0;
    await post(good({ ev: "UserPromptSubmit", ts: 1_900_000_000_500, source: undefined, prompt: "5555555555555555", task_note: false }));
    clock.t += 1000; app!.tick();
    await new Promise(r => setTimeout(r, 50));
    expect(b.msgs.some(m => m.t === "sum")).toBe(false);
    b.ws.close();
  });

  it("换到的星系群满了：留在原来的群里，不会两边都没有", async () => {
    const { post, clock } = await start(false, undefined, { maxPerGroup: 1 });
    await post(good());
    await post(good({ sid: "4444444444444444" }), SECRET2, undefined, ACCESS2);
    clock.t += 1000; app!.tick();
    expect(await post(good({ ts: 1_900_000_001_000 }), SECRET, undefined, ACCESS2)).toBe(503);
    expect(app!.universe.groupOf(GID)).toBe(GROUP);
  });

  it("换了邀请链接：星系从原来的群里搬走", async () => {
    const { post, clock } = await start(false);
    await post(good());
    clock.t += 1000; app!.tick();
    expect(app!.universe.groupOf(GID)).toBe(GROUP);
    await post(good({ ts: 1_900_000_001_000 }), SECRET, undefined, ACCESS2);
    clock.t += 1000; app!.tick();
    expect(app!.universe.groupOf(GID)).toBe(Universe.groupIdOf(ACCESS2));
    expect(app!.universe.summaryFull(GROUP)).toEqual([]);
  });
});

describe("退出星系群（POST /v1/leave）", () => {
  const leave = (base: string, secret: string, access: string | null) => fetch(base + "/v1/leave", {
    method: "POST", headers: { authorization: `Bearer ${secret}`, ...(access ? { "x-group": access } : {}) },
  }).then(r => r.status);

  it("马上从群里移走，连同大附件；群里的浏览器收到 gone；晚到的事件不会把它带回来", async () => {
    const { base, post, clock } = await start(false);
    await post(good());
    await post({ ...good({ ev: "PreToolUse", ts: 1_900_000_000_100, source: undefined, tool: "3333333333333333", kind: "shell" }), level: 2, enc_full: "c2VhbGVk" });
    await post(good({ sid: "4444444444444444" }), SECRET2);
    clock.t += 1000; app!.tick();
    expect(app!.universe.full(GID, "1111111111111111", "full-in", "3333333333333333")).toBe("c2VhbGVk");
    const b = await wsOpen(base);
    b.ws.send(JSON.stringify({ join: ACCESS }));
    await until(() => b.msgs.some(m => m.t === "sum"));
    b.msgs.length = 0;

    expect(await leave(base, SECRET, ACCESS)).toBe(204);
    expect(app!.universe.groupOf(GID)).toBeUndefined();
    expect(app!.universe.full(GID, "1111111111111111", "full-in", "3333333333333333")).toBeNull();
    expect(app!.universe.groupOf(Universe.galaxyIdOf(SECRET2))).toBe(GROUP);   // 别人不受影响
    app!.tick();
    await until(() => b.msgs.some(m => m.t === "sum"));
    expect((b.msgs.find(m => m.t === "sum") as any).gone).toEqual([GID]);

    // 退出那一刻已经在路上的 hook：照收（插件不会把它当成出错），但丢掉
    expect(await post(good({ ev: "UserPromptSubmit", ts: 1_900_000_001_000, source: undefined, prompt: "5555555555555555", task_note: false }))).toBe(204);
    clock.t += 1000; app!.tick();
    expect(app!.universe.groupOf(GID)).toBeUndefined();
    // 过了这段时间再发（/agent-loop:rejoin 以后）：重新进群
    clock.t += 20_000; app!.tick();
    expect(await post(good({ ts: 1_900_000_030_000 }))).toBe(204);
    clock.t += 1000; app!.tick();
    expect(app!.universe.groupOf(GID)).toBe(GROUP);
    b.ws.close();
  });

  it("只能移走自己：别人的安装密钥、别的群的口令都动不了它；要密钥和口令；本机模式没有这个接口", async () => {
    const { base, post, clock } = await start(false);
    await post(good());
    clock.t += 1000; app!.tick();
    expect(await leave(base, SECRET2, ACCESS)).toBe(204);    // 另一个星系「退出」：它本来就不在群里，什么都不变
    expect(await leave(base, SECRET, ACCESS2)).toBe(204);    // 拿另一个群的口令：星系不在那个群里
    expect(app!.universe.groupOf(GID)).toBe(GROUP);
    expect(await leave(base, "nope", ACCESS)).toBe(401);
    expect(await leave(base, SECRET, null)).toBe(401);
    expect(await fetch(base + "/v1/leave").then(r => r.status)).toBe(405);
    // 没真的移走谁，就不留「刚退出」的记录：拿另一个群的口令去「退出」以后，照样能换到那个群
    expect(await post(good({ ts: 1_900_000_001_000 }), SECRET, undefined, ACCESS2)).toBe(204);
    clock.t += 1000; app!.tick();
    expect(app!.universe.groupOf(GID)).toBe(Universe.groupIdOf(ACCESS2));
    await app!.close(); app = null;

    const { base: lb, post: lp } = await start(true);
    await lp(good());
    expect(await leave(lb, SECRET, null)).toBe(404);
  });
});

describe("WebSocket 两层推送", () => {
  it("概要层所有人都收；细节层 focus 以后才收，之后是增量", async () => {
    const { base, post, clock } = await start(true);
    await post(good());
    await post(good({ sid: "4444444444444444", ts: 1_900_000_000_010 }), SECRET2);
    clock.t += 1000; app!.tick();
    const { ws, msgs } = await wsOpen(base);
    await until(() => msgs.some(m => m.t === "sum"));
    const sum = msgs.find(m => m.t === "sum") as Extract<ServerMsg, { t: "sum" }>;
    expect(sum.full).toBe(true);
    expect(sum.rows.map(r => r[0]).sort()).toEqual([GID, Universe.galaxyIdOf(SECRET2)].sort());
    expect(sum.rows.find(r => r[0] === GID)).toEqual([GID, 1, "i"]);
    expect(msgs.some(m => m.t === "gal")).toBe(false);

    ws.send(JSON.stringify({ focus: GID }));
    await until(() => msgs.some(m => m.t === "gal"));
    const full = msgs.find(m => m.t === "gal") as Extract<ServerMsg, { t: "gal"; full: true }>;
    expect(full.full).toBe(true);
    expect(full.galaxy.sessions.map(s => s.sid)).toEqual(["1111111111111111"]);

    msgs.length = 0;
    await post(good({ ev: "UserPromptSubmit", ts: 1_900_000_000_500, source: undefined, prompt: "5555555555555555", task_note: false }));
    await post(good({ ev: "PreToolUse", ts: 1_900_000_000_600, source: undefined, kind: "read", tool: "6666666666666666" }));
    clock.t += 1000; app!.tick();
    await until(() => msgs.some(m => m.t === "gal") && msgs.some(m => m.t === "sum"));
    const d = msgs.find(m => m.t === "gal") as Extract<ServerMsg, { t: "gal"; full: false }>;
    expect(d.full).toBe(false);
    expect(d.sessions[0]).toMatchObject({ status: "working", phase: "act" });
    expect(d.steps["1111111111111111"].map(x => x.kind)).toEqual(["read"]);
    expect((msgs.find(m => m.t === "sum") as any).rows).toEqual([[GID, 1, "a"]]);

    // 换着看别的星系：不再收这个星系的增量
    ws.send(JSON.stringify({ focus: null }));
    await new Promise(r => setTimeout(r, 50));
    msgs.length = 0;
    await post(good({ ev: "Stop", ts: 1_900_000_000_900, source: undefined, bg: 0 }));
    clock.t += 1000; app!.tick();
    await until(() => msgs.some(m => m.t === "sum"));
    expect(msgs.some(m => m.t === "gal")).toBe(false);
    ws.close();
  });
});

describe("概要只算有人看的群", () => {
  const sums = (msgs: ServerMsg[]) => msgs.filter((m): m is Extract<ServerMsg, { t: "sum" }> => m.t === "sum");
  const ups = (ts: number) => good({ ev: "UserPromptSubmit", ts, source: undefined, prompt: "5555555555555555", task_note: false });
  const G2 = Universe.galaxyIdOf(SECRET2);

  it("没人看时不算；之后有人加入，全量是最新的，之后的增量不重复全量里的行", async () => {
    const { base, post, clock } = await start(false);
    await post(good());
    await post(good({ sid: "4444444444444444" }), SECRET2);
    clock.t += 1000; app!.tick();
    expect(app!.universe.groups.get(GROUP)!.lastRows.size).toBe(0);   // 没人看：没算概要
    // 没人看的时候星系变了（交给了状态机，还没到概要推送）
    await post(ups(1_900_000_000_500));
    clock.t += 1000; app!.tick("flush");

    const b = await wsOpen(base);
    b.ws.send(JSON.stringify({ join: ACCESS }));
    await until(() => sums(b.msgs).length > 0);
    const full = sums(b.msgs)[0];
    expect(full.full).toBe(true);
    expect(full.rows.sort((x, y) => (x[0] < y[0] ? -1 : 1))).toEqual([[GID, 1, "w"], [G2, 1, "i"]].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
    // 全量里的行不再作为增量发一遍
    b.msgs.length = 0;
    clock.t += 1000; app!.tick();
    await new Promise(r => setTimeout(r, 50));
    expect(sums(b.msgs)).toEqual([]);
    // 之后变了的照常发，只发变了的那一行
    await post(good({ ev: "Stop", ts: 1_900_000_000_900, source: undefined, bg: 0 }));
    clock.t += 1000; app!.tick();
    await until(() => sums(b.msgs).length > 0);
    expect(sums(b.msgs).map(m => [m.full, m.rows, m.gone])).toEqual([[false, [app!.universe.galaxy(GID)!.summary()], []]]);
    b.ws.close();
  });

  it("群里已经有人在看，第二个人加入：第一个人不漏增量、不重复收到；第二个人走了第一个人照常收", async () => {
    const { base, post, clock } = await start(false);
    await post(good());
    clock.t += 1000; app!.tick();
    const a = await wsOpen(base);
    a.ws.send(JSON.stringify({ join: ACCESS }));
    await until(() => sums(a.msgs).length > 0);
    expect(sums(a.msgs)[0].rows).toEqual([[GID, 1, "i"]]);
    // 变了，还没到概要推送，第二个人加入
    await post(ups(1_900_000_000_500));
    clock.t += 1000; app!.tick("flush");
    a.msgs.length = 0;
    const b = await wsOpen(base);
    b.ws.send(JSON.stringify({ join: ACCESS }));
    await until(() => sums(b.msgs).length > 0);
    expect(sums(b.msgs)[0]).toMatchObject({ full: true, rows: [[GID, 1, "w"]] });
    clock.t += 1000; app!.tick();
    clock.t += 1000; app!.tick();
    await until(() => sums(a.msgs).length > 0);
    await new Promise(r => setTimeout(r, 50));
    expect(sums(a.msgs).map(m => [m.full, m.rows, m.gone])).toEqual([[false, [[GID, 1, "w"]], []]]);

    b.ws.close();
    await until(() => b.closed() !== null);
    await new Promise(r => setTimeout(r, 30));
    a.msgs.length = 0;
    await post(good({ ev: "Stop", ts: 1_900_000_000_900, source: undefined, bg: 0 }));
    clock.t += 1000; app!.tick();
    await until(() => sums(a.msgs).length > 0);
    expect(sums(a.msgs).map(m => [m.full, m.rows])).toEqual([[false, [app!.universe.galaxy(GID)!.summary()]]]);
    a.ws.close();
  });

  it("星系都走了的群，没人看也会删掉；看着的人走了也删", async () => {
    const { base, post, clock } = await start(false);
    const leave = (secret: string, access: string) => fetch(base + "/v1/leave", {
      method: "POST", headers: { authorization: `Bearer ${secret}`, "x-group": access },
    }).then(r => r.status);
    const GROUP2 = Universe.groupIdOf(ACCESS2);
    // 从来没人看的群
    await post(good());
    clock.t += 1000; app!.tick();
    expect(app!.universe.groups.has(GROUP)).toBe(true);
    expect(await leave(SECRET, ACCESS)).toBe(204);
    clock.t += 1000; app!.tick();
    expect(app!.universe.groups.has(GROUP)).toBe(false);
    // 有人看着时星系走了，还没到概要推送那个人就走了
    await post(good({ sid: "4444444444444444" }), SECRET2, undefined, ACCESS2);
    clock.t += 1000; app!.tick();
    const a = await wsOpen(base);
    a.ws.send(JSON.stringify({ join: ACCESS2 }));
    await until(() => sums(a.msgs).length > 0);
    expect(await leave(SECRET2, ACCESS2)).toBe(204);
    expect(app!.universe.groups.has(GROUP2)).toBe(true);   // 还欠看着的人一个 gone
    a.ws.close();
    await until(() => !app!.universe.groups.has(GROUP2));
    clock.t += 1000; app!.tick();
    expect(app!.universe.groups.size).toBe(0);
  });
});

describe("插件旧了的提示", () => {
  /** 带上插件版本的请求头再发 */
  async function postV(base: string, body: unknown, v: string | null, access: string | null, secret = SECRET) {
    const r = await fetch(base + "/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json",
                 ...(access ? { "x-group": access } : {}), ...(v ? { [PLUGIN_HEADER]: v } : {}) },
      body: JSON.stringify(body),
    });
    return r.status;
  }
  const plugins = (msgs: ServerMsg[]) => msgs.filter((m): m is Extract<ServerMsg, { t: "plugin" }> => m.t === "plugin");

  it("本机：协议对不上被拒的旧插件也能认出来；更新以后提示消失", async () => {
    const { base, clock } = await start(true);
    const c = await wsOpen(base);
    await until(() => c.msgs.some(m => m.t === "sum"));
    expect(await postV(base, { ...good(), v: 1 }, null, null)).toBe(400);   // 0.2.1 以前的插件：不带版本，旧协议
    clock.t += 1000; app!.tick();
    await until(() => plugins(c.msgs).length > 0);
    expect(plugins(c.msgs).at(-1)).toMatchObject({ latest: PLUGIN_VERSION, old: [[GID, ""]] });
    // 新连上的浏览器马上就知道
    const d = await wsOpen(base);
    await until(() => plugins(d.msgs).length > 0);
    expect(plugins(d.msgs)[0].old).toEqual([[GID, ""]]);
    // 名单没变：不再发
    clock.t += 1000; app!.tick();
    await new Promise(r => setTimeout(r, 30));
    expect(plugins(c.msgs).length).toBe(1);
    // 更新了
    expect(await postV(base, good(), PLUGIN_VERSION, null)).toBe(204);
    clock.t += 1000; app!.tick();
    await until(() => plugins(c.msgs).length === 2);
    expect(plugins(c.msgs)[1].old).toEqual([]);
    c.ws.close(); d.ws.close();
  });

  it("星系群：只告诉同一个群的人；乱写的版本算旧；30 分钟没上报就忘掉", async () => {
    const { base, clock } = await start(false);
    expect(await postV(base, good(), "0.2.0", ACCESS)).toBe(204);
    expect(await postV(base, good(), "9.9.9; drop", ACCESS2, SECRET2)).toBe(204);
    const a = await wsOpen(base), b = await wsOpen(base);
    a.ws.send(JSON.stringify({ join: ACCESS })); b.ws.send(JSON.stringify({ join: ACCESS2 }));
    await until(() => plugins(a.msgs).length > 0 && plugins(b.msgs).length > 0);
    expect(plugins(a.msgs)[0].old).toEqual([[GID, "0.2.0"]]);
    expect(plugins(b.msgs)[0].old).toEqual([[Universe.galaxyIdOf(SECRET2), ""]]);
    clock.t += 30 * 60_000 + 1; app!.tick();
    await until(() => plugins(a.msgs).length === 2);
    expect(plugins(a.msgs)[1].old).toEqual([]);
    a.ws.close(); b.ws.close();
  });
});
