#!/usr/bin/env node
// 先构建一遍，再把服务器（一个打包好的 server.mjs）和页面的构建结果放进 cli/dist，cli/ 就是发布到 npm 的包。
// cli/ 的 prepack 就是它，所以 npm publish 发出去的总是当前源码构建出来的，不会是上次留下的旧文件。
//   node tools/pack-cli.mjs && (cd cli && npm pack --dry-run)
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(ROOT, "cli/dist");
execSync("npm run build", { cwd: ROOT, stdio: "inherit" });
for (const f of ["server/dist/server.mjs", "web/dist/index.html"]) {
  if (!existsSync(resolve(ROOT, f))) { console.error(`构建完了却没有 ${f}`); process.exit(1); }
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(resolve(ROOT, "server/dist/server.mjs"), resolve(out, "server.mjs"));
cpSync(resolve(ROOT, "web/dist"), resolve(out, "web"), { recursive: true });
cpSync(resolve(ROOT, "README.md"), resolve(ROOT, "cli/README.md"));
cpSync(resolve(ROOT, "LICENSE"), resolve(ROOT, "cli/LICENSE"));
console.log("cli/ 准备好了：cd cli && npm pack");
