// 界面文字：中文和英文。这里只有固定的词和模板；来自用户的文字（项目名、对话标题、每一步的对象）在附件里，
// 由 model.ts 套进这里的模板（「读 {obj}」/「Read {obj}」）。
// 选哪种：地址里的 ?lang=zh|en（只管这一次打开）> 右上角切换过的（存在 localStorage）> 浏览器语言（zh 开头用中文，否则英文）。
import type { ToolKind } from "@agent-loop/shared/browser";
import { params } from "./util.ts";

export type Lang = "zh" | "en";
const KEY = "agent-loop.lang";
const isLang = (s: unknown): s is Lang => s === "zh" || s === "en";

function pickLang(): Lang {
  const q = params.get("lang");
  if (isLang(q)) return q;
  try { const s = localStorage.getItem(KEY); if (isLang(s)) return s; } catch { /* 隐私模式之类 */ }
  return /^zh\b/i.test(navigator.language || "") ? "zh" : "en";
}
export const LANG: Lang = pickLang();

/** 英文的单复数：1 project / 2 projects */
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

const zh = {
  htmlLang: "zh-CN",
  // 页面上写死的标签（index.html 里 data-t）
  static: { ctxTokens: "上下文 tokens", outTokens: "累计输出 tokens", status: "状态", galaxy: "星系", current: "当前", subagents: "派出",
            asked: "在问", answer: "回答", model: "模型", input: "输入", output: "输出" },
  toggle: "EN",   // 切换按钮上写的是另一种语言
  toggleTitle: "Switch to English",

  kindDone: {
    read: "读文件", edit: "改文件", search: "搜代码", shell: "跑命令", web: "上网查", agent: "派子 agent",
    ask: "问你问题", plan: "确认计划", progress: "更新任务列表", mcp: "调用外部服务", other: "调用工具",
  } as Record<ToolKind, string>,
  status: { idle: "待命", waiting: "等你", done: "做完了", error: "出错了" } as Record<string, string>,
  thinking: "在想", acting: "在动手", bgWait: "等后台", stale: "可能已关闭",

  session: (i: number) => `对话 ${i}`,
  lap: (i: number) => `第 ${i} 圈`,
  steps: (k: number) => `${k} 步`,
  lapsUnder: (k: number, steps: number) => `圈 · ${steps} 步`,   // 圆心大数字（圈数）下面那行
  failed: "出错",
  bgRunning: (k: number) => "后台任务在跑" + (k > 1 ? ` · ${k} 个` : ""),
  waited: (d: string) => "已等 " + d,
  subagent: "子 agent", customSubagent: "自定义子 agent", custom: "自定义",
  subagents: (k: number) => `${k} 个子 agent`,
  moreSubagents: (k: number) => `还有 ${k} 个子 agent`,

  /** 一步的短句：真实工具名 + 对象（来自附件）。照搬 Python 版 humanize.py 的 tool_phrase */
  tool: {
    shell: (o: string) => `运行 ${o}`, read: (o: string) => `读 ${o}`, edit: (o: string) => `改 ${o}`, write: (o: string) => `写 ${o}`,
    grep: (o: string) => `搜 ${o}`, glob: (o: string) => `找文件 ${o}`, fetch: (o: string) => `打开 ${o}`, search: (o: string) => `搜网页 ${o}`,
    agent: (o: string) => `派子 agent ${o}`.trim(), ask: (o: string) => (o ? `问你 ${o}` : "有问题问你"), plan: "请你确认计划",
    skill: (o: string) => `用技能 ${o}`, mcp: (server: string, tool: string) => (tool ? `调用 ${server} · ${tool}` : `调用 ${server}`),
    progress: "更新任务列表", other: (name: string) => `调用 ${name}`,
  },
  /** 等你授权时：「想 改 app.ts」 */
  want: (p: string) => `想${p}`,
  waitPermission: "等你授权",
  detailLoading: "正在取…", detailGone: "上文已折叠",
  detailLocked: "解不开这段内容（邀请链接的密钥不对）",
  detailClose: "关闭（Esc）",
  stdout: "标准输出", stderr: "标准错误", file: "文件", matches: (k: number) => `${k} 个匹配`, files: (k: number) => `${k} 个文件`,
  duration: "耗时", errorLabel: "报错",

  galaxyCaption: (g: string, p: number, s: number, w: number) => `${g} · ${p} 个项目 · ${s} 个对话 · ${w} 个在跑`,
  galaxyQuiet: (g: string) => `${g} · 现在没有对话在跑`,
  hintFocus: "Esc 返回 · ← → 切换对话 · 点一步看完整内容",
  hintGalaxy: "拖动转动 · 滚轮缩放 · Esc 回到星系群",
  hintZoomed: "拖动平移 · 滚轮缩放 · Esc 回到总览",

  universeCaption: (g: number, s: number, w: number) => `${g} 个星系 · ${s} 个对话 · ${w} 个在跑`,
  universeEmpty: "星系群里还没有星系在跑",
  hintUniverse: "拖动平移 · 滚轮缩放 · 点一团光飞进去",
  yourGalaxy: "你的星系", galaxy: "星系",
  locateMine: "我的星系", locateTitle: "在星系群里找到你的星系（M）",
  mineAbsent: "你的星系现在没有对话，星系群里暂时看不到它",
  galaxySize: (p: number, s: number) => `${p} 个项目 · ${s} 个对话`,
  counts: {
    think: (k: number) => `${k} 个在想`, act: (k: number) => `${k} 个在动手`, wait: (k: number) => `${k} 个等你`,
    bg: (k: number) => `${k} 个等后台`, err: (k: number) => `${k} 个出错`, done: (k: number) => `${k} 个做完了`,
    idle: (k: number) => `${k} 个待命`, stale: (k: number) => `${k} 个可能已关闭`,
  },

  // 星系群：邀请、加入、创建
  invite: "邀请",
  inviteTitle: "邀请加入",
  inviteDesc: "把链接和给 Claude Code 的那段话发给对方。链接就是这个星系群的钥匙，只发给你信任的人。",
  fpLabel: "星系群",
  copyLink: "复制链接",
  messageWatch: "打开这条链接就能看：",
  messageJoin: "把 Claude Code 也接进来：把这段发给它",
  /**
   * 发给 Claude Code 的那段话（group.ts 的 joinPrompt）：只说按顺序跑几行命令、照最后一行的输出说。会分享什么、怎么加密、
   * 要不要改名字，由最后一行（插件的 --welcome）打印出来交给 Claude；它还会打开浏览器、飞进你的星系。
   * cmds 是几行命令，在卡片里画成命令（等宽、一行、太长用省略号收掉）
   */
  joinPrompt: (cmds: string[]) => [
    "帮我接入这个 Agent Loop 星系群：在终端按顺序运行下面几行（装过也照样运行）。最后一行会在浏览器里打开我的星系，再照它的输出告诉我接下来怎么做。如果设了 CLAUDE_CONFIG_DIR，最后一行里的 $HOME/.claude 换成它。",
    ...cmds,
  ].join("\n"),
  copyPrompt: "复制给 Claude Code 的话", later: "以后再说",
  welcomeTitle: "你加入了这个星系群",
  welcomeDesc: "现在能看到群里每个人的星系。想把你自己的 Claude Code 也接进来，把下面这段发给它：",
  welcomeLater: "以后在右上角的「邀请」里还能找到。",
  // 用接入命令打开的页面（&welcome）：飞进你的星系，底下一张卡片
  hiTitle: "这是你的星系",
  hiDesc: "每个 Claude Code 对话是一颗行星，每调用一次工具射出一道光。刚才那个对话已经在这里了；在 Claude Code 里执行下面这条命令以后，它的每一步都会画出来。之后新开的对话会自己出现。",
  hiFine: "随时按 M 飞回你的星系；想邀请别人进来，点右上角的「邀请」。",
  hiGo: "开始看",
  copied: "已复制", copyFailed: "复制不了：已选中，请按 Ctrl+C", close: "关闭",
  needTitle: "这台服务器上的星系群要邀请链接才能看",
  needDesc: "邀请链接里带着星系群的密钥（#k=…），服务器只拿得到加密后的内容。把收到的邀请链接粘到这里：",
  pastePlaceholder: "https://…/#k=…", join: "加入",
  createTitle: "或者建一个自己的星系群",
  createDesc: "建群在 Claude Code 里做：运行下面这条命令。密钥在你的电脑上生成，不经过服务器；你的星系会搬进新群，浏览器里会打开邀请链接。",
  createNeed: (v: string) => `这条命令要 Agent Loop 插件 ${v} 或更新。Claude Code 说没有这条命令的话，先在终端运行下面两行，再重启 Claude Code：`,
  createdTitle: "星系群建好了",
  createdDesc: "你的星系已经搬进这个新群了。链接就是这个群的全部权限：丢了就进不来，泄露了别人就能进来。先存好，再把它和第 ② 段发给你信任的人。在 Claude Code 里运行 /reload-plugins，刚才那个对话的每一步就会画出来。",
  deniedTitle: "这条邀请链接进不去",
  deniedDesc: "可能是链接不完整，或者这台服务器只接受名单里的星系群。",
  badLink: "认不出这条链接：要有 #k= 后面 43 个字符的密钥",
  groupFp: (fp: string) => `这个星系群的指纹：${fp}。群里每个人的页面右上角都以它开头，可以和对方核对`,
  switchTitle: "这条链接要把你带到另一个星系群",
  switchDesc: "这个浏览器已经在一个星系群里了。换过去以后，它不再保存现在这个群的密钥：想回来，要重新打开那个群的邀请链接。",
  switchCur: "现在的星系群", switchNext: "链接里的星系群",
  switchWarn: "不认识发链接的人，或者没打算换群：留在现在的群。",
  switchStay: "留在现在的群", switchGo: "换过去",
  switchCreatedTitle: "换到刚建好的星系群？",
  switchCreatedDesc: "这条链接说它是 /agent-loop:create 刚建的群：你的星系已经搬过去了，新群的邀请链接只在换过去以后的页面上拿得到。这个浏览器现在看的是另一个群。",
  switchCreatedWarn: "不是你刚在 Claude Code 里运行的 /agent-loop:create 打开的：留在现在的群。留下以后想看新群，在 Claude Code 里运行 /agent-loop:galaxy，会再打开它。",
  leaveGroup: "清除缓存",
  leaveTitle: "清除这个浏览器里的星系群缓存？",
  leaveDesc: "这个浏览器会忘掉这个群的密钥，不再能看它。你的星系报给哪里不受影响。想回来，要重新打开邀请链接。",
  leaveMine: "你的星系还在往这个群上报：这里只是不看了，群里的人照样看得到你。要让星系也退出，在 Claude Code 里运行：",
  leaveGo: "清除", leaveStay: "取消",
  // /agent-loop:leave 退出以后打开的页面（#left=）
  leftTitle: (fp: string) => `已退出星系群 ${fp}`,
  leftDesc: "你的星系已经从这个群里移走，服务器上存着的完整步骤也删了。这台电脑上的会话不再往这个群上报。",
  leftKept: "服务器没收到退出的通知：你的星系还会在群里留一阵（30 分钟后显示为可能已关闭，大约一天内消失）。服务器连得上时再运行一次 /agent-loop:leave，就会马上移走。这台电脑上的会话已经不再往这个群上报。",
  leftOther: (fp: string) => `这个浏览器看的是另一个星系群（${fp}），没有动它。`,
  leftBack: "这个浏览器已经清掉了这个群的密钥，看不到它了。想回这个群，在 Claude Code 里运行：",
  leftLocal: "想在本机看自己的星系：用 /plugin configure agent-loop@agent-loop 把 server_url 改回 http://127.0.0.1:4317。",
  leftPaste: "想看别的星系群，把它的邀请链接粘到这里：",
  leftOk: "知道了",
  insecure: "连接没有加密传输",
  insecureTitle: "用 http:// 打开的：内容仍然是端到端加密的，但页面本身可能被人改掉。正式使用请用 HTTPS",
  groupMode: "星系群",
  // 演示站
  updateMine: (v: string, latest: string) => `Agent Loop 插件有新版本 ${latest}（你的是 ${v || "更早的版本"}）。在终端运行下面两行，再重启 Claude Code：`,
  updateOther: (v: string, latest: string) => `这个星系的插件不是最新的（${v || "更早的版本"} → ${latest}），可以提醒它的主人更新：`,
  demoNote: "这是演示数据",
  demoInstall: "装到自己的 Claude Code →",

  offlineTitle: "(未连接) ",
  reconnecting: "服务未连接，正在重连…",
  noServer: "连不上服务：先运行 npx agent-loop-viz（只想看看样子，地址后加 ?demo）",
};

