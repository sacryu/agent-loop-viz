import type { Event } from "@agent-loop/shared";
import { Galaxy } from "@agent-loop/shared";

export class Harness {
  t = 1_800_000_000_000;
  g = new Galaxy("0123456789abcdef", this.t);

  ev(name: Event["ev"], fields: Partial<Event> & Record<string, unknown> = {}) {
    const e = { v: 2, level: 0, ev: name, ts: this.t, sid: "s1", proj: "p1", ...fields } as Event;
    this.g.handle(e, this.t);
  }
  advance(ms: number) { this.t += ms; }
  tick(ms = 600) { this.t += ms; this.g.watchdog(this.t); }
  view(sid = "s1") {
    const s = this.g.sessions.get(sid);
    return s ? { ...s.wire(), ticks: s.ticks, tools: [...s.tools.entries()], steps: s.steps, s } : null;
  }
}
