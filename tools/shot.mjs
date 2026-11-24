#!/usr/bin/env node
// 开发用：用无头 Chrome 打开页面，跑一段脚本，截图。只用 Chrome 自带的调试协议（DevTools Protocol）和 ws，不需要别的包。
//
//   node tools/shot.mjs <网址> <截图.png> [--wait 毫秒] [--eval "页面里执行的 JS"] [--size 1600x1000] [--steps steps.json]
//   steps.json：[{ "eval": "...", "wait": 500, "shot": "a.png" }, …] 依次执行
// 找 Chrome：CHROME 环境变量，或者 Windows / macOS / Linux 上的常见位置。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const [url, out] = args;
if (!url) { console.error("用法：node tools/shot.mjs <网址> <截图.png> [--wait 毫秒] [--eval JS] [--size WxH] [--steps steps.json]"); process.exit(1); }
const [W, H] = opt("size", "1600x1000").split("x").map(Number);
const chrome = process.env.CHROME || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(p => existsSync(p));
if (!chrome) { console.error("找不到 Chrome：设 CHROME 环境变量"); process.exit(1); }

const profile = mkdtempSync(join(tmpdir(), "al-shot-"));
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
  "--hide-scrollbars", "--force-device-scale-factor=1", "--enable-unsafe-swiftshader", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === "page"); } catch { /* 还没起来 */ }
}
if (!target) { console.error("Chrome 没起来"); proc.kill(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.on("open", r));
let id = 0;
const waiting = new Map(), logs = [];
ws.on("message", d => {
  const m = JSON.parse(String(d));
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled") logs.push(`[${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? "").join(" "));
  if (m.method === "Runtime.exceptionThrown") logs.push("[exception] " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
});
const call = (method, params = {}) => new Promise(r => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await call("Page.navigate", { url });
const run = async js => {
  const r = await call("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true });
  return r.result?.exceptionDetails ? "ERROR " + (r.result.exceptionDetails.exception?.description || "") : r.result?.result?.value;
};
const shot = async file => {
  const r = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(r.result.data, "base64"));
  console.log("截图", file);
};
await sleep(+opt("wait", 2500));
const steps = opt("steps") ? JSON.parse(readFileSync(opt("steps"), "utf8")) : [];
if (opt("eval")) steps.unshift({ eval: opt("eval") });
for (const s of steps) {
  if (s.eval) { const v = await run(s.eval); if (v !== undefined) console.log("eval →", typeof v === "string" ? v : JSON.stringify(v)); }
  if (s.wait) await sleep(s.wait);
  if (s.shot) await shot(s.shot);
}
if (out) await shot(out);
if (logs.length) console.log(logs.slice(-30).join("\n"));
ws.close(); proc.kill();
await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome 可能还占着 */ }
process.exit(0);
