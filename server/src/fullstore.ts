// 大附件：工具完整的输入输出、整句话、完整的回答和报错。不随细节层推，浏览器点开一步时才来要。
// 服务器不解读它（别处来的是密文），按「对话 + 槽 + 键」存。每个星系有总量上限，满了丢最旧的；
// 被丢掉的，页面上显示「内容已不在服务器上」。整个服务器另有总量上限（total），由 Universe 负责从最大的星系里丢。
import { fullKey } from "@agent-loop/shared";

export class FullStore {
  private map = new Map<string, { x: string | object; n: number }>();
  bytes = 0;
  constructor(public cap: number, private total: { bytes: number } = { bytes: 0 }) {}

  private drop(key: string, n: number) { this.map.delete(key); this.bytes -= n; this.total.bytes -= n; }

  /** 丢掉最旧的一个，返回丢了多少字节 */
  dropOldest(): number {
    for (const [k, v] of this.map) { this.drop(k, v.n); return v.n; }
    return 0;
  }

  put(sid: string, slot: string, k: string, x: string | object, n: number) {
    if (n > this.cap) return;
    const key = fullKey(sid, slot, k);
    const old = this.map.get(key);
    if (old) this.drop(key, old.n);
    this.map.set(key, { x, n });
    this.bytes += n; this.total.bytes += n;
    // Map 按插入的先后遍历：最前面的就是最旧的
    while (this.bytes > this.cap && this.dropOldest());
  }

  get(sid: string, slot: string, k: string): string | object | null {
    return this.map.get(fullKey(sid, slot, k))?.x ?? null;
  }

  /** 对话结束了：它的大附件一起清掉 */
  dropSession(sid: string) {
    for (const [k, v] of this.map) if (k.startsWith(sid + "|")) this.drop(k, v.n);
  }

  /** 星系被移除了：全部清掉（从总量里减掉） */
  clear() {
    this.total.bytes -= this.bytes;
    this.bytes = 0;
    this.map.clear();
  }

  get size() { return this.map.size; }
}
