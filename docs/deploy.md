# 部署

三种用法见 [README](../README.zh-CN.md)。这里是自己部署星系群服务器、演示站、发布 npm 包和测试服务器的步骤。

## 1. 自己部署星系群服务器

需要：一台能跑 Docker 的服务器、一个指向它的域名、开放 80 和 443 端口。

```sh
# 在你自己的电脑上：生成一个星系群（密钥只在这台电脑上，服务器拿不到）
npx agent-loop-viz invite https://loop.example.com
#   → 邀请链接 https://loop.example.com/#k=…   发给朋友，自己也填进插件的 server_url
#   → 星系群编号 9b2eaa35043f96dfd6b1c9f661d13b86              填进服务器的 GROUPS

# 在服务器上
git clone <仓库> && cd <仓库>
cp deploy/.env.example deploy/.env     # DOMAIN=loop.example.com，GROUPS=9b2eaa35043f96dfd6b1c9f661d13b86
docker compose -f deploy/compose.yml up -d --build
curl https://loop.example.com/healthz  # {"ok":true,"local":false,"open":false,"version":"0.2.11"}（非本机只答活着、收不收新群、版本：星系数、会话数要口令才看得到）
```

- 要加第二个星系群：再跑一次 `invite`，把新编号用逗号加进 `GROUPS`，`docker compose -f deploy/compose.yml up -d`。
- `GROUPS` 空着就是**开放模式**：任何人都能在你的服务器上用自己生成的邀请链接建星系群（官网就是这样）：在 Claude Code 里运行 `/agent-loop:create https://<你的服务器>`。页面上没有邀请链接时会提示这条命令（页面自己不建群）。建群要插件 0.2.11 以上，也要服务器 0.2.11 以上：插件先看 `/healthz` 的 `version`，旧的服务器（页面显示不了新群的邀请链接）不在上面建群。插件和服务器分开升级，所以服务器也要跟着更新。
- 开放模式下建群不用注册，所以挡不住有心人占名额：上面两项限制（每个 IP 每小时新建的群数、满了时挤掉闲着的群）只是抬高代价。对公网开放之前，先想清楚要不要白名单。
- 确认：`/debug` 是 404；`docker compose logs` 里没有请求日志；没有邀请链接打开首页，只看到「要邀请链接才能看」。

服务器的配置全部来自环境变量（默认值见 [`server/src/main.ts`](../server/src/main.ts)）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `4317` | 镜像里是 `0.0.0.0` |
| `LOCAL` | 回环地址上是 1，否则 0 | 1：本机模式（一个隐含的星系群、明文附件、调试页）。部署到别处必须是 0 |
| `GROUPS` | 空 | 白名单，逗号分隔的星系群编号。空着是开放模式 |
| `MAX_GROUPS` | 1000 | 星系群总数上限，满了对新的星系群返回 503 |
| `MAX_PER_GROUP` | 50 | 每个星系群最多几个星系 |
| `MAX_GALAXIES` | 5000 | 星系总数上限 |
| `MAX_FULL_BYTES` | 49152 | 单个大附件的上限（字节，密文）。0 表示不收大附件 |
| `NEW_INSTALLS_PER_IP_PER_MIN` | 20 | 每个 IP 每分钟新出现的安装数上限。IPv6 按 /64 算一个 IP |
| `NEW_GROUPS_PER_IP_PER_HOUR` | 10 | 只在开放模式下起作用：每个 IP 每小时最多新建几个星系群（加入已有的群不算） |
| `GROUP_IDLE_MIN` | 30 | 只在开放模式下起作用：星系群总数满了时，这么多分钟没有事件的星系群可以被新来的挤掉（它的星系下次上报时再回来） |
| `TRUST_PROXY` | 0（`deploy/compose.yml` 里是 1） | 用 `X-Forwarded-For` 的第一个地址限流。只在反向代理后面这样设：直接对外开端口时这个头谁都能伪造，按 IP 的限流就形同虚设 |
| `STATIC_DIR` | `web/dist` | 页面文件 |

其余限制写在代码里：每个安装每秒 50 条事件、突发 200 条，每个星系最多 50 个会话，每个会话留最近 600 步，请求体 64 KB（本机 256 KB），每个星系的大附件最多 8 MB；非本机模式下每个 IP 同时最多 64 个 WebSocket，同一个 IP 的所有连接合起来每秒 20 次切换星系或要附件（突发 60），积压 8 MB 没收走的浏览器会被断开。

本机模式可以加 `--record <文件>`：把收到的事件一行一条写下来（经过重排、交给状态机之前），做测试数据用。

## 2. 演示站（GitHub Pages）

