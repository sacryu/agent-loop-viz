#!/usr/bin/env node
// Agent Loop 的命令行（npm 包 agent-loop）。
//   npx agent-loop-viz                         在本机起服务（http://127.0.0.1:4317），插件默认就发到这里
//   npx agent-loop-viz --port 5000             换个端口（插件的 server_url 也要跟着改）
//   npx agent-loop-viz invite https://<域名>   自己部署时：生成一个星系群，打印邀请链接和要填进 GROUPS 的编号
//                                          密钥在这台电脑上生成，不发给任何服务器
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
/** 编号的长度（十六进制字符数）。和 shared/src/attach.ts 的 ID_HEX 一致 */
export const ID_HEX = 32;
const b64u = b => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 新的星系群：K、口令、编号。和插件（plugin/hooks/report.mjs 的 deriveKeys）、页面（web/src/crypto.ts）同一个算法 */
export function newGroup(K = randomBytes(32)) {
  const access = b64u(hkdfSync("sha256", K, Buffer.alloc(0), "agent-loop/access/v1", 32));
  return { k: b64u(K), access, group: createHash("sha256").update(access).digest("hex").slice(0, ID_HEX) };
}

function help() {
  console.log(`Agent Loop

  npx agent-loop-viz                        start the local server (http://127.0.0.1:4317)
  npx agent-loop-viz --port <n> --host <h>  listen somewhere else
  npx agent-loop-viz invite <server url>    create a galaxy group for your own server:
                                        prints the invite link and the id to put in GROUPS`);
}

async function main() {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) return help();
  if (args[0] === "invite") {
    const url = (args[1] || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) { console.error("usage: npx agent-loop-viz invite https://<your server>"); process.exit(1); }
    const g = newGroup();
    console.log(`Invite link (anyone with it can join and watch this group; keep it secret):\n\n  ${url}/#k=${g.k}\n`);
    console.log(`Group id (add it to GROUPS on the server, comma-separated):\n\n  ${g.group}\n`);
    if (url.startsWith("http://") && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url)) {
      console.log("Note: http:// is not encrypted in transit. Anyone on the network path can read the group's access token\n"
        + "(join and see anonymous activity), and can alter the page to steal the key and read everything.\n"
        + "Use https:// for real use.");
    }
    return;
  }
  const opt = n => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };
  if (opt("port")) process.env.PORT = opt("port");
  if (opt("host")) process.env.HOST = opt("host");
  const here = dirname(fileURLToPath(import.meta.url));
  await import(pathToFileURL(resolve(here, "dist/server.mjs")).href);
}

const isMain = (() => { try { return !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href; } catch { return false; } })();
if (isMain || process.argv[1]?.endsWith("agent-loop-viz")) main();
