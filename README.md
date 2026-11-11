# dsh-aixterm

English · [简体中文](README.zh.md)

![dsh-aixterm — shared SSH/SFTP sessions for humans and AI](docs/images/banner.svg)

> **The next-generation AI-native SSH terminal** — a terminal that thinks, acts, and *sees*.

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![npm](https://img.shields.io/npm/v/dsh-aixterm?logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-aixterm)
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
- **Colorful SSH banners by default**: title, target and status colors; disable in Settings → Display for new terminals.
- **Built-in keyword colors by default**: errors red, warnings yellow, success green and info blue; independently disable in Settings → Highlighting or add custom rules. Original remote colors take priority; alternate-screen apps and output/log bytes remain unchanged.
- **Line-number / timestamp gutter** with local-time millisecond precision (`HH:mm:ss.SSS`); timestamps reflect terminal output processing, not remote event time.
- **Fuzzy command suggestions** (auto-hidden in full-screen programs)
- **Macro record/replay**, **ZMODEM**, **X11 forwarding**

### 🔐 Security

- **Master password / lock screen / idle auto-lock**
- **Danger-command approval** (agent `rm` / `dd` / `reboot` … asks first, fail-closed)
- **Credential references** (keys live in the dsh credential service, never in plain config)
- **SSH key management** (generate / import / fingerprint)

### 🌍 Painless migration

Import sessions from **Xshell / MobaXterm / SecureCRT / WindTerm / FinalShell / Termius / Electerm / NyaTerm**; export JSON or MobaXterm format.

### 🩺 Custom diagnostics

Create, edit, copy, import and export diagnostic profiles with parameters, ordered steps, timeouts, output limits and AI analysis guidance. Custom SSH commands require confirmation before execution; serial and Telnet diagnostics read existing terminal output. Active remote checks currently target Linux / BusyBox.

See the [profile format and protocol](docs/diagnostic-profiles.md), [JSON Schema](docs/diagnostic-profile.schema.json) and [importable examples](docs/examples/diagnostic-profiles.json).

---

## ⚡ Install

Install into a dsh profile — `<profile>` is `desktop` for the app, `web` for `dsh web`.

### From npm (recommended)

```bash
dsh plugin --profile <profile> add dsh-aixterm
```

### From GitHub

```bash
dsh plugin --profile <profile> add "github:easyzoom/dsh-aixterm#main"
```

### From a local checkout (development)

```bash
cd /path/to/dsh-aixterm
npm ci
npm run build
dsh plugin --profile <profile> add /path/to/dsh-aixterm
```

Then restart DeepSeek Harness (or reload the web page) and open the **SSH sessions** sidebar page; create an SSH / Telnet / serial session or import one from another client.

Notes:
- Close the DeepSeek Harness desktop app before installing into the `desktop` profile — the running app locks the profile.
- Requires **Node.js ≥ 20** and a dsh build with the web UI. Native dependencies (`node-pty`, `serialport`) use platform binaries where available; unsupported platforms may need local build tools. Install dependencies on the target host instead of copying `node_modules` across operating systems.

### Development checks

```bash
npm ci
npm test
npm run build
```

CI runs tests and the client build on `ubuntu-latest`, `windows-latest` and `macos-latest` with Node.js 20. Keep `package-lock.json` synchronized with dependency changes. `node-pty` is pinned to `1.2.0-beta.18` to include executable macOS spawn helpers; regression tests check these permissions and retries for malformed generated SSH keys.

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

## 🗺 Roadmap

[Technical roadmap](docs/tools-roadmap.md): OTP management and SSH authentication integration are planned, including TOTP / HOTP, issuer, username, secret, SHA-1 / SHA-256 / SHA-512, digits, TOTP period and HOTP counter. These capabilities are not yet implemented.

## 📄 License

[MIT](LICENSE) · by [easyzoom](https://github.com/easyzoom)
