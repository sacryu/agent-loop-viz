// 调试页：原始事件流。只在本地模式（接受档位 2）下开放。每一条显示规范化后的字段，点开看原样的完整 hook 数据。
// 页面里的脚本故意不用反引号，好直接放在这个模板字符串里。
export const DEBUG_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Agent Loop · 原始事件</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; background: #0b0c0e; color: #d4d8de; font: 12px/1.45 "Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace; }
header { position: sticky; top: 0; background: #111316; border-bottom: 1px solid #22262b; padding: 8px 14px; display: flex; gap: 12px; align-items: center; z-index: 1; }
header b { font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif; }
select, input, button { background: #1b1e22; color: inherit; border: 1px solid #2a2e34; border-radius: 5px; padding: 3px 8px; font: inherit; }
#n { color: #6f757e; }
.ev { border-bottom: 1px solid #16191c; padding: 4px 14px; display: grid; grid-template-columns: 92px 70px 190px 1fr; gap: 10px; cursor: pointer; }
.ev:hover { background: #14171a; }
.ev .t { color: #6f757e; }
.ev .s { color: #7f97b3; }
.ev .name { font-weight: 600; }
.ev .sum { color: #a7adb5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ev pre { grid-column: 1 / -1; margin: 4px 0 6px; white-space: pre-wrap; word-break: break-all; color: #c6cbd2; background: #0d0f12; border: 1px solid #1f2328; border-radius: 5px; padding: 8px; }
.PermissionRequest .name, .Notification .name { color: #ffb020; }
.Stop .name { color: #4fd18b; }
.StopFailure .name, .PostToolUseFailure .name, .PermissionDenied .name { color: #ff5a52; }
.SessionStart .name, .SessionEnd .name { color: #b48ead; }
a { color: #7f97b3; }
</style>
</head>
<body>
<header>
  <b>原始事件流</b>
  <select id="sid"><option value="">全部会话</option></select>
  <input id="q" placeholder="筛选事件名或内容">
  <label><input type="checkbox" id="pause"> 暂停</label>
  <button id="clr">清空</button>
  <span id="n"></span>
  <span style="flex:1"></span>
  <a href="/">回到星系</a>
</header>
<div id="list"></div>
<script>
"use strict";
var list = document.getElementById("list"), sidSel = document.getElementById("sid"), q = document.getElementById("q");
var all = [], sids = new Set();
function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
function summary(ev) {
  var r = ev.raw || {};
  return [ev.kind && ("kind:" + ev.kind), r.tool_name, ev.source, ev.ntype, ev.err_kind && ("err:" + ev.err_kind),
    ev.bg ? "bg:" + ev.bg : "", ev.agent && "agent:" + ev.agent.slice(0, 6), ev.agent_type, ev.task_note ? "task-note" : "",
    ev.interrupt ? "interrupt" : "", typeof r.prompt === "string" && r.prompt.slice(0, 60)].filter(Boolean).join("  ");
}
function row(item) {
  var ev = item.ev, d = new Date(item.t), div = document.createElement("div");
  div.className = "ev " + (ev.ev || "");
  div.dataset.sid = ev.sid || "";
  div.dataset.text = JSON.stringify(ev).toLowerCase();
  div.innerHTML = '<span class="t">' + d.toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0") +
    '</span><span class="s">' + esc((ev.sid || "").slice(0, 8)) + '</span><span class="name">' + esc(ev.ev) +
    '</span><span class="sum">' + esc(summary(ev)) + "</span>";
  div.addEventListener("click", function () {
    var pre = div.querySelector("pre");
    if (pre) pre.remove(); else div.insertAdjacentHTML("beforeend", "<pre>" + esc(JSON.stringify(ev, null, 2)) + "</pre>");
  });
  return div;
}
function visible(div) {
  var s = sidSel.value, f = q.value.trim().toLowerCase();
  return (!s || div.dataset.sid === s) && (!f || div.dataset.text.indexOf(f) >= 0);
}
function refilter() { for (var i = 0; i < list.children.length; i++) { var d = list.children[i]; d.style.display = visible(d) ? "" : "none"; } }
sidSel.onchange = refilter; q.oninput = refilter;
document.getElementById("clr").onclick = function () { list.innerHTML = ""; all.length = 0; count(); };
function count() { document.getElementById("n").textContent = all.length + " 条"; }
var es = new EventSource("/debug/events");
es.onmessage = function (e) {
  if (document.getElementById("pause").checked) return;
  var item = JSON.parse(e.data);
  all.push(item);
  var sid = item.ev.sid, cwd = item.ev.raw && item.ev.raw.cwd || "";
  if (sid && !sids.has(sid)) {
    sids.add(sid);
    sidSel.insertAdjacentHTML("beforeend", '<option value="' + esc(sid) + '">' + esc(sid.slice(0, 8)) + " · " + esc(cwd.split(/[\\\\/]/).pop()) + "</option>");
  }
  var div = row(item);
  if (!visible(div)) div.style.display = "none";
  list.prepend(div);
  while (list.children.length > 1500) list.lastChild.remove();
  count();
};
</script>
</body>
</html>
`;