type Strings = typeof zh;

const en: Strings = {
  htmlLang: "en",
  static: { ctxTokens: "Context tokens", outTokens: "Output tokens", status: "Status", galaxy: "Galaxy", current: "Now", subagents: "Agents",
            asked: "Asked", answer: "Answer", model: "Model", input: "Input", output: "Output" },
  toggle: "中文",
  toggleTitle: "切换到中文",

  kindDone: {
    read: "Read files", edit: "Edit files", search: "Search code", shell: "Run command", web: "Web search", agent: "Subagent",
    ask: "Ask you", plan: "Approve plan", progress: "Update tasks", mcp: "External service", other: "Tool call",
  },
  status: { idle: "Idle", waiting: "Waiting for you", done: "Done", error: "Error" },
  thinking: "Thinking", acting: "Working", bgWait: "Background", stale: "May be closed",

  session: (i: number) => `Session ${i}`,
  lap: (i: number) => `Lap ${i}`,
  steps: (k: number) => n(k, "step"),
  lapsUnder: (k: number, steps: number) => `${k === 1 ? "lap" : "laps"} · ${n(steps, "step")}`,
  failed: "failed",
  bgRunning: (k: number) => k > 1 ? `${k} background tasks running` : "Background task running",
  waited: (d: string) => "waiting " + d,
  subagent: "Subagent", customSubagent: "Custom subagent", custom: "custom",
  subagents: (k: number) => n(k, "subagent"),
  moreSubagents: (k: number) => `${n(k, "more subagent")}`,

  tool: {
    shell: (o: string) => `Run ${o}`, read: (o: string) => `Read ${o}`, edit: (o: string) => `Edit ${o}`, write: (o: string) => `Write ${o}`,
    grep: (o: string) => `Search ${o}`, glob: (o: string) => `Find files ${o}`, fetch: (o: string) => `Open ${o}`, search: (o: string) => `Web search ${o}`,
    agent: (o: string) => `Subagent ${o}`.trim(), ask: (o: string) => (o ? `Ask: ${o}` : "Asking you"), plan: "Approve plan",
    skill: (o: string) => `Skill ${o}`, mcp: (server: string, tool: string) => (tool ? `Call ${server} · ${tool}` : `Call ${server}`),
    progress: "Update tasks", other: (name: string) => `Call ${name}`,
  },
  want: (p: string) => `Wants to ${p.charAt(0).toLowerCase()}${p.slice(1)}`,
  waitPermission: "needs your approval",
  detailLoading: "Loading…", detailGone: "Above context is compacted",
  detailLocked: "Can't decrypt this (wrong key in the invite link)",
  detailClose: "Close (Esc)",
  stdout: "stdout", stderr: "stderr", file: "File", matches: (k: number) => n(k, "match", "matches"), files: (k: number) => n(k, "file"),
  duration: "Duration", errorLabel: "Error",

  galaxyCaption: (g: string, p: number, s: number, w: number) => `${g} · ${n(p, "project")} · ${n(s, "session")} · ${w} running`,
  galaxyQuiet: (g: string) => `${g} · no sessions running`,
  hintFocus: "Esc back · ← → switch session · click a step for details",
  hintGalaxy: "Drag to rotate · scroll to zoom · Esc back to the group",
  hintZoomed: "Drag to pan · scroll to zoom · Esc back to overview",

  universeCaption: (g: number, s: number, w: number) => `${n(g, "galaxy", "galaxies")} · ${n(s, "session")} · ${w} running`,
  universeEmpty: "No galaxies running in this group yet",
  hintUniverse: "Drag to pan · scroll to zoom · click a glow to fly in",
  yourGalaxy: "Your galaxy", galaxy: "Galaxy",
  locateMine: "My galaxy", locateTitle: "Find your galaxy in the group (M)",
  mineAbsent: "Your galaxy has no sessions right now, so it isn't shown in the group",
  galaxySize: (p: number, s: number) => `${n(p, "project")} · ${n(s, "session")}`,
  counts: {
    think: (k: number) => `${k} thinking`, act: (k: number) => `${k} working`, wait: (k: number) => `${k} need you`,
    bg: (k: number) => `${k} background`, err: (k: number) => `${k} failed`, done: (k: number) => `${k} done`,
    idle: (k: number) => `${k} idle`, stale: (k: number) => `${k} may be closed`,
  },

  invite: "Invite",
  inviteTitle: "Invite others",
  inviteDesc: "Send them the link and the message for Claude Code. The link is this group's key, so only share it with people you trust.",
  fpLabel: "GROUP",
  copyLink: "Copy link",
  messageWatch: "Open this link to watch:",
  messageJoin: "To connect Claude Code too, send it this:",
  joinPrompt: (cmds: string[]) => [
    "Connect me to this Agent Loop galaxy group: run these lines in a terminal, in order (even if the plugin is already installed). The last one opens my galaxy in the browser; then tell me what its output says to do next. If CLAUDE_CONFIG_DIR is set, use it in place of $HOME/.claude in the last line.",
    ...cmds,
  ].join("\n"),
  copyPrompt: "Copy for Claude Code", later: "Later",
  welcomeTitle: "You joined this galaxy group",
  welcomeDesc: "You can now watch everyone's galaxies here. To connect your own Claude Code too, send it this:",
  welcomeLater: "You can find this again under Invite at the top right.",
  hiTitle: "This is your galaxy",
  hiDesc: "Each Claude Code session is a planet, and each tool call sends out a ray. The session you just used is here already; run this in Claude Code and every step it takes will be drawn. Sessions you open later show up on their own.",
  hiFine: "Press M any time to fly back to your galaxy. To invite others, use Invite at the top right.",
  hiGo: "Start watching",
  copied: "Copied", copyFailed: "Couldn't copy: selected, press Ctrl+C", close: "Close",
  needTitle: "Galaxy groups on this server need an invite link",
  needDesc: "The invite link carries the group's key (#k=…); the server only ever sees encrypted content. Paste the link you received:",
  pastePlaceholder: "https://…/#k=…", join: "Join",
  createTitle: "Or make a galaxy group of your own",
  createDesc: "Groups are created in Claude Code: run the command below. The key is generated on your computer and never sent to the server; your galaxy moves into the new group and its invite link opens in the browser.",
  createNeed: (v: string) => `This command needs Agent Loop plugin ${v} or newer. If Claude Code says there is no such command, run these two lines in a terminal first, then restart Claude Code:`,
  createdTitle: "Your galaxy group is ready",
  createdDesc: "Your galaxy has moved into this new group. The link is the only key to it: lose it and you can't get back in, leak it and others can. Save it first, then send it with part ② to people you trust. Run /reload-plugins in Claude Code and every step of the session you just used will be drawn.",
  deniedTitle: "This invite link doesn't open anything here",
  deniedDesc: "The link may be incomplete, or this server only accepts the groups on its list.",
  badLink: "That doesn't look like an invite link: it needs a 43-character key after #k=",
  groupFp: (fp: string) => `This group's fingerprint: ${fp}. Everyone in the group sees it start the same way in the top-right corner, so you can compare.`,
  switchTitle: "This link leads to a different galaxy group",
  switchDesc: "This browser is already in a galaxy group. If you switch, it stops keeping the current group's key: to come back you'll need that group's invite link again.",
  switchCur: "Current group", switchNext: "Group in the link",
  switchWarn: "If you don't know who sent the link, or didn't mean to switch groups, stay where you are.",
  switchStay: "Stay", switchGo: "Switch",
  switchCreatedTitle: "Switch to the group you just created?",
  switchCreatedDesc: "This link says it is a group just made by /agent-loop:create: your galaxy has already moved there, and the new group's invite link is only available on the page after switching. This browser is watching a different group right now.",
  switchCreatedWarn: "If it wasn't opened by /agent-loop:create that you just ran in Claude Code, stay where you are. If you stay and want the new group later, run /agent-loop:galaxy in Claude Code to open it again.",
  leaveGroup: "Clear cache",
  leaveTitle: "Clear this galaxy group from this browser?",
  leaveDesc: "This browser forgets the group's key and can no longer watch it. Where your galaxy reports is not affected. To come back you'll need the invite link again.",
  leaveMine: "Your galaxy is still reporting to this group: this only stops you watching, and the group can still see you. To take your galaxy out too, run this in Claude Code:",
  leaveGo: "Clear", leaveStay: "Cancel",
  leftTitle: (fp: string) => `Left galaxy group ${fp}`,
  leftDesc: "Your galaxy has been removed from this group, together with the full step details stored on the server. Sessions on your computer no longer report to it.",
  leftKept: "The server was not told that you left: your galaxy stays in the group for a while (shown as possibly closed after 30 minutes, gone within about a day). Run /agent-loop:leave again once the server is reachable to remove it right away. Sessions on your computer no longer report to this group.",
  leftOther: (fp: string) => `This browser is watching a different galaxy group (${fp}); that one is left alone.`,
  leftBack: "This browser has cleared the group's key and can no longer see it. To rejoin this group, run in Claude Code:",
  leftLocal: "To see your galaxy on your own computer instead, set server_url back to http://127.0.0.1:4317 with /plugin configure agent-loop@agent-loop.",
  leftPaste: "To watch another galaxy group, paste its invite link here:",
  leftOk: "Got it",
  insecure: "Connection not encrypted",
  insecureTitle: "Opened over http://. Content is still end-to-end encrypted, but the page itself could be tampered with. Use HTTPS for real use",
  groupMode: "GROUP",
  updateMine: (v: string, latest: string) => `Agent Loop plugin ${latest} is available (yours is ${v || "an older version"}). Run these in a terminal, then restart Claude Code:`,
  updateOther: (v: string, latest: string) => `This galaxy's plugin is out of date (${v || "older"} → ${latest}). You could ask its owner to update:`,
  demoNote: "Demo data",
  demoInstall: "Install for your own Claude Code →",

  offlineTitle: "(offline) ",
  reconnecting: "Lost the server, reconnecting…",
  noServer: "Can't reach the server: run npx agent-loop-viz first (just looking? add ?demo to the address)",
};

