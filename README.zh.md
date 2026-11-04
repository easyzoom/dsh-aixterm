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
- **侧栏可折叠** —— 左侧连接列表与右侧监控/文件栏都能收起成窄图标条，一键展开，刷新后保持。
- **分屏** —— 单屏、左右双屏、上下双屏、四屏（2×2）；标签栏按钮循环切换布局，每个附加窗格可用下拉选择终端。
- **命令历史与模糊建议** —— 终端里输入的命令按会话记录（持久化、相邻去重）；输入前缀时显示最多 5 条历史匹配，Tab 补全第一条。**全屏程序（vim/top/less 等，备用屏幕）中自动隐藏建议**，不干扰操作。
- **行号 / 时间戳边栏** —— 可选在终端左侧显示缓冲区行号、时间戳或两者；随滚动同步，按终端独立。
- **易用性** —— 会话搜索与复制、终端查找（`Ctrl+F`）、复制/粘贴带状态提示与 `Ctrl+Shift+C` / `Ctrl+Shift+V` 快捷键、右键菜单（复制/粘贴/查找/下载日志/清屏/清除回滚/重置终端）、五套配色主题、字体/字号/行高、关键字高亮（自定义规则与颜色）、同步输入、日志导出（txt/HTML）。
- **自动重连** —— 断线后指数退避重连。
- **危险命令审批** —— agent 发起的 `aixterm_run` / `aixterm_term_send` 命中可配置的危险模式时等待用户批准；审批界面不可用时默认拒绝。
- **凭据引用** —— 会话可指定 dsh 凭据服务中的 key 名（`credentialEnv`），不必存密码。
- **会话导入导出** —— 导出 JSON（可往返导入）或 MobaXterm `.mxtsessions`；导入 Xshell `.xsh`、MobaXterm 与本插件 JSON。不含密码，跳板按名称保留。
- **SSH 密钥管理** —— 生成 ed25519 或导入已有私钥，会话按名称引用；密钥存于 `<dataDir>/keys`（权限 600）。
- **Telnet 会话** —— `host:port` Telnet（含 IAC 协商），与 SSH 共用终端界面（仅 SSH 可用的面板自动隐藏）。
- **终端类型（TERM）** —— 设置里选择模拟的终端类型（xterm-256color、xterm、vt100、vt220、linux、screen、ansi 等），作用于新建的 SSH 与本地终端。
- **连接横幅** —— 明确区分服务器预认证 banner、连接信息和 shell 欢迎信息。横幅按终端宽度对齐，压缩状态来自实际 SSH 协商（优先压缩，不支持时退回 none）。普通登录不发送初始化命令，不自动切换 bash 或改写 PS1。目录跟随依赖远端已有的 OSC 7 上报，未配置时可手动浏览 SFTP。
- **串口会话** —— 本机串口（设备路径、波特率、数据位/停止位/校验）与 SSH 共用同一终端界面。
- **X11 转发** —— 会话可开启 X11 转发到本机 X server（需服务器装 `xauth`、本机有 `DISPLAY`）。
- **ZMODEM** —— 远端 `sz` 下载自动保存到本地；远端 `rz` 弹出本地文件选择（基于 zmodem.js）。
- **AI 助手面板（以主会话为中心）** —— 面板即 dsh 主对话：发送问题（可粘贴/附加截图）、实时查看回复/工具调用/错误流、选择或新建目标会话（工作区+模式）、↗ 跳回主工作区。一切由主 agent 处理——工具、审批与会话历史与主界面完全一致。终端内右键 → **AI 提问** 弹出小浮动框（自动附带选中的终端内容）：下拉可**指定目标对话**（默认当前/默认会话），只有显式选择「＋ 新建会话」才创建新会话（使用 dsh 默认模型，可在主界面调整）。设置 → **AI** 可选择「跟随主会话模型」（默认）或「每次提问前强制指定 provider/model」——用下拉从模型目录里选择（主界面同步可见）；只有选择「指定模型」时才显示选择框。
- **终端输出本地保存** —— 设置面板里可开关并自定义目录；关闭时仅保留内存循环 buffer，行数可配（100–100000，默认 2000）。
- **对话内 `@` 会话分析** —— `aixterm_read_log` / `aixterm_analyze` 支持用会话名定位，agent 可分析对话中 `@<会话名>` 引用的终端。
- **锁屏、主密码与空闲自动锁定** —— 设置主密码（scrypt 哈希）后可手动锁定，或空闲 N 分钟后自动锁定；锁定时除锁接口外所有 API 返回 423。
- **广泛的会话导入** —— 自动识别 Xshell `.xsh`、MobaXterm `.mxtsessions`、SecureCRT `.ini`，以及 WindTerm、FinalShell、Termius、Electerm、NyaTerm 的 JSON，另含本插件导出格式。
- **更丰富的资源监控** —— CPU、内存、负载、磁盘、网络速率之外，新增主机名、内核、开机时长、登录用户与（可用时）SoC 温度。
- **tmux 集成** —— 列出 / 新建 / 关闭远端 tmux 会话；打开终端时附加（或创建）命名会话，断线重连后 shell 仍在；`aixterm_tmux_sessions` 向 agent 暴露会话列表。
- **会话右键菜单** —— 连接会话、断开会话、编辑配置、复制、tmux、端口转发、日志导出、测试连接、删除，统一收进右键菜单。列表更紧凑（悬停会话显示名称/地址/分组/状态），已连接的会话归入顶部 **活跃** 分组，其余按各自分组显示。
- **宏录制与执行** —— 在终端里录制命令、保存为命名宏，并在任意会话按顺序回放（可设间隔）；宏面板支持编辑与删除。
- **传输队列** —— 上传/下载进入队列，带进度、实时速度、暂停/继续、取消、失败重试、断点续传、重复目标处理（覆盖/跳过/重命名）与时间戳保留（两侧 mtime 一致）。
- **可配置数据目录** —— 会话文件、加密密钥、终端回滚日志同一目录（插件配置 `dataDir`，默认 `$DSH_HOME/aixterm`）。