仓库是 [github.com/sacryu/agent-loop-viz](https://github.com/sacryu/agent-loop-viz)，演示站在 [sacryu.github.io/agent-loop-viz](https://sacryu.github.io/agent-loop-viz/)。仓库的 Settings → Pages 里 Source 设成 GitHub Actions。之后每次推 `main`，[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) 跑一遍测试、以演示模式构建 `web/`、发布。

- 本地看：`npm run build:demo`，然后用任意静态服务器打开 `web/dist-demo`。
- 剧本在 [`tools/demo/scenes.mjs`](../tools/demo/scenes.mjs)（全是编的），改完 `npm run demo:script` 重新展开成 `web/src/demo/script.json`。测试会检查剧本里没有真实的路径和名字。
- 星系不在剧本里起名字：页面每次打开给每个星系一个随机编号，名字是由编号生成的星表编号（`web/src/play.ts`）。

## 3. npm 包

`cli/` 就是发布到 npm 的包（`npx agent-loop-viz`）：

```sh
cd cli && npm pack --dry-run     # 看看包里有什么（prepack 会先 npm run build，再把 server.mjs 和页面放进 cli/dist）
npm publish                      # 发布（要先 npm login）
```

包名和 GitHub 仓库名一样是 `agent-loop-viz`，命令就是 `npx agent-loop-viz`。`agent-loop` 发不了：npm 认为它和已有的 `agentloop` 太像（去掉连字符后相同）。账号开着两步验证（网页验证），`npm publish` 要在自己的终端里跑，按回车去浏览器确认。

## 4. 开源

```sh
git remote add origin https://github.com/sacryu/agent-loop-viz.git
git push -u origin main          # 只推 main，不要 --all 或 --mirror
```

本机的 `backup/*` 分支是公开前的开发历史，只留在本机，不推。提交的作者邮箱会随提交一起公开，这个仓库已经设成 GitHub 的 noreply 地址（`git config user.email` 查看）。

## 5. 测试服务器：热更新（不重建镜像）

测试服务器上频繁改东西时，不用每次 `git archive` + `docker compose up --build`。镜像只当运行环境，构建结果放在服务器仓库目录的 `live/` 里挂进容器：

```yaml
# 服务器上的 compose 文件，在 app 服务下加：
    environment:
      STATIC_DIR: /app/live/web
      TRUST_PROXY: "0"     # 直接开 4317 端口、前面没有反向代理时（旧镜像里默认是 1）
    volumes: ["./live:/app/live:ro"]
    command: ["node", "/app/live/server.mjs"]
```

本地写 `deploy/live.local.json`（不进 git）：

```json
{ "host": "<ssh 主机名>", "dir": "<服务器上的仓库目录>", "container": "<容器名>" }
```

然后：

```
npm run live          # 构建并推一次
npm run live:watch    # 一保存就构建、推送（1～3 秒）
```

- 只改了前端（`web/`）：换文件，不重启，浏览器刷新就是新的。
- 改了服务器（`server/src`、`shared/src`）：`server.mjs` 内容变了才推，推完重启容器（1 秒左右）。内存里的星系会清空，插件下一次上报时回来。
- 改了 `package.json` 的依赖或 Node 版本时才需要重建镜像。
- 协议升到 2 以后，测试服务器是星系群模式（不在回环地址上）：测试的人要用 `npx agent-loop-viz invite http://<IP>:4317` 生成的邀请链接当 `server_url`，没有邀请链接的插件什么都不发。用 `http://<IP>` 打开时浏览器没有 WebCrypto，页面用自带的纯 JS 实现解密，并提示「连接没有加密传输」。

## 6. 插件的公开仓库

插件单独公开在 [github.com/sacryu/agent-loop-plugin](https://github.com/sacryu/agent-loop-plugin)：只有 `.claude-plugin/marketplace.json`、`plugin/` 下的 `plugin.json`、`hooks/hooks.json`、`hooks/report.mjs`、`commands/` 下的 `galaxy.md`、`status.md`、`create.md`、`leave.md`、`rejoin.md`，加 README（安装、设置、会发出什么）和 LICENSE。服务器、页面、其余代码都不在里面。邀请面板和 README 里的安装命令（`web/src/links.ts` 的 `MARKETPLACE`）指向它。

**平时改插件不升版本号。** 本机装的插件直接读这个仓库里的 `plugin/`，`/reload-plugins` 就用上了，用不着版本号。插件的改动攒着，值得发的时候（修了 bug、加了功能，或者隔一阵子）一起发一次：

1. 把版本号加一：`plugin/.claude-plugin/plugin.json` 的 `version`、`plugin/hooks/report.mjs` 的 `PLUGIN_VERSION`、`shared/src/version.ts` 的 `PLUGIN_VERSION`（测试检查三处一致）。版本号不变，已经装了的人收不到更新。
2. 要不要提示大家更新：`shared/src/version.ts` 的 `PLUGIN_NAG_BELOW`。页面只提示比它旧的插件。只改了文案、输出的版本不动它；修了会影响数据的 bug、协议变了、服务器不再收旧格式时，升到这一版。
3. `npm run check`。
4. 把上面那几个文件复制到公开仓库的同一位置（`plugin/tsconfig.json` 不要），`claude plugin validate .` 通过后提交、推送。提交作者用 GitHub 的 noreply 邮箱。
5. 服务器（`server.mjs`）也推一次：`/healthz` 的 `version` 和页面上「最新」说的版本都跟着它。版本号只在这一步和公开仓库一起变，服务器说的最新版永远是装得到的。
