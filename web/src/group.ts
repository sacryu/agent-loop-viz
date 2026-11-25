// 星系群：邀请链接里的密钥、看哪个群、邀请。
// 页面只负责看：「你的星系在哪个群」只由插件管（建群 /agent-loop:create、退出 /agent-loop:leave、回去 /agent-loop:rejoin），
// 页面跟着插件打开的链接走。以前页面上也能建群，可浏览器记下的群和插件报给的群各记各的，对不上时人就糊涂了。
// 打开邀请链接（#k=<K>）：页面把 K 存进浏览器（localStorage，按服务器的地址分开），从地址栏去掉，然后看这个星系群。
// 浏览器里已经存着另一个星系群的 K 时不直接换：先问（offerSwitch）。
// 「清除缓存」只是让这个浏览器忘掉 K；你的星系要在 Claude Code 里用 /agent-loop:leave 退（页面没有安装密钥，
// 而凭 K 就能把星系移出群的话，群里谁都能踢别人）。
// /agent-loop:leave 退出以后打开 #left=<群编号前 16 位>：浏览器里存着的是这个群的密钥就清掉，再显示已经退出了（noteLeft、forgetLeft）。
// K 永远不发给服务器：发过去的只是由它派生的口令（net.ts 的 join）。解附件用的内容密钥只在这个页面里。
import { CREATE_SINCE, KEY43_RE } from "@agent-loop/shared/browser";
import { ATT, setKeys } from "./attach.ts";
import { deriveKeys } from "./crypto.ts";
import { T } from "./i18n.ts";
import { joinCommands } from "./links.ts";
import { conn, setAccess } from "./net.ts";
import { UPDATE_CMDS } from "./update.ts";
import { el, setStyle } from "./util.ts";

const K_KEY = "agent-loop.k";

function storedK(): string | null {
  try { const s = localStorage.getItem(K_KEY); return s && KEY43_RE.test(s) ? s : null; } catch { return null; }
}

/**
 * 页面打开时、地址变了时：地址里的 K（incoming，main.ts 的 readHash 读出来的，格式不对的当作没有）和浏览器里存着的 K，该用哪个。
 *   use：现在就用的。浏览器里没存过就是地址里的那个，存过就还是存着的那个
 *   ask：地址里带来的另一个 K。不替人换：别人发来一条带 #k= 的链接，点开不该把你原来的密钥冲掉，
 *        也不该一声不响把你带进他的星系群（里面的星系可以起成你朋友的名字）。问过再换，见 offerSwitch
 */
export function takeK(incoming: string | null): { use: string | null; ask: string | null; fresh: boolean } {
  const stored = storedK();
  if (incoming) leftNote = null;   // 又打开了一条邀请链接：「已经退出」那句不用再说
  if (!incoming || incoming === stored) return { use: stored, ask: null, fresh: false };
  if (!stored) return { use: incoming, ask: null, fresh: true };   // fresh：这个浏览器第一次用邀请链接进群
  return { use: stored, ask: incoming, fresh: false };
}

/**
 * /agent-loop:leave 打开的页面（report.mjs 的 leaveOrRejoin）：#left=<群编号前 16 位>，服务器没收到退出的通知时带 &kept。
 * main.ts 的 readHash 读出来、从地址栏去掉，在这里记下来，由 forgetLeft 处理。网址里没有密钥：前 16 位就是页面上人人看得到的指纹
 */
let leftNote: { prefix: string; kept: boolean; other: string | null } | null = null;
export function noteLeft(prefix: string, kept: boolean) {
  leftNote = { prefix, kept, other: null };
}

/**
 * 退出了的那个群：这个浏览器正在看的（或者存着的）是它，就清掉密钥和「我的星系」的记号。
 * 只认指纹对得上的：别人发一条带 #left= 的链接，不能让你的浏览器忘掉另一个群。
 * 然后摆出「已经退出」：浏览器里没有密钥了，就在「要邀请链接」那张里说（syncGroupUi 会弹它）；还在看别的群，弹一张不挡画面的卡片
 */
