// 启动服务器。配置来自环境变量：
//   HOST               监听地址，默认 127.0.0.1（本机模式）。自己部署用 0.0.0.0，前面放带 TLS 的反向代理
//   PORT               端口，默认 4317
//   LOCAL              1：本机模式（一个隐含的星系群、明文附件、调试页）；0：按星系群隔离、只收密文。
//                      默认：绑定在回环地址时是 1，否则是 0
//   GROUPS             白名单：逗号分隔的星系群编号，只接受这些（自己部署时用，编号由 npx agent-loop-viz invite 给出）。
//                      空着就是开放模式：任何邀请链接都能创建星系群（官网）
//   MAX_GROUPS         星系群总数上限，满了对新的星系群返回 503，默认 1000
//   MAX_PER_GROUP      每个星系群最多几个星系，默认 50
//   MAX_GALAXIES       星系总数上限，默认 5000
//   MAX_FULL_BYTES     单个大附件的上限（字节），默认 49152。设成 0 就不收大附件
//   MAX_FULL_TOTAL_BYTES  整个服务器的大附件总量上限，默认 268435456（256 MB），超了从占得最多的星系里丢最旧的，丢到比上限低 1%（至少 1MB、不超过上限的四分之一）
//   NEW_INSTALLS_PER_IP_PER_MIN  每个 IP 每分钟新出现的安装数上限，默认 20（IPv6 按 /64 算一个 IP）
//   NEW_GROUPS_PER_IP_PER_HOUR   开放模式：每个 IP 每小时最多新建几个星系群，默认 10
//   GROUP_IDLE_MIN     开放模式：星系群总数满了时，这么多分钟没有事件的星系群可以被新的挤掉，默认 30
//   TRUST_PROXY        设为 1 时用 X-Forwarded-For 的第一个地址限流（只在反向代理后面这样设）
//   STATIC_DIR         前端构建产物的目录，默认 web/dist
// 命令行：
//   --record <文件>    本机模式下把收到的事件一行一条写下来（经过重排、交给状态机之前的那一刻），做测试数据用
import { createWriteStream, existsSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ID_HEX, ID_RE } from "@agent-loop/shared";
import { createApp } from "./app.ts";

const env = process.env;
const host = env.HOST || "127.0.0.1";
const port = Number(env.PORT || 4317);
const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
const local = env.LOCAL != null && env.LOCAL !== "" ? env.LOCAL === "1" : loopback;
if (local && !loopback) {
  console.warn(`注意：服务监听在 ${host}，却是本机模式（LOCAL=1）。本机模式收明文附件、不需要口令，只应该在自己电脑上用。`);
}
const groups = (env.GROUPS || "").split(",").map(s => s.trim()).filter(Boolean);
for (const g of groups) if (!ID_RE.test(g)) throw new Error(`GROUPS 里的「${g}」不是星系群编号（${ID_HEX} 个十六进制字符），由 npx agent-loop-viz invite 给出`);

const args = process.argv.slice(2);
const recIdx = args.indexOf("--record");
const recordTo = recIdx >= 0 ? args[recIdx + 1] : null;
if (recordTo && !local) throw new Error("--record 只能在本机模式下用（非本机模式收到的附件是密文，录下来也没用）");

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = env.STATIC_DIR || [resolve(here, "../../web/dist"), resolve(here, "../web/dist"), resolve(here, "web")].find(d => existsSync(d)) || null;
const num = (v: string | undefined, d: number) => (v != null && v !== "" && isFinite(Number(v)) ? Number(v) : d);

const app = createApp({
  local,
  staticDir,
  trustProxy: env.TRUST_PROXY === "1",
  universe: {
    groups: groups.length ? new Set(groups) : null,
    maxGroups: num(env.MAX_GROUPS, 1000),
    maxPerGroup: num(env.MAX_PER_GROUP, 50),
    maxGalaxies: num(env.MAX_GALAXIES, 5000),
    maxFullBytes: num(env.MAX_FULL_BYTES, 48 * 1024),
    fullTotalBytes: num(env.MAX_FULL_TOTAL_BYTES, 256 * 1024 * 1024),
    newInstallsPerIpPerMin: num(env.NEW_INSTALLS_PER_IP_PER_MIN, 20),
    newGroupsPerIpPerHour: num(env.NEW_GROUPS_PER_IP_PER_HOUR, 10),
    groupIdleMs: num(env.GROUP_IDLE_MIN, 30) * 60_000,
  },
});

if (recordTo) {
  // 先同步打开：路径不对（比如目录不存在）在启动时就说清楚，而不是等第一条事件来了让进程崩掉
  let fd: number;
  try { fd = openSync(recordTo, "a"); } catch (e) { console.error(`没法写 ${recordTo}：${(e as Error).message}`); process.exit(1); }
  const out = createWriteStream("", { fd });
  out.on("error", e => { console.error(`写 ${recordTo} 出错，不再记录：${e.message}`); app.universe.onEvent = undefined; });
  app.universe.onEvent = (group, galaxy, ev, t) => {
    const { raw: _raw, ...rest } = ev;
    out.write(JSON.stringify({ t, galaxy, ev: rest }) + "\n");
  };
  console.log(`事件写到 ${recordTo}`);
}

app.server.listen(port, host, () => {
  const shown = host.includes(":") ? `[${host}]` : host;
  const mode = local ? "本机模式；调试页 /debug"
    : groups.length ? `星系群模式，只接受 ${groups.length} 个星系群（白名单）` : "星系群模式，开放：任何邀请链接都能创建星系群";
  console.log(`Agent Loop 服务已启动：http://${shown}:${port}  （${mode}）`);
  if (!staticDir) console.log("没有找到前端构建产物：先运行 npm run build");
});

const stop = () => { app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
