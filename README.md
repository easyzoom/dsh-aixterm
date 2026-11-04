# dsh-aixterm

> **The next-generation AI-native SSH terminal** — a terminal that thinks, acts, and *sees*.

[![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-536DFE)](https://github.com/deepseek-ai/deepseek-harness)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Xshell, MobaXterm and WindTerm are excellent — but they share the same ceiling: **they're "dumb" tools**. Connect, type, transfer files. That's it. When something breaks, you still stare at the screen, search docs, and debug by hand.

**dsh-aixterm breaks that ceiling.** AI is woven into every corner of the terminal: it works in the same session as you, reads your command history, understands your error screenshots, drives dozens of machines in parallel, and jumps into the main conversation to help when you ask.

> In one line: **hand the terminal to AI.**

---

## ✨ Highlights

### 🤖 AI-native (what separates it from every traditional terminal)

| Capability | What it does |
|---|---|
| **AI assistant panel** | A live mirror of the dsh main session: ask, watch replies, tool calls and errors stream in |
| **Right-click AI ask** | Select terminal text, right-click, ask — the selection is attached automatically |
| **Vision** | Paste/attach a screenshot and AI literally *reads* the error, chart or UI |
| **Batch operations** | One command / one macro across all servers (dangerous ones get one batch approval) |
| **`@` session analysis** | `@session` in chat; AI reads its history, output and resource state |
| **Context-aware Q&A** | AI sees the session, cwd, recent commands and terminal output |

### 🔌 Every protocol

- **SSH / Telnet / Serial** in one UI
- Multi-tab + **split view** (side-by-side / stacked / 2×2 quad)
- **Port forwarding** (`-L` / `-R` / SOCKS5 `-D`), **jump hosts**, **auto-reconnect**, **tmux**

### 📁 Files (SFTP)

- Browse / upload / download / mkdir / rename / delete / chmod / **inline edit**
- **Transfer queue**: progress, live speed, pause / resume / cancel / retry, resume-from-offset, duplicate handling, timestamp preservation
- **Follow the terminal's cwd**

### 📊 Resource monitor

CPU, memory, load, disk, network rate, SoC temperature, uptime, logged-in users, SSH sessions — machine state at a glance.

### 🛠 Tool panel

Icon rail: Files · Monitor · Network · System · Processes · Logs · Forwarding · Diagnostics. Any tool can be **popped out** as a draggable floating window.

### 🧩 Terminal experience

- Five colour themes, font / size / line height
- **Keyword highlighting** (custom patterns + colours)
- **Line-number / timestamp gutter**
- **Fuzzy command suggestions** (auto-hidden in full-screen programs)
- **Macro record/replay**, **ZMODEM**, **X11 forwarding**

### 🔐 Security

- **Master password / lock screen / idle auto-lock**
- **Danger-command approval** (agent `rm` / `dd` / `reboot` … asks first, fail-closed)
- **Credential references** (keys live in the dsh credential service, never in plain config)
- **SSH key management** (generate / import / fingerprint)

### 🌍 Painless migration

Import sessions from **Xshell / MobaXterm / SecureCRT / WindTerm / FinalShell / Termius / Electerm / NyaTerm**; export JSON or MobaXterm format.

---

## ⚡ Quick start

```bash
# 1) install into the dsh web profile from source
dsh plugin --profile web add /path/to/dsh-aixterm

# 2) open dsh web and go to the "SSH sessions" page
# 3) create an SSH / Telnet / serial session, or import from another client
```

Requires Node ≥ 18; run `npm install` in the plugin directory first (`ssh2`, `node-pty`, `serialport`, `zmodem.js`).

## 🤖 Use it from the chat

The plugin registers an embedded skill and a set of tools so the dsh conversation can drive terminals:

```
@test what broke recently               → history + output + resources
run df -h on test                       → execute (dangerous commands auto-approve)
summarize test's resources              → monitor snapshot analysis
add a session for 10.0.0.5 user root    → create a session
list tmux sessions on test              → tmux listing
run uptime on all servers               → batch execution (one approval)
replay the deploy macro everywhere      → batch macro
```

---

## 📂 Data & configuration

- Sessions / keys / macros / history / transfers live under `$DSH_HOME/aixterm/`
- Settings are paginated: Display / AI / Highlighting / Security / Storage / About
- Language: 中文 / English

## 📄 License

[MIT](LICENSE) · by [easyzoom](https://github.com/easyzoom)