export async function forgetLeft() {
  const note = leftNote;
  if (!note) return;
  const k = storedK(), cur = ATT.keys ?? (k ? await deriveKeys(k) : null);
  if (cur && cur.group.startsWith(note.prefix)) {
    forgetK();
    groupHooks.forgetMine();
  } else note.other = cur?.group ?? null;
  if (ATT.keys) showLeftDock();
  else if (conn.hello) syncGroupUi();
}

/**
 * 星系群的指纹：编号开头的几个字符，四个一组。同一个群里每个人看到的都一样，用来分辨「我现在在哪个群」。
 * 短的（8 个字符）放在右上角当标签；长的（16 个字符）用在邀请和换群的面板里，给人互相核对用
 */
export function fingerprint(group: string, short = false): string {
  return (group.slice(0, short ? 8 : 16).match(/.{1,4}/g) ?? []).join(" ");
}

/** 用一个 K 加入星系群：派生密钥，告诉 net.ts 换口令重连 */
export async function useK(k: string): Promise<boolean> {
  const keys = await deriveKeys(k);
  if (!keys) return false;
  try { localStorage.setItem(K_KEY, k); } catch { /* ignore */ }
  setKeys(keys);
  setAccess(keys.access);
  setStyle("insecure", "display", keys.native ? "none" : "");
  return true;
}

/** 这台服务器的地址（页面所在的目录，结尾的 / 去掉），和插件 server_url 里 #k= 前面那段一样 */
const serverBase = () => `${location.origin}${location.pathname.replace(/[^/]*$/, "")}`.replace(/\/+$/, "");
export const inviteLink = () => (ATT.keys ? `${serverBase()}/#k=${ATT.keys.k}` : "");

// ------------------------------------------------------------------ 面板

const panel = () => document.getElementById("panel") as HTMLElement;
/** 换群的那一问正开着：这时候别的面板（「要邀请链接」「进不去」）不来顶掉它 */
let asking = false;
/** 开着的是哪一种「粘贴邀请链接」面板（showJoin）。连接状态再变一次时同一种不重画，免得清掉正在粘的链接 */
let joinShown: boolean | null = null;
export const closePanel = () => { asking = false; joinShown = null; panel().classList.remove("open", "dock"); panel().textContent = ""; };
export const panelOpen = () => panel().classList.contains("open");

function show(...nodes: Node[]) {
  const p = panel();
  asking = false; joinShown = null;
  p.textContent = "";
  p.append(...nodes);
  p.classList.remove("dock");
  p.classList.add("open");
}

/**
 * 链接里带来了另一个星系群的密钥（takeK 的 ask）：摆出两个群的指纹，问过再换。
 * 是同一个群（同一个密钥的另一种写法）就什么都不做。then：链接是插件打开的（&welcome、&created），换过来以后弹那张卡片。
 * &created 也要问：记号谁都能加在链接里，不问的话别人发一条带 &created 的链接就能把你的浏览器一声不响带进他的群。
 * 只是话换成「是不是你刚跑的 /agent-loop:create」，并说清楚留下以后怎么再打开（新群的邀请链接只在页面上拿得到）
 */
export async function offerSwitch(k: string, then: Arrival | null = null) {
  const next = await deriveKeys(k), cur = ATT.keys;
  if (!next) return;
  // 存着的那个用不了：没有什么可冲掉的，直接换，该弹的卡片照弹（调用的地方等着这里弹）
  if (!cur) { if (await useK(k) && then) showArrival(then); return; }
  if (next.group === cur.group) return;
  const created = then === "created";
  const row = el("div", undefined, "row");
  row.append(btn(T.switchStay, () => { closePanel(); syncGroupUi(); }), btn(T.switchGo, () => { closePanel(); void useK(k).then(ok => { if (ok) { if (then) showArrival(then); else showWelcome(); } }); }));
  show(el("h2", created ? T.switchCreatedTitle : T.switchTitle), el("p", created ? T.switchCreatedDesc : T.switchDesc),
    el("pre", `${T.switchCur}  ${fingerprint(cur.group)}\n${T.switchNext}  ${fingerprint(next.group)}`),
    el("p", created ? T.switchCreatedWarn : T.switchWarn, "warn"), row);
  asking = true;
}