export const T: Strings = LANG === "zh" ? zh : en;

const $mineText = () => document.getElementById("mine-t") as HTMLElement;   // 按钮里还有图标，只换文字

/** 填上 index.html 里写死的标签，挂上右上角的语言切换 */
export function applyStatic() {
  document.documentElement.lang = T.htmlLang;
  for (const el of document.querySelectorAll<HTMLElement>("[data-t]")) {
    const k = el.dataset.t as keyof Strings["static"];
    if (k in T.static) el.textContent = T.static[k];
  }
  const mine = document.getElementById("mine");
  if (mine) { $mineText().textContent = T.locateMine; mine.title = T.locateTitle; }
  const btn = document.getElementById("lang") as HTMLButtonElement | null;
  if (!btn) return;
  btn.textContent = T.toggle; btn.title = T.toggleTitle;
  btn.onclick = () => {
    const other: Lang = LANG === "zh" ? "en" : "zh";
    let stored = false;
    try { localStorage.setItem(KEY, other); stored = true; } catch { /* 存不了：只靠地址换这一次 */ }
    if (stored && !params.has("lang")) { location.reload(); return; }
    const q = new URLSearchParams(location.search);
    if (stored) q.delete("lang"); else q.set("lang", other);
    const s = q.toString().replace(/=(?=&|$)/g, "");   // ?demo 别变成 ?demo=
    location.replace(`${location.pathname}${s ? "?" + s : ""}${location.hash}`);
  };
}
