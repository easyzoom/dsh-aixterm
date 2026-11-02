[English](README.md) | [简体中文](README.zh.md)

[![npm](https://img.shields.io/badge/npm-unpublished-lightgrey?logo=npm&logoColor=white)](#安装)
[![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-536DFE)](https://github.com/deepseek-ai/deepseek-harness)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/easyzoom/dsh-aixterm/actions/workflows/ci.yml/badge.svg)](https://github.com/easyzoom/dsh-aixterm/actions/workflows/ci.yml)

![dsh-aixterm 横幅](https://raw.githubusercontent.com/easyzoom/dsh-aixterm/main/docs/images/banner.svg)

# dsh-aixterm

面向 **DeepSeek Harness** 的 SSH / SFTP 会话管理插件 —— **人和 AI agent 共用**。人用侧边栏页面，AI 用工具，双方操作**同一批会话**、看到**同一份会话命令记录**，彼此能看到对方干了什么。

## 功能（v0.1）

- **保存的 SSH 会话** —— 密码 / 私钥 / ssh-agent，可命名、分组。
- **侧边栏页面**（插件下方），含连接列表与真正的 **xterm.js 终端**：多标签、SSH 与本地 shell、完整键盘、自适应大小、回滚与可点击链接。
- **SFTP 文件浏览** —— 浏览远端目录，**拖拽上传**、一键**下载**。
- **共享交互终端（人和 AI）** —— AI 可用 `aixterm_term_open` 打开同一个 PTY，用 `aixterm_term_read` / `aixterm_term_send` 读取和发送，人看到的是同一块屏幕。
- **共享记录（人和 AI）** —— 每次一次性执行（UI 记 `source: human`，工具记 `source: agent`）都记录命令、输出、退出码、时间。
- **AI 工具** —— `aixterm_list_sessions` / `aixterm_run` / `aixterm_sftp_list` / `aixterm_test`，以及上面的终端三件套。
- **凭据加密存储** —— 密码/密钥口令用 AES-256-GCM 加密落在数据目录。
- **端口转发** —— 本地（`-L`）、远程（`-R`）与动态 SOCKS5（`-D`），支持跳板机与连接复用。
- **完整 SFTP 管理** —— 新建目录 / 重命名 / 删除 / 改权限、在线编辑文本，文件面板跟随终端当前目录。
- **资源监控** —— 当前会话的 CPU、内存、负载、磁盘与网络速率。
- **分屏** —— 单屏、左右双屏、上下双屏、四屏（2×2）；标签栏按钮循环切换布局，每个附加窗格可用下拉选择终端。
- **易用性** —— 会话搜索与复制、终端查找（`Ctrl+F`）、右键菜单（复制/粘贴/查找/下载日志/清屏/清除回滚/重置终端）、五套配色主题、字体/字号/行高、关键字高亮（自定义规则与颜色）、同步输入、日志导出（txt/HTML）。
- **自动重连** —— 断线后指数退避重连。
- **危险命令审批** —— agent 发起的 `aixterm_run` / `aixterm_term_send` 命中可配置的危险模式时等待用户批准；审批界面不可用时默认拒绝。
- **凭据引用** —— 会话可指定 dsh 凭据服务中的 key 名（`credentialEnv`），不必存密码。
- **会话导入导出** —— 导出 JSON（可往返导入）或 MobaXterm `.mxtsessions`；导入 Xshell `.xsh`、MobaXterm 与本插件 JSON。不含密码，跳板按名称保留。
- **SSH 密钥管理** —— 生成 ed25519 或导入已有私钥，会话按名称引用；密钥存于 `<dataDir>/keys`（权限 600）。
- **Telnet 会话** —— `host:port` Telnet（含 IAC 协商），与 SSH 共用终端界面（仅 SSH 可用的面板自动隐藏）。
- **串口会话** —— 本机串口（设备路径、波特率、数据位/停止位/校验）与 SSH 共用同一终端界面。
- **X11 转发** —— 会话可开启 X11 转发到本机 X server（需服务器装 `xauth`、本机有 `DISPLAY`）。
- **ZMODEM** —— 远端 `sz` 下载自动保存到本地；远端 `rz` 弹出本地文件选择（基于 zmodem.js）。
- **AI 助手面板** —— 就当前终端向模型提问；它会看到会话、当前目录、最近命令和终端输出，建议的命令可一键执行。
- **终端输出本地保存** —— 设置面板里可开关并自定义目录；关闭时仅保留内存循环 buffer，行数可配（100–100000，默认 2000）。
- **对话内 `@` 会话分析** —— `aixterm_read_log` / `aixterm_analyze` 支持用会话名定位，agent 可分析对话中 `@<会话名>` 引用的终端。
- **锁屏、主密码与空闲自动锁定** —— 设置主密码（scrypt 哈希）后可手动锁定，或空闲 N 分钟后自动锁定；锁定时除锁接口外所有 API 返回 423。
- **广泛的会话导入** —— 自动识别 Xshell `.xsh`、MobaXterm `.mxtsessions`、SecureCRT `.ini`，以及 WindTerm、FinalShell、Termius、Electerm、NyaTerm 的 JSON，另含本插件导出格式。
- **更丰富的资源监控** —— CPU、内存、负载、磁盘、网络速率之外，新增主机名、内核、开机时长、登录用户与（可用时）SoC 温度。
- **tmux 集成** —— 列出 / 新建 / 关闭远端 tmux 会话；打开终端时附加（或创建）命名会话，断线重连后 shell 仍在；`aixterm_tmux_sessions` 向 agent 暴露会话列表。
- **会话右键菜单** —— 连接会话、断开会话、编辑配置、复制、tmux、端口转发、日志导出、测试连接、删除，统一收进右键菜单。列表中用空心圆表示仅保存的配置、实心圆表示当前已连接。
- **宏录制与执行** —— 在终端里录制命令、保存为命名宏，并在任意会话按顺序回放（可设间隔）；宏面板支持编辑与删除。
- **可配置数据目录** —— 会话文件、加密密钥、终端回滚日志同一目录（插件配置 `dataDir`，默认 `$DSH_HOME/aixterm`）。

## 安装

用 dsh 自带的 `dsh` CLI，`<profile>` 换成你的 profile（桌面端 `desktop`，`dsh web` 是 `web`）。

```bash
# 1) git 源（主通道）
dsh plugin --profile <profile> add "github:easyzoom/dsh-aixterm#main"

# 2) npm（发布后）
dsh plugin --profile <profile> add dsh-aixterm

# 3) 本地开发（本仓库检出目录）
dsh plugin --profile <profile> add /path/to/dsh-aixterm
```

说明：
- **桌面 profile 被运行中的应用独占**——用 CLI 安装前先关闭 DeepSeek Harness。
- git 源在配好 git 凭据时对私有仓库也有效。
- npm 方式需先把包发布到 npm。

## 用法

1. 打开侧边栏 **SSH 会话** 页 → **+ 新建** → 填主机/端口/用户/认证 → 保存，会话在终端标签页中打开。
2. 或点 **本地终端** 打开本地 shell（PowerShell / `$SHELL`）。
3. SSH 标签页右侧的 **文件 (SFTP)** 面板列出主目录：点文件夹进入，**把文件拖到面板上**即可上传，点 **↓** 下载。
4. AI 可用 `aixterm_term_open` 打开同一个交互终端，用 `aixterm_term_read` / `aixterm_term_send` 读取和发送——人看到同一块屏幕。一次性命令用 `aixterm_run`，会进入共享记录并带 **人 / AI** 徽标。

## 数据与安全

- 会话在 `$DSH_HOME/aixterm`（`sessions.json`），AES 密钥在 `.aixterm.key`，终端回滚日志在 `terminals/`；请把该目录视为敏感目录。
- 把插件配置 `dataDir` 指向别处即可统一迁移以上数据。
- 路由由 DSH 的本地 web 服务提供；若要对外暴露，请自行加反向代理信任 / 鉴权。
- 优先用**私钥**而非保存密码；密码虽加密，但密钥与数据在同一目录。

## 许可证

MIT

## 在对话中使用

插件注册了内嵌 **aixterm** skill 与一组工具，dsh 对话可以直接驱动终端：

- `@test 看看最近报了什么错` → `aixterm_read_log` / `aixterm_analyze`
- `在 test 上执行 df -h` → `aixterm_run`（危险命令会自动请求你批准）
- `把 test 的资源情况汇总一下` → `aixterm_analyze`
- `帮我加一个到 10.0.0.5 的会话，用户 root` → `aixterm_create_session`
- `test 上有哪些 tmux 会话` → `aixterm_tmux_sessions`

工具支持会话 **id 或精确名称**，所以对话里 `@<会话名>` 引用即可。