/**
 * 复制一段文字。navigator.clipboard 只在 HTTPS 或 localhost 下有：用 http://<IP> 打开时（内网的服务器）它是 undefined，
 * 退回老办法：选中一个临时的输入框，再 execCommand("copy")。两条路都不行返回 false
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* 没给权限、页面不在前台：试老办法 */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.readOnly = true;
  ta.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(ta);
  let ok = false;
  try { ta.select(); ta.setSelectionRange(0, text.length); ok = document.execCommand("copy"); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

/** 「复制」按钮。shown：页面上写着这段文字的那个元素；实在复制不了时把它选中，让人自己按 Ctrl+C，并照实说 */
function copyBtn(text: () => string, shown: HTMLElement | undefined, label: string, cls = "pill"): HTMLElement {
  const b = el("button", label, cls) as HTMLButtonElement;
  b.type = "button";
  let timer: ReturnType<typeof setTimeout> | null = null;
  b.onclick = async () => {
    const ok = await copyText(text());
    if (!ok && shown) { const r = document.createRange(); r.selectNodeContents(shown); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); }
    b.textContent = ok ? T.copied : T.copyFailed;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { b.textContent = label; }, ok ? 1500 : 4000);
  };
  return b;
}
function btn(text: string, f: () => void, cls = "pill"): HTMLElement {
  const b = el("button", text, cls) as HTMLButtonElement;
  b.type = "button"; b.onclick = f;
  return b;
}

/**
 * 发给 Claude Code 的那段话：一句话加两行安装命令（文字在 i18n 的 joinPrompt）。
 * 会分享什么、怎么加密、要不要改 name 和 share，插件生效后由插件自己交给 Claude（report.mjs 的 helloContext）
 */
export function joinPrompt(link: string): string {
  return T.joinPrompt(joinCommands(link));
}

/** 发给 Claude Code 的那段话，画在卡片里：说明照常折行，两行安装命令一行一条、太长的用省略号收掉（悬停看全文，复制出去的是完整的） */
function promptBox(link: string): HTMLElement {
  const box = el("div", undefined, "prompt"), cmds = new Set(joinCommands(link));
  for (const line of joinPrompt(link).split("\n")) {
    if (cmds.has(line)) { const d = el("div", line, "cmd"); d.title = line; box.append(d); }
    else box.append(el("div", line || " ", line ? "say" : "gap"));
  }
  return box;
}

/** 卡片的头：一行小字的星系群指纹（悬停看说明）、标题、右上角的 × */
function head(title: string): Node[] {
  const x = el("button", "×", "x") as HTMLButtonElement;
  x.type = "button"; x.title = T.close; x.onclick = closePanel;
  const nodes: Node[] = [x];
  if (ATT.keys) {
    const k = el("div", T.fpLabel + " ", "kicker"), fp = el("span", fingerprint(ATT.keys.group), "fp");
    k.title = T.groupFp(fingerprint(ATT.keys.group));
    k.append(fp);
    nodes.push(k);
  }
  nodes.push(el("h2", title));
  return nodes;
}

/** 卡片底下一行：左边是次要的文字按钮，右边是复制按钮（一个或两个） */
function foot(left: HTMLElement | null, ...right: HTMLElement[]): HTMLElement {
  const f = el("div", undefined, "foot"), r = el("div", undefined, "btns");
  r.append(...right);
  f.append(left ?? el("span"), r);
  return f;
}

