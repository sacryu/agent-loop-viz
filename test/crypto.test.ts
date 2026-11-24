// 浏览器里解密的两条路（WebCrypto、纯 JS）和插件里 Node 加密的结果互通：固定的密钥和数据，三边一致。
import { describe, expect, it } from "vitest";
import { deriveKeys as nodeDerive, seal } from "../plugin/hooks/report.mjs";
import { deriveKeys, gcmOpen, hkdf32, sha256 } from "../web/src/crypto.ts";
import { createHash, hkdfSync } from "node:crypto";
import { newGroup } from "../cli/bin.mjs";

const K = "q2Vr0YI4Zx3m7J-L_uYbqzT9c1a8RkQeWnV6pHsAdQ0";
const AAD = "agent-loop/2|step|abc|def";

describe("浏览器的密码学", () => {
  it("纯 JS 的 SHA-256、HKDF 和 Node 一致", () => {
    for (const s of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "中文".repeat(100)]) {
      const u = new TextEncoder().encode(s);
      expect(Buffer.from(sha256(u)).toString("hex")).toBe(createHash("sha256").update(u).digest("hex"));
    }
    const ikm = new Uint8Array(32).fill(7);
    expect(Buffer.from(hkdf32(ikm, "agent-loop/content/v1"))).toEqual(Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), "agent-loop/content/v1", 32)));
  });

  for (const pure of [false, true]) {
    it(`${pure ? "纯 JS" : "WebCrypto"}：派生出的口令、星系群编号和插件一致，能解开插件加密的内容`, async () => {
      const g = (await deriveKeys(K, pure))!;
      const n = nodeDerive(K)!;
      expect(g.native).toBe(!pure);
      expect(g.access).toBe(n.access);
      expect(g.group).toBe(n.group);
      for (const value of [{ name: "Read", obj: "web/draw.ts" }, "x".repeat(5000), { 中文: "可以", list: [1, 2, 3] }, ""]) {
        expect(await g.open(seal(n.content, value, AAD), AAD)).toEqual(value);
      }
      await expect(g.open(seal(n.content, { a: 1 }, AAD), AAD + "x")).rejects.toThrow();
    });
  }

  it("命令行生成的星系群（npx agent-loop-viz invite）和插件、页面算出来的一样", async () => {
    const g = newGroup(Buffer.from(K.replace(/-/g, "+").replace(/_/g, "/") + "=", "base64"));
    expect(g.k).toBe(K);
    expect(g.access).toBe(nodeDerive(K)!.access);
    expect(g.group).toBe((await deriveKeys(K))!.group);
  });

  it("坏密钥", async () => {
    expect(await deriveKeys("short")).toBeNull();
    expect(() => gcmOpen(new Uint8Array(32), new Uint8Array(12), new Uint8Array(20), new Uint8Array(0))).toThrow();
  });
});
