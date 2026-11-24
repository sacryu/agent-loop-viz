// 插件旧了的提示。服务器按星系群告诉页面哪些星系的插件旧了（插件每次上报都在请求头里带着版本，见 shared/src/version.ts）。
//   你的星系（本机模式下这台电脑上的任何星系都算你的）：底部一条提示，带上更新的命令。
//   正在看的是别人的星系：提示「这个星系的插件不是最新的」，让你转告它的主人。
// 点 × 关掉；名单或版本变了会再出来。
import { compareVersions, type ServerMsg } from "@agent-loop/shared/browser";
import { T } from "./i18n.ts";
import { $, el, setStyle } from "./util.ts";

export const UPDATE_CMDS = ["claude plugin marketplace update agent-loop", "claude plugin update agent-loop@agent-loop"];

const S = { latest: "", old: new Map<string, string>(), shown: "", dismissed: "" };

export function applyPlugins(m: Extract<ServerMsg, { t: "plugin" }>) {
  S.latest = m.latest;
  S.old = new Map(m.old);
}

/** 每帧调用：只在要显示的东西变了的时候改 DOM。local：本机模式；mine：你的星系；viewing：正在看的星系 */
export function updateBar(local: boolean, mine: string | null, viewing: string | null) {
  let who: "mine" | "other" | null = null, v = "";
  if (local && S.old.size) { who = "mine"; v = [...S.old.values()].sort(compareVersions)[0]; }
  else if (mine && S.old.has(mine)) { who = "mine"; v = S.old.get(mine)!; }
  else if (viewing && S.old.has(viewing)) { who = "other"; v = S.old.get(viewing)!; }
  const key = who ? `${who}|${viewing ?? ""}|${v}|${S.latest}` : "";
  if (key === S.shown) return;
  S.shown = key;
  if (!key || key === S.dismissed) { setStyle("update", "display", "none"); return; }
  const bar = $("update");
  bar.replaceChildren();
  const x = el("button", "×") as HTMLButtonElement;
  x.type = "button"; x.title = T.close;
  x.onclick = () => { S.dismissed = key; setStyle("update", "display", "none"); };
  bar.append(el("p", who === "mine" ? T.updateMine(v, S.latest) : T.updateOther(v, S.latest)), el("pre", UPDATE_CMDS.join("\n")), x);
  setStyle("update", "display", "block");
}
