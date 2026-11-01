[English](README.md) | [简体中文](README.zh.md)

[![npm](https://img.shields.io/badge/npm-unpublished-lightgrey?logo=npm&logoColor=white)](#install)
[![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-536DFE)](https://github.com/deepseek-ai/deepseek-harness)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/easyzoom/dsh-aixterm/actions/workflows/ci.yml/badge.svg)](https://github.com/easyzoom/dsh-aixterm/actions/workflows/ci.yml)

![dsh-aixterm banner](https://raw.githubusercontent.com/easyzoom/dsh-aixterm/main/docs/images/banner.svg)

# dsh-aixterm

SSH / SFTP session manager for **DeepSeek Harness** — **shared by the human and the AI agent**. The human uses a sidebar page; the agent uses tools; both drive the **same saved sessions** and the **same per-session command log**, so each side sees exactly what the other did.

## Features (v0.1)

- **Saved SSH sessions** — password / private-key / ssh-agent, named and grouped.
- **Sidebar page** (under Plugins) with a connection list and real **xterm.js terminals**: multiple tabs, SSH and local shells, full keyboard, resize, scrollback and clickable links.
- **SFTP file browser** — browse remote directories, **drag-and-drop upload** and one-click **download**.
- **Shared interactive terminal (human + agent)** — the agent opens the same PTY with `aixterm_term_open` and reads/sends with `aixterm_term_read` / `aixterm_term_send`.
- **Shared log (human + agent)** — every one-shot run, from the UI (`source: human`) or a tool (`source: agent`), is recorded with command, output, exit code and time.
- **Agent tools** — `aixterm_list_sessions`, `aixterm_run`, `aixterm_sftp_list`, `aixterm_test`, and the terminal trio above.
- **Secrets encrypted at rest** — passwords / key passphrases are AES-256-GCM encrypted in the data dir.
- **Configurable data dir** — session files, the encryption key and terminal scrollback logs share one directory (plugin config `dataDir`, default `$DSH_HOME/aixterm`).

## Install

Use the bundled `dsh` CLI. Replace `<profile>` with your profile name (`desktop` for the app, `web` for `dsh web`, …).

```bash
# 1) git source (main channel)
dsh plugin --profile <profile> add "github:easyzoom/dsh-aixterm#main"

# 2) npm (once published to npm)
dsh plugin --profile <profile> add dsh-aixterm

# 3) local dev (a checkout of this repo)
dsh plugin --profile <profile> add /path/to/dsh-aixterm
```

Notes:
- The **desktop profile is locked by the running app** — close DeepSeek Harness before a CLI install.
- The git source works for a private repo too when your git credentials are set.
- The npm command requires the package to be published first.

## Usage

1. Open the sidebar **SSH 会话** page → **+ 新建** → fill in host / port / user / auth → save. The session opens in a terminal tab.
2. Or click **本地终端** for a local shell (PowerShell / `$SHELL`).
3. For an SSH tab, the **文件 (SFTP)** panel on the right lists the home directory. Click a folder to enter it; **drag files onto the panel** to upload; click **↓** to download.
4. The agent can open the same interactive terminal with `aixterm_term_open` and read/send with `aixterm_term_read` / `aixterm_term_send` — the human sees the same screen. One-shot commands use `aixterm_run` and appear in the shared log with a **人 / AI** badge.

## Data & security

- Sessions live in `$DSH_HOME/aixterm` (`sessions.json`); the AES key in `.aixterm.key`; terminal scrollback logs in `terminals/`. Treat that directory as sensitive.
- Set the plugin's `dataDir` option to store all of the above elsewhere.
- Host routes are served by DSH's web server (loopback); add your own reverse-proxy trust / auth if exposed.
- Prefer **private keys** over stored passwords; passwords are encrypted but the key sits in the same data dir.

## License

MIT
