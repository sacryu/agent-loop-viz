// 插件的版本：插件每次上报都在请求头里带上自己的版本，服务器记下哪些星系的插件比 PLUGIN_NAG_BELOW 旧，页面提示更新。
// 插件（report.mjs 的 PLUGIN_VERSION）、plugin.json 的 version 和这里三份一样，测试检查。
// 版本号只在发布插件（同步到公开仓库）时升，平时提交不升：本机的插件直接读仓库里的 plugin/，用不着版本号（docs/deploy.md §6）。

/** 这台服务器（和同一份代码里的插件）的插件版本：发布出去的最新版 */
export const PLUGIN_VERSION = "0.2.14";
/**
 * 比它旧的插件才在页面上提示更新（提示里说最新是 PLUGIN_VERSION）。只改了文案、输出的发布不升它，免得每发一版都去打扰所有人；
 * 修了会影响数据的 bug、协议变了、服务器不再收旧格式时，升到那一版。不能比 PLUGIN_VERSION 新（测试检查）
 */
export const PLUGIN_NAG_BELOW = "0.2.13";
/**
 * 第一个由插件建群（/agent-loop:create）的版本，链接也从这一版起用 #galaxy=、&created。插件和私有部署分开升级：
 *   页面：建群要这个版本以上的插件，「要邀请链接」面板里先给更新的命令
 *   插件：服务器（/healthz 的 version）比这个旧就不在那里建群、给 #g=（report.mjs 的 CREATE_SINCE，测试检查两份一样）
 */
export const CREATE_SINCE = "0.2.11";
/** 第一个认 /agent-loop:leave 打开的 #left= 的页面（report.mjs 的 LEFT_SINCE，测试检查两份一样）：比它旧的服务器插件不打开页面 */
export const LEFT_SINCE = "0.2.12";
/** 插件带版本用的请求头（小写） */
export const PLUGIN_HEADER = "x-agent-loop-plugin";
export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** 比较两个 x.y.z 版本（只比数字段）：a 旧返回负数，一样是 0，a 新是正数。可以直接给 sort 用 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x - y; }
  return 0;
}

/** v 比 latest 旧吗。v 为空（0.2.1 以前的插件不带版本）算旧 */
export function pluginOutdated(v: string, latest = PLUGIN_VERSION): boolean {
  return !VERSION_RE.test(v) || compareVersions(v, latest) < 0;
}
