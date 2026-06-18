# WebPanel | 通用 Web 终端面板

## 📋 项目简介

**一个基于 Node.js + ttyd 的 Web 终端面板。**

通过浏览器访问真实的系统终端 —— 任何可在终端中运行的工具（MiMoCode、Python、Node.js、Git、Vim、Docker 等），理论上都可以通过本项目在网页上使用。

- ✅ **Node.js 一体化服务** — 不再需要 Nginx，一个 `npm start` 启动所有组件
- ✅ **真实 Web 终端** — 基于 ttyd，浏览器访问系统 shell
- ✅ **支持 4 种内网穿透** — cpolar（推荐） / chmlfrp / frp / ngrok
- ✅ **统一配置文件** — 所有设置在 `.env` 中，修改后重启即可

## 🧩 技术架构

```
                    ┌──────────────────────────────┐
用户浏览器 ───────► │   内网穿透（cpolar 等）      │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │   Node.js server.js (端口 9999) │
                    │  ┌──────────────────────────┐ │
                    │  │ 静态文件: index.html      │ │
                    │  │ /terminal/* → ttyd:7681  │ │
                    │  └──────────────────────────┘ │
                    └──────────────┬───────────────┘
                                   │
                          ┌────────▼─────────┐
                          │   ttyd (7681)    │
                          │  (真实系统 shell)│
                          └────────┬─────────┘
                                   │
                        ┌──────────▼────────────┐
                        │  任意终端工具           │
                        │ (mimo / python / node   │
                        │  / git / vim / docker…) │
                        └───────────────────────┘
```

## 快速开始

### 方式一：npm 全局安装（一行命令搞定）

```bash
# 全局安装后，直接一个命令启动！
npm install -g @lensi/webpanel
webpanel
```

> 安装时会**自动下载** ttyd 和 cpolar 二进制文件到项目目录，无需手动下载。
> 如果提示权限错误，在 macOS/Linux 上加 `sudo`：`sudo npm install -g @lensi/webpanel`

> **Windows PowerShell 用户注意**：如果运行 `webpanel` 命令时报错 "running scripts is disabled"，请使用以下方式之一：
> 1. 使用命令提示符（CMD）而不是 PowerShell
> 2. 以管理员身份运行 PowerShell 并执行：`Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`
> 3. 使用完整路径运行：`node "C:\Users\<你的用户名>\AppData\Roaming\npm\node_modules\@lensi\webpanel\bin\webpanel.js"`

---

### 方式二：本地项目安装

```bash
# 1. 克隆项目
git clone https://github.com/Lensi-zhang/webpanel.git WebPanel
cd WebPanel

# 2. 安装依赖（自动下载 ttyd + cpolar）
npm install

# 3. 启动
npm start
```

---

### 启动后访问

```
====================================
    WebPanel 正在启动...
====================================
✅ 管理面板: http://localhost:9999
✅ Web 终端: http://localhost:9999/terminal/
✅ 状态检查: http://localhost:9999/api/status
提示: 按 Ctrl+C 停止所有服务
```

| 方式 | 地址 |
|------|------|
| **管理面板** | `http://localhost:9999` |
| **仅终端** | `http://localhost:9999/terminal/` |
| **公网访问** | cpolar 等输出的地址 |
| **状态检查** | `http://localhost:9999/api/status` |

---

### 在终端中使用任意工具

进入管理面板后，在右侧终端中输入任意命令，例如：

```bash
mimo                              # 启动小米 AI 编程助手
python3                            # 进入 Python
node                               # 进入 Node.js REPL
git status                         # 使用 Git
vim                                # 使用 Vim 编辑器
ls -la                             # 查看当前目录
# …… 任何可在终端运行的工具
```

---

### 前置依赖

| 软件 | 说明 | 下载地址 |
|------|------|---------|
| **Node.js** | v14 及以上 | https://nodejs.org |
| **ttyd** | 自动下载，无需手动 | https://github.com/tsl0922/ttyd/releases |
| **cpolar** | 自动下载，无需手动 | https://www.cpolar.com |

> ttyd 和内网穿透工具由 `npm install` **自动下载**到项目目录。

## 项目结构

