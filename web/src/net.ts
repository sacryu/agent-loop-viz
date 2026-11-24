// 和服务器的连接（WebSocket /ws）。
// 断了先不声张（自己会重连，重启服务也就一两秒）；过了 LOST_GRACE_MS 还没连上，就照实说：
// 画面变暗、停转，计时停住，标签页标题标上「未连接」。连回来一切照常。一开始就连不上时不等，直接说。
// 非本机的服务器：连上以后第一条消息发 {"join": "<口令>"}（口令由邀请链接里的密钥派生，不放在网址里，免得进日志）。
// 服务器认不出这个口令（白名单模式下不在名单里）会以 4403 断开，没发 join 就要数据会以 4401 断开：这两种不再重连。
import { fullKey, type ClientMsg, type FullSlot, type ServerMsg } from "@agent-loop/shared/browser";
import { ATT } from "./attach.ts";
import { $, clock, now } from "./util.ts";
import { T } from "./i18n.ts";

export const LOST_GRACE_MS = 3000;
export const conn = {
  ever: false, lost: false, timer: null as ReturnType<typeof setTimeout> | null,
  local: false, open: false, hello: false,
  /** 服务器拒绝了：口令不对，或者星系群不在名单里 */
  denied: false,
};

let ws: WebSocket | null = null;
let focusWanted: string | null = null;
let access: string | null = null;
let handler: (m: ServerMsg) => void = () => {};
let onState: () => void = () => {};
/** 服务器拒绝了（4403）、或者没进群被断开（4401）以后停着不重连：换了口令（setAccess）时用它连回去 */
let reopen: (() => void) | null = null;
const fullWait = new Map<string, ((x: string | object | null) => void)[]>();

function updateTitle() {
  document.title = (conn.lost ? T.offlineTitle : "") + "Agent Loop";
}

function connLost() {
  if (conn.timer || conn.lost) return;
  conn.timer = setTimeout(() => {
    conn.timer = null; conn.lost = true; clock.stop = now();
    $("conn").textContent = conn.ever ? T.reconnecting : T.noServer;
    updateTitle();
  }, conn.ever ? LOST_GRACE_MS : 0);
}

function connOk() {
  if (conn.timer) clearTimeout(conn.timer);
  conn.timer = null; conn.ever = true;
  if (conn.lost) { conn.lost = false; clock.stop = null; updateTitle(); }
}

const sendMsg = (m: ClientMsg) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

export function setFocus(id: string | null) {
  focusWanted = id;
  sendMsg({ focus: id });
}

/**
 * 换了星系群（加入、创建）：重新连。连着的就断开，onclose 会接着重连；
 * 已经停下了（没进群的连接 10 秒后被服务器断开、口令被拒）就直接连一次，不然页面永远进不了群
 */
export function setAccess(a: string | null) {
  access = a;
  conn.denied = false;
  if (ws) ws.close();
  else if (reopen) { const f = reopen; reopen = null; f(); }
}

/** 要一个大附件：只能是正在看的星系里的。8 秒没回就算没有 */
export function requestFull(sid: string, slot: FullSlot, k: string): Promise<string | object | null> {
  return new Promise(res => {
    const key = fullKey(sid, slot, k);
    const list = fullWait.get(key) ?? [];
    list.push(res);
    fullWait.set(key, list);
    sendMsg({ full: { sid, slot, k } });
    setTimeout(() => { const l = fullWait.get(key); if (l?.includes(res)) { l.splice(l.indexOf(res), 1); res(null); } }, 8000);
  });
}

export function connect(onMsg: (m: ServerMsg) => void, changed: () => void) {
  handler = onMsg; onState = changed;
  let retry = 500;
  const open = () => {
    let sock: WebSocket;
    try { sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${location.pathname.replace(/[^/]*$/, "")}ws`); }
    catch { connLost(); setTimeout(open, LOST_GRACE_MS); return; }   // 比如直接双击打开了文件
    ws = sock;
    sock.onopen = () => { retry = 500; };
    sock.onmessage = e => {
      let m: ServerMsg;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.t === "hello") {
        conn.local = m.local; conn.open = !!m.open; conn.hello = true; ATT.plain = m.local; connOk();
        if (!m.local && access) sendMsg({ join: access });
        if (m.local || access) { if (focusWanted) setFocus(focusWanted); }
        onState();
      }
      clock.off = m.now - Date.now();
      if (!conn.lost) clock.stop = null;
      if (m.t === "full") {
        const key = fullKey(m.sid, m.slot, m.k), l = fullWait.get(key);
        if (l) { fullWait.delete(key); for (const f of l) f(m.x); }
        return;
      }
      handler(m);
    };
    sock.onclose = e => {
      if (ws === sock) ws = null;
      if (e.code === 4403) { conn.denied = true; reopen = open; onState(); return; }   // 口令不对：重连也没用，等用户换一条邀请链接
      if (e.code === 4401 && !access) { reopen = open; onState(); return; }           // 一直没进群：等用户建群或者粘一条链接
      connLost();
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 5000);
    };
    sock.onerror = () => { /* onclose 会接着来 */ };
  };
  open();
}

export const debugConn = () => ({ ever: conn.ever, lost: conn.lost, waiting: !!conn.timer, title: document.title, open: ws?.readyState === WebSocket.OPEN,
  local: conn.local, denied: conn.denied });