## 安装

### 设备排障与平台支持

支持**用户自定义诊断方案**：点击“管理 / 导入导出”，可新建、复制内置方案、编辑输入参数与检查步骤、调整顺序、设置超时/输出上限和 AI 分析重点。支持单方案或集合 JSON 导入导出，导入不会执行命令，也不会覆盖已有同 ID 方案。自定义 SSH 命令先展示完整预览，再确认运行；agent 调用时会请求审批。[格式协议与示例](docs/diagnostic-profiles.md) · [JSON Schema](docs/diagnostic-profile.schema.json)。

在已连接会话右侧点击 **🩺 设备排障**，选择内置启动异常、服务未启动（需填写服务名）或存储不足，也可选择用户方案。每项检查展示时间、命令和原始输出；缺少工具、权限不足、超时或输出截断会标为信息不完整。预览后可点击 **交给 AI 分析**，报告才会发送到现有主对话；不会自动执行 AI 建议的修复。

DSH 宿主可以是 **Windows、Linux 或 macOS**，插件要求 **Node 20+**（与串口依赖要求一致）。采集通过 Node SSH 接口完成，不在宿主执行 Linux 命令。首版主动诊断面向远端 **Linux / BusyBox**，会先识别目标系统；systemd 工具不可用时保留可采集的信息并说明限制。串口与 Telnet 仅读取已有终端输出，不发送命令，兼容 `COM3`、`/dev/ttyUSB0`、`/dev/cu.*` 等宿主串口命名。尚无日志时会明确提示。

agent 可调用 `aixterm_diagnose`，参数为 `session`（id 或名称）、`scenario`（`boot` / `service` / `storage`）和可选 `service` / `terminalId`。CI 配置覆盖三种宿主的测试与前端构建；本地验证的平台以实际运行环境为准。SSH/串口依赖含原生模块，需安装与宿主系统和 CPU 架构匹配的 Node 运行环境。

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
- `在 test 的终端里执行 make` → `aixterm_term_send` 传 `session`（直接写入已打开终端，无需 terminalId）
- `所有 SSH 服务器执行 uptime` → `aixterm_run_all`（危险命令整批一次审批）
- `把 deploy 宏在所有机器上跑一遍` → `aixterm_run_macro`
- `看看 AI 面板刚才怎么说的` → `aixterm_ai_history`

工具支持会话 **id 或精确名称**，所以对话里 `@<会话名>` 引用即可。AI 面板的问答记录与对话共享。

