// 演示站的剧本：能被状态机完整播放；里面没有任何真实的路径、名字、项目。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Galaxy, LocalEvent, asDetail, type Event } from "@agent-loop/shared";

const script = JSON.parse(readFileSync(resolve(__dirname, "../web/src/demo/script.json"), "utf8"));
const text = JSON.stringify(script);

describe("演示站的剧本", () => {
  it("每条事件都符合本机的事件格式，没有原样数据", () => {
    for (const g of script.galaxies) for (const s of g.sessions) {
      for (const ev of [s.first, ...s.cycle.map((c: { ev: unknown }) => c.ev)]) {
        const r = LocalEvent.safeParse(ev);
        expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
        expect(ev).not.toHaveProperty("raw");
      }
    }
  });

  it("喂给状态机：星系不带名字（页面用随机编号生成），每段对话都有项目、标题、带短句的步骤", () => {
    for (const sg of script.galaxies) {
      const g = new Galaxy(sg.id, 1);
      for (const s of sg.sessions) {
        g.handle(s.first as Event, 1);
        for (const c of s.cycle) g.handle(c.ev as Event, 2 + c.at);
      }
      const w = g.full();
      expect(asDetail(w.card?.x)?.me, sg.id).toBeUndefined();
      for (const p of w.projects) expect(asDetail(p.card?.x)?.proj).toBeTruthy();
      for (const s of w.sessions) {
        expect(asDetail(s.title?.x)?.label).toBeTruthy();
        expect(s.model).toMatch(/^claude-/);
        expect(w.steps[s.sid].length).toBeGreaterThan(2);
        expect(w.steps[s.sid].every(x => x.d)).toBe(true);
      }
    }
  });

  it("没有真实的路径、名字、项目", () => {
    // 所有路径都在假目录 /home/dev 下
    for (const m of text.matchAll(/"(?:file_path|filePath|cwd)":"([^"]*)"/g)) expect(m[1].startsWith("/home/dev/"), m[1]).toBe(true);
    for (const bad of ["C:\\\\", "/Users/", "\\Users\\\\", "PycharmProjects", "agent-loop-viz", "yhu", "georgetown", "@gmail", "iol8", "10.5."])
      expect(text.toLowerCase().includes(bad.toLowerCase()), bad).toBe(false);
  });
});
