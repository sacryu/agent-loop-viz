// 邀请链接放进 shell 命令之前的编码（web/src/links.ts 的 shellSafeUrl、joinCommands）
import { describe, expect, it } from "vitest";
import { joinCommands, shellSafeUrl } from "../web/src/links.ts";

const K = "A".repeat(21) + "-_" + "z".repeat(20);

describe("放进 shell 双引号的邀请链接", () => {
  it("正常的链接原样不动", () => {
    for (const u of [`https://loop.example.com/#k=${K}`, `http://10.0.0.1:4317/sub/dir/#k=${K}`,
      `http://[::1]:4317/#k=${K}`, `https://h.example/a%20b/#k=${K}`]) expect(shellSafeUrl(u)).toBe(u);
  });

  it("路径里能让 bash、PowerShell 展开或断开引号的字符都编码掉", () => {
    const evil = `https://h.example/$(touch$IFS/tmp/pwn)/\`id\`/"x"/'y'/%PATH%/!!/\\/“z”/${"${HOME}"}/;&|<>/中/#k=${K}`;
    const out = shellSafeUrl(evil);
    expect(out).toMatch(/^[A-Za-z0-9._~:/#=%[\]-]+$/);
    expect(out).not.toMatch(/%(?![0-9A-F]{2})/);
    expect(decodeURIComponent(out.slice(0, out.indexOf("#")))).toBe(evil.slice(0, evil.indexOf("#")));   // 服务器看到的路径不变
    expect(out.endsWith(`#k=${K}`)).toBe(true);
  });

  it("emoji 这种两个 UTF-16 单元的字符按整个码点编码", () => {
    expect(shellSafeUrl(`https://h.example/😀/#k=${K}`)).toBe(`https://h.example/%F0%9F%98%80/#k=${K}`);
  });

  it("joinCommands 里出现链接的地方都是编码过的", () => {
    const cmds = joinCommands(`https://h.example/$(touch$IFS/tmp/pwn)/\`id\`/"/#k=${K}`).join("\n");
    for (const bad of ["$(", "$IFS", "`id`", '/"/']) expect(cmds).not.toContain(bad);
    expect(cmds).toContain(`"server_url=https://h.example/%24%28touch%24IFS/tmp/pwn%29/%60id%60/%22/#k=${K}"`);
  });
});