```
WebPanel/
├── package.json                  # 项目依赖与 npm scripts
├── server.js                     # Node.js 主程序
├── bin/
│   ├── webpanel.js              # CLI 全局命令入口（npm install -g 后可用 webpanel 命令）
│   └── setup-binaries.js        # 自动下载 ttyd / cpolar（postinstall 自动调用）
├── .env                          # 统一配置文件
├── index.html                    # 管理面板界面
├── ttyd / ttyd.exe              # 自动下载的 Web 终端
├── cpolar / cpolar.exe        # 自动下载的内网穿透（可切换为 chmlfrp / frp / ngrok）
├── README.md                     # 项目文档
└── node_modules/                 # npm 依赖
```

## ⚙️ 配置说明（.env 文件）

```dotenv
# 主服务端口（浏览器访问此端口）
PORT=9999

# ttyd 终端服务
TTYD_PORT=7681
TTYD_EXEC=./ttyd
TTYD_SHELL=bash                  # Linux/macOS 填 bash，Windows 填 cmd.exe

# 内网穿透工具（4 选 1，设 TUNNEL_ENABLE=false 可禁用）
TUNNEL_TOOL=cpolar              # cpolar | chmlfrp | frp | ngrok
TUNNEL_ENABLE=true
CPOLAR_AUTH_TOKEN=你的token
CHMLFRP_TOKEN=
FRPC_CONF=./frpc.toml
NGROK_AUTHTOKEN=
```

## 📝 各组件详细说明

### ttyd
- **作用**: 将系统终端转为 Web 服务
- **下载**: `npm install` 时自动下载，无需手动处理
- **手动下载**: https://github.com/tsl0922/ttyd/releases
- **常见问题**: 若启动失败，请确认 ttyd 可执行文件存在并赋予执行权限（`chmod +x ttyd`）

### 内网穿透工具（任选其一）