/** 邀请、建好群两个面板共用：卡片里 ① 看的链接、② 发给 Claude Code 的那段，底下「复制链接」「复制给 Claude Code 的话」各复制一样 */
function inviteNodes(link: string, desc: string, left: HTMLElement | null): Node[] {
  const card = el("div", undefined, "msg");
  const step = (n: string, text: string) => { const d = el("div", undefined, "step"); d.append(el("span", n, "n"), el("span", text)); return d; };
  const url = el("div", link, "url"), box = promptBox(link);
  url.title = link;
  card.append(step("①", T.messageWatch), url, step("②", T.messageJoin), box);
  return [el("p", desc), card,
    foot(left, copyBtn(() => link, url, T.copyLink), copyBtn(() => joinPrompt(link), box, T.copyPrompt, "pill primary"))];
}

/** 「邀请」：看的链接、发给 Claude Code 的那段，两个复制按钮。左下角是「清除缓存」 */
export function showInvite() {
  const link = inviteLink();
  if (!link) return;
  show(...head(T.inviteTitle), ...inviteNodes(link, T.inviteDesc, btn(T.leaveGroup, askLeave, "textbtn")));
}

/** main.ts 接上：你的星系在不在这个群里、不再看以后清掉画面、退出了群以后忘掉「我的星系」 */
export const groupHooks = { mineHere: () => false, left: () => {}, forgetMine: () => {} };

/** 不再看之前问一句。你的星系还在这个群里时说清楚：这里只是这个浏览器不看了，星系要在 Claude Code 里退 */
function askLeave() {
  const nodes: Node[] = [el("h2", T.leaveTitle), el("p", T.leaveDesc)];
  if (groupHooks.mineHere()) {
    const cmd = el("pre", "/agent-loop:leave");
    nodes.push(el("p", T.leaveMine, "warn"), cmd);
  }
  const row = el("div", undefined, "row");
  row.append(btn(T.leaveGo, leaveGroup), btn(T.leaveStay, showInvite));
  show(...nodes, row);
}

/** 忘掉密钥，断开重连（不再发 join），清掉画面 */
function forgetK() {
  try { localStorage.removeItem(K_KEY); } catch { /* ignore */ }
  setKeys(null);
  setStyle("insecure", "display", "none");
  groupHooks.left();
  closePanel();
  setAccess(null);
}
/** 「清除缓存」：这个浏览器不再看这个星系群，回到「粘贴邀请链接」 */
function leaveGroup() {
  forgetK();
  syncGroupUi();
}

/**
 * 刚用邀请链接加入星系群（这个浏览器第一次进这个群，或者问过以后换过来）：告诉对方怎么把自己的星系也接进来。
 * 不弹给 /galaxy 打开的页面（带 &mine 的，那是已经接上的人），由调用的地方判断
 */
export function showWelcome() {
  const link = inviteLink();
  if (!link || asking) return;
  const box = promptBox(link);
  box.classList.add("solo");
  show(...head(T.welcomeTitle), el("p", T.welcomeDesc), box, el("p", T.welcomeLater, "fine"),
    foot(btn(T.later, closePanel, "textbtn"), copyBtn(() => joinPrompt(link), box, T.copyPrompt, "pill primary")));
}

/** 插件打开页面时带的记号（main.ts 的 readHash）：hi 是接入命令的 &welcome，created 是 /agent-loop:create 的 &created */
export type Arrival = "hi" | "created";
export const showArrival = (a: Arrival) => (a === "created" ? showCreated() : showHi());

/**
 * 用接入命令打开的页面（&welcome）：已经飞进你的星系了，底下一张不挡画面的卡片，说这是你的星系、还差 /reload-plugins。
 * 换群的那一问正开着时不弹（换过来以后由 offerSwitch 弹）
 */
function showHi() {
  if (asking) return;
  const go = btn(T.hiGo, closePanel);
  go.classList.add("primary");
  show(...head(T.hiTitle), el("p", T.hiDesc), el("pre", "/reload-plugins"), el("p", T.hiFine, "fine"), foot(null, go));
  panel().classList.add("dock");
}

/**
 * /agent-loop:create 刚建好的群（&created）：你的星系已经搬进来了。邀请链接只在这里拿得到（命令的输出进对话，不带密钥），
 * 所以直接摆出邀请面板，再提醒 /reload-plugins
 */
