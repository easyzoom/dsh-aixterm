# dsh-aixterm

> **下一代 AI 原生 SSH 终端** —— 一个会思考、会动手、会看图的终端。

[![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-536DFE)](https://github.com/deepseek-ai/deepseek-harness)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Xshell、MobaXterm、WindTerm 都很优秀，但它们有一个共同的天花板——**它们是“哑”工具**：连接、敲命令、传文件，仅此而已。出错时，你还是要自己盯屏幕、自己查文档、自己排障。

**dsh-aixterm 打破了这道天花板**：AI 被做进终端的每一个角落。它和你在同一个终端里工作，能读你的命令历史、看懂你的报错截图、替你批量操作几十台机器、在你提问时直接进主对话帮你解决。

> 一句话：**把终端，交给 AI。**

---

## ✨ 核心特性

### 🤖 AI 原生（这就是它和所有传统终端的区别）

| 能力 | 说明 |
|---|---|
| **AI 助手面板** | 即 dsh 主会话的实时镜像：发送问题、看回复、工具调用与错误流，与主界面完全一致 |
| **右键 AI 提问** | 终端里选中内容右键提问，浮动框自动附带选中文本 |
| **视觉识别** | 粘贴/附加截图，AI 直接“看懂”报错、图表、UI 截图 |
| **批量操作** | 一条命令 / 一个宏，发到所有服务器（危险命令整批一次审批） |
| **`@` 会话分析** | 对话里 `@会话名`，AI 读它的命令历史、终端输出、资源状况 |
| **上下文问答** | AI 看到会话、当前目录、最近命令和终端输出，回答精准 |

### 🔌 全协议连接

- **SSH / Telnet / 串口** 一个界面
- 多标签 + **分屏**（左右 / 上下 / 2×2 四屏）
- **端口转发**（`-L` / `-R` / SOCKS5 `-D`）、**跳板机**、**自动重连**、**tmux 集成**

### 📁 文件（SFTP）

- 浏览 / 上传 / 下载 / 新建目录 / 重命名 / 删除 / 改权限 / **双击在线编辑**
- **传输队列**：进度、实时速度、暂停 / 继续 / 取消 / 重试、断点续传、重复目标处理、时间戳保留
- **跟随终端目录**（`cd` 到哪，文件面板跟到哪）

### 📊 资源监控

CPU、内存、负载、磁盘、网络速率、SoC 温度、开机时长、登录用户、SSH 会话——一眼看清机器状态。

### 🛠 工具面板（图标栏）

右侧图标栏：文件 · 资源监控 · 网络 · 系统 · 进程 · 日志 · 端口转发 · 连接诊断，任意工具可**弹出为可拖动浮动窗口**钉在终端上方。

### 🧩 终端体验

- 五套配色主题、字体 / 字号 / 行高
- **默认彩色 SSH 横幅**：标题、地址、连接状态分色显示；设置 → 显示可关闭，新建终端生效。
- **默认关键词高亮**：错误红、警告黄、成功绿、信息蓝；设置 → 高亮可独立关闭，也可添加自定义规则。保留远端原有颜色，不影响 vim/top 等备用屏幕，不修改输出或日志。
- **行号 / 时间戳 gutter**
- **命令历史模糊建议**（交互式程序中自动隐藏）
- **宏录制与回放**、**ZMODEM**、**X11 转发**

### 🔐 安全

- **主密码 / 锁屏 / 空闲自动锁定**
- **危险命令审批**（agent 执行 `rm` / `dd` / `reboot` 等前弹窗确认，fail-closed）
- **凭据引用**（密钥存 dsh 凭据服务，不落配置文件明文）
- **SSH 密钥管理**（生成 / 导入 / 指纹）

### 🌍 无缝迁移

一键导入 **Xshell / MobaXterm / SecureCRT / WindTerm / FinalShell / Termius / Electerm / NyaTerm** 的会话；导出 JSON 或 MobaXterm 格式。

---

## ⚡ 快速开始

```bash
# 1) 从源码安装到 dsh 的 web profile
dsh plugin --profile web add /path/to/dsh-aixterm

# 2) 打开 dsh web，进入「SSH 会话」页面
# 3) 新建 SSH / Telnet / 串口会话，或导入现有客户端配置
```

需要 Node ≥ 18；首次在插件目录 `npm install` 安装依赖（`ssh2` / `node-pty` / `serialport` / `zmodem.js`）。

## 🤖 在对话中使用

插件注册了内嵌 skill 与一组工具，dsh 对话可直接驱动终端：

```
@test 看看最近报了什么错            → 读命令历史 + 终端输出 + 资源状况
在 test 上执行 df -h                 → 执行命令（危险命令自动审批）
把 test 的资源情况汇总一下           → 监控快照分析
帮我加一个到 10.0.0.5 的会话          → 创建会话
test 上有哪些 tmux 会话              → tmux 列表
所有服务器执行 uptime                → 批量执行（整批审批）
把 deploy 宏在所有机器上跑一遍       → 宏批量回放
```

---

## 📂 数据与配置

- 会话 / 密钥 / 宏 / 历史 / 传输记录存于 `$DSH_HOME/aixterm/`
- 设置面板分页：显示 / AI / 高亮 / 安全 / 存储 / 关于
- 语言：中文 / English

## 📄 License

[MIT](LICENSE) · 作者 [easyzoom](https://github.com/easyzoom)
