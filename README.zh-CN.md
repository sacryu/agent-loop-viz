<p align="center"><img src="docs/assets/logo.svg" width="96" alt=""></p>

<h1 align="center">Agent Loop</h1>

<p align="center">看见你的 coding agent 到底在做什么。<br>
每个 Claude Code 对话是一颗行星，每次工具调用是一根射线，长度就是耗时。</p>

<p align="center"><a href="https://sacryu.github.io/agent-loop-viz/"><b>在线演示</b></a> · <a href="README.md">English</a> · <a href="docs/privacy.md">隐私说明</a> · <a href="docs/physics.md">画面里的物理</a></p>

<p align="center"><img src="docs/assets/demo.png" width="860" alt="一个行星系：中间是恒星，对话绕着它转，每个对话上的射线是它的工具调用"></p>

Agent Loop 是一个插件加一个小服务器，把正在跑的 Claude Code 对话画出来：

- **星系群**：你自己，或者你和朋友。每个人是一个星系，在干活的对话越多越亮。
- **行星系**：点进一个星系。中间的恒星是模型（Haiku 是红矮星，Sonnet 是类太阳的恒星，Opus 是蓝巨星），每条轨道是一个项目，每颗行星是一个对话，每根射线是一步。
- **表盘**：点一颗行星，各步从 12 点起顺时针排开：「运行 npm test」「改 app.ts」「读 cart.ts」。珊瑚色是正在跑的那一步，红色是出错，一圈圈白色波纹是在等你授权。
- **步骤详情**：点一步，看它完整的输入和输出。

画面里的每个设定都有真实的物理依据（临边昏暗、较差自转、开普勒第三定律、暗物质晕里平的转动曲线……），见 [docs/physics.md](docs/physics.md)。

## 快速开始（只有你自己，在自己电脑上）

需要 Node.js 20 或更新（`npx agent-loop-viz` 要起服务器；只装插件的话 18 就够）。

```sh
npx agent-loop-viz          # 在 http://127.0.0.1:4317 起服务
```

在 Claude Code 里：

```
/plugin marketplace add sacryu/agent-loop-plugin
/plugin install agent-loop@agent-loop
/reload-plugins
```

打开 http://127.0.0.1:4317，照常干活就行。不用任何设置：插件默认发往 `127.0.0.1`，数据不出你的电脑。`/galaxy` 给出你自己星系的网址。

## 和朋友一起：星系群

星系群是互相看得见的几个星系，放在一台服务器上：你自己部署的，或者别人托管的。**邀请链接**（`https://<服务器>/#k=<密钥>`）带着星系群的密钥：

- 插件用这把密钥把匿名的类别和耗时以外的一切加密（AES-256-GCM）以后再发出去。
- 浏览器负责解密。`#` 后面的部分浏览器不会发给服务器，所以**服务器只拿得到匿名的类别、耗时和一段它解不开的密文。**
- 拿到链接的人就能看这个星系群，也能把自己的星系接进来。只发给你信任的人。

你的星系在哪个群，只在 Claude Code 里由插件管；网页只负责显示。

**建一个星系群**：在 Claude Code 里运行 `/agent-loop:create https://<服务器>`（不带地址就建在你现在上报的那台服务器上）。插件先问服务器收不收新群，在你的电脑上生成密钥，把你的星系报到新群，服务器收下了才把新的邀请链接存进插件的 `server_url` 设置（被拒时原来的设置不动）。插件和服务器都要 0.2.11 以上。密钥不会出现在对话里：浏览器里会打开这个群，邀请链接就在弹出的面板里（以后在「邀请」里也能找到）。之后运行 `/reload-plugins`。只接受名单里的星系群（`GROUPS`）的服务器，要请管理员用 `npx agent-loop-viz invite` 生成链接。

**看现在报给哪里**：`/agent-loop:status` 列出服务器和星系群指纹、插件在不在上报、上次发得怎么样、你的星系名字和分享档位、插件版本。

**邀请别人**：在页面右上角点「邀请」，有两个复制按钮：「复制链接」复制看这个星系群的链接；「复制给 Claude Code 的话」复制一段让对方发给自己 Claude Code 的话。它会按顺序跑四行命令：加插件市场并拉到最新、带着邀请链接装插件，最后跑插件里的 `report.mjs --welcome`。最后这一行不等 `/reload-plugins`，把对方正在用的这个会话直接报上去，在浏览器里打开对方自己的星系、弹出「这是你的星系」，并把 Agent Loop 是什么、会发出去什么（权限和加密）交给 Claude 讲，问要不要改 `name` 和 `share`。这个会话的每一步要等对方执行 `/reload-plugins`（Claude 执行不了）以后才开始画；新开的会话会自己上报。对方先打开了链接的话，页面上也会给出同一段话。

**自己动手加入**：在终端运行下面两行（插件已经装过也照样运行，会换成新的星系群），再在 Claude Code 里执行 `/reload-plugins`。之后在这个群里第一次说话时，插件会让 Claude 讲同样的说明：

```sh
claude plugin marketplace add sacryu/agent-loop-plugin
claude plugin install agent-loop@agent-loop --config "server_url=<邀请链接>"
```

