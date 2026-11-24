#!/usr/bin/env node
// 把服务器（一个打包好的 server.mjs）和页面的构建结果放进 cli/dist，cli/ 就是发布到 npm 的包。
//   npm run build && node tools/pack-cli.mjs && (cd cli && npm pack --dry-run)
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(ROOT, "cli/dist");
for (const f of ["server/dist/server.mjs", "web/dist/index.html"]) {
  if (!existsSync(resolve(ROOT, f))) { console.error(`没有 ${f}：先运行 npm run build`); process.exit(1); }
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(resolve(ROOT, "server/dist/server.mjs"), resolve(out, "server.mjs"));
cpSync(resolve(ROOT, "web/dist"), resolve(out, "web"), { recursive: true });
cpSync(resolve(ROOT, "README.md"), resolve(ROOT, "cli/README.md"));
cpSync(resolve(ROOT, "LICENSE"), resolve(ROOT, "cli/LICENSE"));
console.log("cli/ 准备好了：cd cli && npm pack");