function showCreated() {
  const link = inviteLink();
  if (!link || asking) return;
  show(...head(T.createdTitle), ...inviteNodes(link, T.createdDesc, null));
}

/** 非本机的服务器，页面却没有邀请链接（或者链接进不去）：粘一条进来。服务器收新群时提一句建群在 Claude Code 里 */
export function showJoin(denied: boolean) {
  // 刚用 /agent-loop:leave 退出（forgetLeft）：先说清楚退出了，再是粘贴链接、建群
  const nodes: Node[] = leftNote && !denied ? leftNodes(leftNote) : [el("h2", denied ? T.deniedTitle : T.needTitle), el("p", denied ? T.deniedDesc : T.needDesc)];
  const input = el("input") as HTMLInputElement;
  input.placeholder = T.pastePlaceholder;
  const msg = el("p", "", "warn");
  const join = async () => {
    const m = /(?:^|[#&])k=([A-Za-z0-9_-]{43})(?:&|$)/.exec(input.value.trim().replace(/^[^#]*/, ""));
    if (!m || !(await useK(m[1]))) { msg.textContent = T.badLink; return; }
    leftNote = null;
    closePanel();
    showWelcome();
  };
  input.onkeydown = e => { if (e.key === "Enter") void join(); };
  const row = el("div", undefined, "row");
  row.append(input, btn(T.join, () => void join()));
  nodes.push(row, msg);
  if (conn.open) {
    // 命令带上这台服务器的地址：不带的话插件建在它现在报给的服务器上（默认是本机，那里建不了群）
    // 建群是 CREATE_SINCE 那一版的插件才有的：旧插件没有这条命令，先给更新的命令
    nodes.push(el("h2", T.createTitle), el("p", T.createDesc), el("pre", `/agent-loop:create ${serverBase()}`),
      el("p", T.createNeed(CREATE_SINCE)), el("pre", UPDATE_CMDS.join("\n")));
  }
  show(...nodes);
  joinShown = denied;
}

/** 「已经退出星系群」：哪个群、服务器移走了没有、这个浏览器清掉了没有、想回去怎么做 */
function leftNodes(n: NonNullable<typeof leftNote>): Node[] {
  const nodes: Node[] = [el("h2", T.leftTitle(fingerprint(n.prefix))), el("p", n.kept ? T.leftKept : T.leftDesc, n.kept ? "warn" : undefined)];
  if (n.other) nodes.push(el("p", T.leftOther(fingerprint(n.other))));
  nodes.push(el("p", T.leftBack), el("pre", "/agent-loop:rejoin"), el("p", T.leftLocal), el("p", T.leftPaste));
  return nodes;
}
/**
 * 退出的是别的群，这个浏览器还在看它现在的群：底下一张不挡画面的卡片，只说没有动现在这个群。
 * 不说「你的星系已经移走」：指纹对不上时，这条 #left= 也可能是别人随手发来的
 */
function showLeftDock() {
  if (!leftNote || asking) return;
  const n = leftNote;
  leftNote = null;
  const ok = btn(T.leftOk, closePanel);
  ok.classList.add("primary");
  show(el("h2", T.leftTitle(fingerprint(n.prefix))), ...(n.other ? [el("p", T.leftOther(fingerprint(n.other)))] : []), foot(null, ok));
  panel().classList.add("dock");
}

/** 连接状态变了（net.ts 回调）：该弹的弹出来，「邀请」按钮该出现的出现 */
export function syncGroupUi() {
  const remote = conn.hello && !conn.local;
  setStyle("invite", "display", remote && ATT.keys && !conn.denied ? "" : "none");
  if (!remote || asking) return;
  if (leftNote && ATT.keys && !conn.denied) { showLeftDock(); return; }
  const want = conn.denied ? true : !ATT.keys ? false : null;
  // 有了能用的密钥（比如开着「要邀请链接」时地址栏换成了带 #k= 的链接）：「要邀请链接」那张不用再开着
  if (want === null) { if (joinShown !== null && panelOpen()) closePanel(); return; }
  if (!(panelOpen() && joinShown === want)) showJoin(want);
}
