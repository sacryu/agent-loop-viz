#!/usr/bin/env node
// 开发用：把本地构建的结果推到测试服务器上，不重建 Docker 镜像。
//   前端（web/dist）：直接换文件，服务器不重启，宇宙里的星系都还在；浏览器刷新就是新的。
//   服务器（server.mjs）：内容变了才换，然后重启容器（几秒；内存里的星系会清空，插件下一次上报时回来）。
//
//   node tools/push-live.mjs            # 构建并推一次
//   node tools/push-live.mjs --watch    # 盯着 web/ shared/ server/ 的源码，一保存就构建、推送
//
// 推到哪里：环境变量 LIVE_HOST、LIVE_DIR、LIVE_CONTAINER，或者 deploy/live.local.json（不进 git）：
//   { "host": "<ssh 主机名>", "dir": "<服务器上的仓库目录>", "container": "agent-loop" }
// 服务器那边要先改成从 <dir>/live 跑，见 docs/deploy.md 的「测试服务器：热更新」。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfgFile = join(ROOT, "deploy", "live.local.json");
const file = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : {};
const HOST = process.env.LIVE_HOST || file.host;
const DIR = process.env.LIVE_DIR || file.dir;
const CONTAINER = process.env.LIVE_CONTAINER || file.container || "agent-loop";
if (!HOST || !DIR) {
  console.error("不知道推到哪里：设置 LIVE_HOST 和 LIVE_DIR，或者写 deploy/live.local.json（见文件开头的说明）");
  process.exit(1);
}
const WATCH = process.argv.includes("--watch");
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;   // 给远端 shell 用的引号

function run(cmd, args, { input, quiet } = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: ROOT, shell: process.platform === "win32" && cmd === "npm", stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { err += d; });
    if (input) { input.pipe(p.stdin); }
    p.on("error", fail);
    p.on("close", code => code === 0 ? ok(out) : fail(new Error(`${cmd} ${args.join(" ")} 失败（${code}）\n${quiet ? "" : out}${err}`)));
  });
}

const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
let lastServerSha = null;   // 这次运行里推上去的 server.mjs；null 时去服务器上比

async function push({ web, server }) {
  const t0 = Date.now();
  if (web) await run("npm", ["run", "build", "-w", "web"], { quiet: true });
  if (server) await run("npm", ["run", "build", "-w", "server"], { quiet: true });

  // 只推前端时不碰 server.mjs：它可能还没构建出来（比如服务端第一次构建就失败了）
  let restart = false, srvSha = null;
  if (server) {
    srvSha = sha(join(ROOT, "server", "dist", "server.mjs"));
    const remote = lastServerSha ?? (await run("ssh", [HOST, `sha256sum ${q(DIR + "/live/server.mjs")} 2>/dev/null || true`])).split(/\s/)[0];
    restart = remote !== srvSha;
  }

  // 打一个包传过去：web/dist 的全部，加上（需要时）server.mjs
  const files = [];
  if (web) files.push("-C", "web/dist", ".");
  if (restart) files.push("-C", web ? "../../server/dist" : "server/dist", "server.mjs");   // tar 的第二个 -C 相对于第一个
  if (!files.length) { log(`没有变化（${Date.now() - t0}ms）`); return; }
  const tar = spawn("tar", ["czf", "-", ...files], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  const tarDone = new Promise((ok, fail) => tar.on("close", c => c === 0 ? ok() : fail(new Error(`打包失败（tar ${c}）`))));

  // 远端：先解到 live/.in，再把文件挪进 live/web（挂载的是 live 目录本身，里面的文件随便换）。
  //   assets 先放好，index.html 最后用 rename 换掉，浏览器不会拿到新页面却找不到新脚本。
  //   旧的 assets 没人引用、放了 10 分钟以上就删。
  const L = q(DIR + "/live");
  const script = [
    "set -e",
    `mkdir -p ${L}/web/assets && rm -rf ${L}/.in && mkdir ${L}/.in`,
    `tar xzf - -C ${L}/.in`,
    `if [ -d ${L}/.in/assets ]; then cp -f ${L}/.in/assets/* ${L}/web/assets/; fi`,
    `for f in ${L}/.in/*; do b=$(basename "$f"); case "$b" in assets|index.html|server.mjs) ;; *) cp -rf "$f" ${L}/web/ ;; esac; done`,
    `if [ -f ${L}/.in/index.html ]; then cp -f ${L}/.in/index.html ${L}/web/.index.html && mv -f ${L}/web/.index.html ${L}/web/index.html; fi`,
    `if [ -f ${L}/.in/server.mjs ]; then cp -f ${L}/.in/server.mjs ${L}/.server.mjs && mv -f ${L}/.server.mjs ${L}/server.mjs; fi`,
    `if [ -f ${L}/.in/index.html ]; then cd ${L}/web/assets && for a in $(find . -maxdepth 1 -type f -mmin +10); do grep -q "$(basename "$a")" ../index.html || rm -f "$a"; done; fi`,
    `rm -rf ${L}/.in`,
    restart ? `docker restart ${q(CONTAINER)} >/dev/null` : "true",
  ].join("\n");
  // 打包失败时远端的 tar 也会报错退出（set -e），不会走到换文件那一步
  await Promise.all([tarDone, run("ssh", [HOST, script], { input: tar.stdout })]);
  if (restart) lastServerSha = srvSha;
  log(`${[web && "前端", restart && "服务器（已重启容器）"].filter(Boolean).join(" + ")} 已推送（${Date.now() - t0}ms）`);
}

const log = (s) => console.log(`[${new Date().toLocaleTimeString()}] ${s}`);

if (!WATCH) {
  await push({ web: true, server: true }).catch(e => { console.error(e.message); process.exit(1); });
} else {
  // 一保存就推：攒 300ms 的改动一起推；推的时候又有改动，推完再来一次
  let pend = { web: false, server: false }, timer = null, busy = false;
  const kick = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (busy) return kick();
      const job = pend; pend = { web: false, server: false };
      if (!job.web && !job.server) return;
      busy = true;
      try { await push(job); } catch (e) { log("推送失败：" + e.message); }
      busy = false;
    }, 300);
  };
  const on = (dir, what) => watch(join(ROOT, dir), { recursive: true }, (_ev, name) => {
    if (!name || /(^|[\\/])(dist|node_modules)([\\/]|$)/.test(name)) return;
    Object.assign(pend, what); kick();
  });
  on("web", { web: true });
  on("server/src", { server: true });
  on("shared/src", { web: true, server: true });
  log(`盯着源码，保存就推到 ${HOST}:${DIR}/live（Ctrl+C 停止）`);
  await push({ web: true, server: true }).catch(e => log("推送失败：" + e.message));
}
