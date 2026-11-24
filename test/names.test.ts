// 星系名、项目名由编号自动生成：同一个编号永远得到同一个名字，不同编号大多不同
import { describe, expect, it } from "vitest";
import { galaxyName, projectName } from "@agent-loop/shared";

describe("编号生成名字", () => {
  it("稳定、像星表编号", () => {
    expect(galaxyName("0123456789abcdef")).toBe(galaxyName("0123456789abcdef"));
    expect(galaxyName("0123456789abcdef")).toMatch(/^ALC \d{4}[+−]\d{2}$/);
    expect(projectName("fedcba9876543210")).toMatch(/^\S+ [A-Z][a-z]+ \d{3}$/);
  });
  it("一千个编号里几乎没有重名", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => (i * 2654435761 >>> 0).toString(16).padStart(16, "0"));
    expect(new Set(ids.map(galaxyName)).size).toBeGreaterThan(940);
    expect(new Set(ids.map(projectName)).size).toBeGreaterThan(900);
  });
  it("星系名是合法的天球坐标：赤经 00–23 时 00–59 分，赤纬 −90～+90 度，南北都有", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => (i * 2654435761 >>> 0).toString(16).padStart(16, "0"));
    const signs = new Set<string>();
    for (const id of ids) {
      const m = /^ALC (\d{2})(\d{2})([+−])(\d{2})$/.exec(galaxyName(id))!;
      expect(m).not.toBeNull();
      expect(+m[1]).toBeLessThan(24);
      expect(+m[2]).toBeLessThan(60);
      expect(+m[4]).toBeLessThanOrEqual(90);
      signs.add(m[3]);
    }
    expect(signs.size).toBe(2);
  });
});