#### cpolar（推荐）
- **官网**: https://www.cpolar.com
- **客户端**: `npm install` 时自动下载
- **优点**: 操作简单，一行命令即可将本地服务暴露到公网
- **使用方式**:
  1. 在 `.env` 中设置 `TUNNEL_TOOL=cpolar`
  2. 免费用户需注册 cpolar 账号获取 authtoken（[点击获取](https://www.cpolar.com)）
  3. 在 `.env` 中填入 `CPOLAR_AUTH_TOKEN=你的token`
  4. 运行 `npm start`

**注意**: cpolar 免费版生成的公网地址会在 24 小时后变化，需要重新启动才能获得新地址。如需固定地址，请购买 cpolar 套餐。

---

#### chmlfrp
- **官网**: https://www.chmlfrp.cn
- **管理面板**: https://panel.chmlfrp.net/
- **客户端**: 需从 https://github.com/fatedier/frp/releases 下载 frpc 二进制并重命名为 `chmlfrp`（或 `chmlfrp.exe`）放到项目根目录，npm install 不会自动下载
- **优点**: 国内访问速度快，操作简单，免费版足够使用
- **使用方式**:
  1. 在 `.env` 中设置 `TUNNEL_TOOL=chmlfrp`
  2. 从 chmlfrp 管理面板创建隧道，下载 `frpc.ini` 或 `frpc.toml`
  3. 将配置文件放在项目根目录
  4. 运行 `npm start`，自动检测并使用配置文件启动

**frpc.ini 示例**（从 chmlfrp 面板复制）:
```ini
[common]
server_addr = 你的节点地址
server_port = 7000
user = 你的user
token = 你的token

[webpanel]
type = tcp
local_ip = 127.0.0.1
local_port = 9999
remote_port = 分配给你的远程端口
```
将 `frpc.ini` 放在项目根目录，Node.js 会自动检测并使用

---

#### chmlfrp 完整图文教程

##### 第一步：注册账号

1. 访问 **chmlfrp 官网**: https://www.chmlfrp.cn
2. 点击「免费使用」或直接访问管理面板: https://panel.chmlfrp.net/tunnel/config
3. 点击「注册账户」，填写用户名、密码、邮箱完成注册
4. 注册成功后自动登录，进入管理面板

##### 第二步：选择节点

1. 登录后在左侧菜单点击「**节点列表**」
2. 会看到多个可用的穿透节点，**选择延迟最低的节点**（节点名称旁有延迟显示）
3. 记录该节点的以下信息：
   - **服务器地址（server_addr）**：如 `84.54.2.240`
   - **服务器端口（server_port）**：通常为 `7000`

##### 第三步：创建隧道

1. 在左侧菜单点击「**我的隧道**」
2. 点击「**新建隧道**」
3. 填写隧道配置：

| 配置项 | 填写内容 |
|--------|---------|
| 隧道名称 | `webpanel`（自定义） |
| 协议类型 | **TCP** |
| 服务器节点 | 选择第二步选中的节点 |
| 本地 IP 地址 | `127.0.0.1` |
| 本地端口 | `9999`（WebPanel 默认端口） |
| 远程端口 | 自动分配，**记录下来** |

4. 点击「创建」，隧道创建成功

##### 第四步：获取账号信息

1. 创建隧道后，在「**我的隧道**」页面可以看到刚创建的隧道
2. 在左侧菜单找到「**账号信息**」或「**个人中心**」
3. 记录以下信息：
   - **用户ID（user）**：一串字符，如 `abc123`
   - **密码（password）**：你的登录密码

##### 第五步：获取并配置 frpc.ini

1. 在 chmlfrp 管理面板「**我的隧道**」页面，点击「**下载配置文件**」或「**查看配置**」
2. 复制生成的 frpc.ini 内容，通常包含以下信息：

```ini
[common]
server_addr = 你的节点服务器地址
server_port = 7000
user = 你的用户ID
token = 你的token

[webpanel]
type = tcp
local_ip = 127.0.0.1
local_port = 9999
remote_port = 分配给你的远程端口
```

3. 将以上内容保存为项目根目录的 `frpc.ini` 文件（与 `server.js` 同目录）

**注意**: `.env` 文件中只需设置 `TUNNEL_TOOL=chmlfrp`，无需额外配置 user/password

##### 第六步：启动！

```bash
npm start
```

启动成功后，你会看到类似输出：

```
====================================
    WebPanel 正在启动...
====================================
✅ 管理面板: http://localhost:9999
✅ Web 终端: http://localhost:9999/terminal/
提示: 按 Ctrl+C 停止所有服务
```

##### 第七步：获取公网访问地址

1. 打开 chmlfrp 管理面板: https://panel.chmlfrp.net/tunnel/config
2. 进入「**我的隧道**」页面
3. 找到你创建的 `webpanel` 隧道
4. 查看「**连接地址**」或「**访问地址**」，格式类似：
   ```
   84.54.2.240:24879
   ```
5. 在浏览器中访问：`http://84.54.2.240:24879` 即可公网访问 WebPanel！

##### 常见问题

**Q: 隧道状态显示离线？**
A:
1. 确认已正确配置 `.env` 或 `frpc.ini`
2. 确认 chmlfrp 进程正在运行（查看 npm start 终端输出）
3. 检查 `.env` 中的 user 和 password 是否正确

**Q: 访问地址打不开？**
A:
1. 确认隧道状态为「在线」
2. 确认本地 WebPanel 服务已启动（`npm start`）
3. 检查防火墙是否放行了远程端口（24879 等）
4. 尝试换一个节点

**Q: 远程端口被占用了？**
A: 在「我的隧道」中删除当前隧道，重新创建一个，新隧道会分配新的远程端口

**Q: 想更换节点？**
A: 在「我的隧道」中编辑隧道配置，切换到其他节点即可

**Q: 如何查看实时连接日志？**
A: 保持 `npm start` 终端开启，所有连接日志会实时显示在终端中

---

#### frp（需要自己有公网服务器）
- **下载**: https://github.com/fatedier/frp/releases
- **使用**: 在项目目录创建 `frpc.toml`（客户端配置），并在 `.env` 中设 `TUNNEL_TOOL=frp`
- **frpc.toml 示例**（本地端）:
  ```toml
  serverAddr = "你的公网服务器IP"
  serverPort = 7000

  [[proxies]]
  name = "webpanel"
  type = "tcp"
  localIP = "127.0.0.1"
  localPort = 9999
  remotePort = 60999
  ```
- **frps.toml 示例**（服务器端，运行在你的公网服务器）:
  ```toml
  bindPort = 7000
  ```

#### ngrok
- **官网**: https://ngrok.com
- **使用**: 放在项目根目录，在 `.env` 中设 `TUNNEL_TOOL=ngrok`

### 可在终端中使用的工具举例

本项目的终端是真实的系统 shell，所以**任何能在终端中运行的工具**都可以在网页中使用：

| 工具类别 | 工具名 | 下载/安装地址 | 安装命令示例 |
|----------|--------|--------------|-------------|
| AI 编程助手 | MiMoCode | https://github.com/XiaomiMiMo/MiMo-Code | `npm install -g @mimo-ai/cli` |
| 编程语言 | Python | https://www.python.org | `sudo apt install python3` |
| | Node.js | https://nodejs.org | `sudo apt install nodejs npm` |
| | Go | https://go.dev/dl | 官网下载安装包 |
| 版本控制 | Git | https://git-scm.com | `sudo apt install git` |
| 文本编辑器 | Vim | https://www.vim.org | `sudo apt install vim` |
| | Neovim | https://neovim.io | `sudo apt install neovim` |
| 开发工具 | Docker | https://www.docker.com | 官网按系统安装 |
| | tmux | https://github.com/tmux/tmux | `sudo apt install tmux` |

> 💡 所有工具均需**提前在运行终端的系统中安装**，之后才能在 WebPanel 中调用。

## 🎯 常见问题

**Q: 公网访问终端加载不出来？**
A: 确保内网穿透工具已正常启动，并访问 `/terminal/` 路径。WebSocket 已由 Node.js 自动代理，无需额外配置。

**Q: 启动时提示找不到 ttyd？**
A: 请从 https://github.com/tsl0922/ttyd/releases 下载对应系统的二进制文件，放到项目根目录（Linux 需 `chmod +x ttyd`）。

**Q: 只能用 cpolar 吗？**
A: 不是。`.env` 中修改 `TUNNEL_TOOL` 可切换为 chmlfrp、frp、ngrok 中的任意一个。

**Q: cpolar 如何配置？**
A:
1. 访问 https://www.cpolar.com 注册账号并登录
2. 在后台获取 authtoken
3. 在 `.env` 中设置 `TUNNEL_TOOL=cpolar` 和 `CPOLAR_AUTH_TOKEN=你的token`
4. 运行 `npm start`，cpolar 会自动启动并输出公网访问地址

**Q: chmlfrp 如何配置通道？**
A:
1. 访问 https://panel.chmlfrp.net/tunnel/config 注册并登录
2. 左侧「节点列表」选择一个节点，记录 `server_addr` 和 `server_port`
3. 左侧「我的隧道」创建新隧道：协议选 TCP，本地端口填 9999，记录分配到的 `remote_port`
4. 在「我的隧道」页面下载生成的 `frpc.ini` 配置文件
5. 将 `frpc.ini` 放到项目根目录
6. 在 `.env` 中设置 `TUNNEL_TOOL=chmlfrp`，运行 `npm start` 即可自动启动

**Q: 如何停止所有服务？**
A: 在运行 `npm start` 的终端按 `Ctrl+C`，Node.js 会自动停止 ttyd 和内网穿透。

**Q: 如何在终端中启动其他工具？**
A: 直接在 WebPanel 的终端里输入命令即可 —— 这是一个真实的系统终端。

**Q: 可以只用本地访问，不启动内网穿透吗？**
A: 可以。在 `.env` 中设置 `TUNNEL_ENABLE=false` 即可。

## ⚖️ 免责声明

1. **仅供学习与研究使用** — 本项目仅作为学习与技术研究用途。
2. **第三方工具风险** — ttyd、chmlfrp、cpolar、frp、ngrok、MiMoCode 等均为第三方软件，其安全性、稳定性由各工具自行承担，本项目不对第三方工具承担任何责任。
3. **公网访问安全风险** — 通过内网穿透将终端暴露到公网存在**显著的安全风险**（包括但不限于：未授权访问、命令执行、数据泄露、系统被入侵等）。请确保在安全环境下使用。
4. **免费版限制** — 内网穿透工具的免费版存在公网地址变化、速率限制等问题，请勿用于重要业务场景。
5. **使用责任** — 使用者对所有通过本项目执行的命令、操作及由此产生的**一切后果**承担全部责任。
6. **品牌归属** — 文中涉及的所有商标、产品名称、品牌均归各自所有者所有，仅用于说明用途。

**使用本项目即视为您已阅读、理解并同意以上全部条款。**

## 📄 许可证

- WebPanel (本项目): MIT License
- ttyd: MIT License
- 内网穿透工具: 各工具对应的许可证

---

**部署完成！在网页上使用你喜欢的任何终端工具！** 🚀