在你自己的终端里敲这一行，密钥会留在 shell 历史里。不想这样的话，装插件时不带 `--config`，然后在 Claude Code 里运行 `/plugin configure agent-loop@agent-loop`，把链接粘进 **Server URL or invite link**（输入会被遮住），选 **Save**。终端里的 `claude plugin configure` 只列出选项，填不了。

**退出星系群**：在 Claude Code 里运行 `/agent-loop:leave`。这台电脑上的所有会话马上停止往这个群上报（不用重载），服务器也会移走你的星系和存着的你的步骤详情。插件设置里还留着邀请链接：想回到本机看，把 **Server URL or invite link** 改回 `http://127.0.0.1:4317`；想回这个群，运行 `/agent-loop:rejoin`。退出以后浏览器里会打开这个群的页面：清掉这个浏览器里的群密钥，并显示你已经退出（要 0.2.12 以上的服务器）。只是不想在浏览器里看了，用页面上「邀请」里的「清除缓存」：那只让这个浏览器忘掉密钥，你的星系照样上报，直到你运行 `/agent-loop:leave`。退出以后，`/agent-loop:galaxy` 会照实说你已经退出，不再打开旧群。

插件需要 Node.js 18 或更新（`node` 要在 PATH 里）。上报不出去时（链接里没有密钥、地址漏了 `http://`/`https://`、连不上服务器、服务器拒收、Node 太旧），会话开始时 Claude Code 里会提示一行。

**在自己的服务器上建星系群**（需要 Docker、一个指向服务器的域名、开放 80 和 443 端口）：

```sh
npx agent-loop-viz invite https://loop.example.com   # 打印邀请链接和星系群编号
cp deploy/.env.example deploy/.env               # 填 DOMAIN，GROUPS=<那个编号>
docker compose -f deploy/compose.yml up -d --build
```

把邀请链接发给朋友。密钥在你的电脑上生成，从不经过服务器。详见 [docs/deploy.md](docs/deploy.md)。

## 分享多少

由你在插件的 `share` 设置里选：

| `share` | 离开你电脑的 |
|---|---|
| `anonymous` | 只有事件的类别和耗时：什么时候在用、几个对话、每一步用的是**哪一类**工具、花了多久 |
| `summary` | 再加上：星系的名字、项目目录名、对话标题、每一步的工具和对象（文件名、命令开头、搜索词）、报错的第一行、每次回答的最后一句 |
| `full` | 再加上：你输入的整句话、工具完整的输入和输出、完整的回答和报错 |
| `auto`（默认） | 在自己电脑上是 `full`，别处是 `summary` |

发往别处时附件一律加密；没有邀请链接时什么都不发。唯一会往外发东西的脚本是 [`plugin/hooks/report.mjs`](plugin/hooks/report.mjs)：不依赖任何包、不用编译，一口气能读完。细节，包括服务器仍然能看到什么，见 [docs/privacy.md](docs/privacy.md)。

## 插件设置

| 设置 | 默认 | |
|---|---|---|
| `server_url` | `http://127.0.0.1:4317` | 本机的服务器，或者一条邀请链接。存成敏感设置（系统的凭据存储，不在 `settings.json` 里） |
| `share` | `auto` | 见上 |
| `name` | 空 | 你在星系群里的名字；空着就是自动生成的星表编号，比如 `ALC 1342+27` |

改设置：在 Claude Code 里运行 `/plugin configure agent-loop@agent-loop`；或者在终端里只传要改的项：`echo '{"name":"小王","share":"summary"}' | claude plugin configure agent-loop@agent-loop --values-stdin`。改完执行 `/reload-plugins`。

## 页面操作

- 星系群：拖动平移，滚轮缩放，点一个星系飞进去。右上角「邀请」：复制链接，或者复制让朋友发给自己 Claude Code 的那句话。
- 行星系：鼠标指着行星出卡片，拖动转动，点一下打开它的表盘。Esc 返回，← → 切换对话。
- 表盘：鼠标扫过一步看它是什么；点一下看完整内容。
- `?lang=en` / `?lang=zh` 切换语言（默认跟浏览器）。
- `?demo` 播放内置的演示；`?demo&n=2000` 是 2000 个星系的压力测试。

## 开发

```sh
npm install
npm run check            # 类型检查（含 report.mjs 的 JSDoc）+ 全部测试
npm run build            # web/dist 和 server/dist/server.mjs
npm start                # 本机服务器
node tools/simulate.mjs --galaxies 3 --sessions 4      # 用插件的真实代码发模拟的对话
npm run build:demo       # 静态的演示站（web/dist-demo）
```

## 已知的局限

- 目前只支持 Claude Code。
- 模型在想的时候按 Esc 打断没有事件：对话会显示「在想」，最多两分钟后回到待命。
- 服务器只把东西放在内存里。圈数和步数在服务器重启后仍是整个对话累计的：插件从本机的会话记录里数出来，只发这两个数。
- 还不能踢人、换密钥：每个人都能自己退出（`/agent-loop:leave`），但要收回一条邀请链接，只能新建一个星系群。
- 页面的代码是你打开的那台服务器给的。托管方如果作恶，可以换一份会偷密钥的页面；在意这一点就用自己部署的服务器。

Agent Loop 是独立的项目，不是 Anthropic 做的，也没有得到 Anthropic 的背书或合作。

## 许可证

[MIT](LICENSE)
