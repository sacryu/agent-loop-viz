// 对外的链接（README、演示站的「装到自己的 Claude Code」、邀请面板里的命令都用它）。
export const REPO_URL = "https://github.com/sacryu/agent-loop-viz";
/** 插件市场：claude plugin marketplace add 后面跟的东西（GitHub 上的 owner/repo）。插件单独放在一个小仓库里（只有
 *  marketplace.json 和 plugin/，见 docs/deploy.md 的「插件的公开仓库」），已经装过的人都从这里更新，不要改 */
export const MARKETPLACE = "sacryu/agent-loop-plugin";

/**
 * 放进 shell 双引号里也不会被展开的链接：除了 URL 里常见的安全字符，其余一律按 UTF-8 百分号编码（按码点，emoji 也对）。
 * 页面路径来自地址栏，别人可以发来 https://服务器/$(命令)/#k=… 这样的链接（服务器对任何路径都回首页），
 * 不编码的话，「发给 Claude Code 的话」里的命令在 bash / PowerShell 里会执行它。编码后服务器看到的路径不变。
 * 只管 bash / zsh / PowerShell（Claude Code 跑命令用的就是这些）：已经编码好的 %XX 要原样留着，cmd.exe 的 %变量% 管不了
 */
export function shellSafeUrl(url: string): string {
  return url.replace(/%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9._~:/#=%\[\]-]/gu,
    ch => [...new TextEncoder().encode(ch)].map(b => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join(""));
}

/** 插件市场加进来以后，插件的上报脚本在哪（Claude Code 把市场克隆到 <配置目录>/plugins/marketplaces/<市场名>）。
 *  $HOME 在 bash、zsh、PowerShell 里都认（Windows 的 Git Bash 会把 /c/Users/… 转成 node 认的路径）。
 *  设了 CLAUDE_CONFIG_DIR 的人配置目录不在这里：没有一种写法三种 shell 都认，所以由那段话让 Claude 换成它（i18n 的 joinPrompt） */
export const WELCOME_SCRIPT = "$HOME/.claude/plugins/marketplaces/agent-loop/plugin/hooks/report.mjs";
/**
 * 接入自己的星系：一段发给 Claude Code 的话，让它在终端按顺序跑这几行。
 *   1、2 加插件市场，并拉到最新（加过的市场再 add 一次不会更新，旧的脚本不认第 4 行）
 *   3 claude plugin install --config server_url=… 把链接存进安全存储（和 /plugin configure 一样）；插件已经装过时再跑一次
 *     也会把链接换掉，所以换群也是这一句。由 Claude Code 的 Bash 跑，不进交互 shell 的历史（实测）
 *   4 插件的 --welcome：不等 /reload-plugins，把正在跑的这个会话报上去、在浏览器里打开你的星系（&welcome），
 *     把会分享什么、怎么加密打印出来交给 Claude（report.mjs 的 welcome）
 */
export function joinCommands(link: string): string[] {
  link = shellSafeUrl(link);   // 链接会放进 shell 的双引号里
  return [
    `claude plugin marketplace add ${MARKETPLACE}`,
    "claude plugin marketplace update agent-loop",
    `claude plugin install agent-loop@agent-loop --config "server_url=${link}"`,
    `node "${WELCOME_SCRIPT}" --welcome "${link}"`,
  ];
}
