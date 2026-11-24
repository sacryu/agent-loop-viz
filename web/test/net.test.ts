// 页面和服务器的连接：被服务器停下（没进群 10 秒后的 4401、口令被拒的 4403）以后，建群、粘链接要能连回去。
// 不起浏览器：把 WebSocket、location 这些换成假的，看 net.ts 开了几条连接、发了什么。
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

class FakeWs {
  static OPEN = 1;
  static all: FakeWs[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWs.all.push(this); }
  send(s: string) { this.sent.push(s); }
  close() { this.serverClose(1000); }
  /** 服务器那边的动作 */
  hello() { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ t: "hello", now: Date.now(), local: false, open: true }) }); }
  serverClose(code: number) { this.readyState = 3; this.onclose?.({ code }); }
}

let net: typeof import("../src/net.ts");
const ACCESS = "a".repeat(43), OTHER = "b".repeat(43);
const last = () => FakeWs.all[FakeWs.all.length - 1];

beforeAll(async () => {
  vi.stubGlobal("WebSocket", FakeWs);
  vi.stubGlobal("location", { protocol: "http:", host: "10.0.0.1:4317", pathname: "/", search: "", hash: "" });
  vi.stubGlobal("navigator", { language: "en" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("document", { title: "", getElementById: () => ({ textContent: "", style: {} }) });
  net = await import("../src/net.ts");
  net.connect(() => {}, () => {});
});
beforeEach(() => { vi.useFakeTimers(); });

describe("连接被服务器停下以后换口令", () => {
  it("没进群被断开（4401）：不自己重连；建群、粘链接（setAccess）时马上连回去并发 join", () => {
    const first = last();
    first.hello();
    first.serverClose(4401);
    vi.advanceTimersByTime(30_000);
    expect(last()).toBe(first);                 // 停着，不白白重连

    net.setAccess(ACCESS);
    const second = last();
    expect(second).not.toBe(first);             // 连回去了
    second.hello();
    expect(second.sent).toContain(JSON.stringify({ join: ACCESS }));
  });

  it("口令被拒（4403）：conn.denied；换一条链接后连回去、denied 清掉", () => {
    const cur = last();
    cur.serverClose(4403);
    expect(net.conn.denied).toBe(true);
    net.setAccess(OTHER);
    expect(net.conn.denied).toBe(false);
    const next = last();
    expect(next).not.toBe(cur);
    next.hello();
    expect(next.sent).toContain(JSON.stringify({ join: OTHER }));
  });

  it("连着的时候换口令：断开再重连，只有一条新连接", () => {
    const cur = last(), n = FakeWs.all.length;
    net.setAccess(ACCESS);
    vi.advanceTimersByTime(1000);
    expect(FakeWs.all.length).toBe(n + 1);
    expect(last()).not.toBe(cur);
  });
});
