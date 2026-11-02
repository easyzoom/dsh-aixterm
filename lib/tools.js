// lib/tools.js — agent tools. Kept separate so lib/index.js can load even in an
// environment where @deepseek-ai/dsh-tools is not resolvable (routes still work;
// only the agent-tool surface is dropped).
import { defineTool } from "@deepseek-ai/dsh-tools";

function renderJson(_args, value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}
const OUT = { schema: { type: "json" }, render: renderJson };

/**
 * Build the aixterm tool set over a host face:
 *   { listSessions(), run(sessionId, command, source, timeoutMs),
 *     sftpList(sessionId, path), test(sessionId) }
 */
export function buildTools(host) {
  return [
    defineTool({
      name: "aixterm_list_sessions",
      description:
        "List the saved SSH sessions shared by the human and the agent (id, name, group, host, port, user, auth kind). Use an id with aixterm_run / aixterm_sftp_list / aixterm_test.",
      parameters: {},
      output: OUT,
      isConcurrencySafe: () => true,
      async execute() {
        return { ok: true, sessions: host.listSessions() };
      },
    }),
    defineTool({
      name: "aixterm_run",
      description:
        "Run ONE non-interactive shell command on a saved SSH session and return stdout, stderr and exit code. The run is appended to the session's shared log, so the human sees exactly what the agent ran. Prefer read-only commands; ask the human before destructive ones.",
      parameters: {
        sessionId: { type: "string", required: true, description: "Session id from aixterm_list_sessions." },
        command: { type: "string", required: true, description: "The shell command to run on the remote host." },
        timeoutMs: { type: "integer", description: "Timeout in milliseconds (default 30000)." },
      },
      output: OUT,
      async execute(args, exec) {
        return host.run(args.sessionId, args.command, "agent", args.timeoutMs, exec);
      },
    }),
    defineTool({
      name: "aixterm_sftp_list",
      description: "List a remote directory over SFTP on a saved SSH session.",
      parameters: {
        sessionId: { type: "string", required: true, description: "Session id." },
        path: { type: "string", description: "Remote directory (default: the login directory '.')." },
      },
      output: OUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        return host.sftpList(args.sessionId, args.path);
      },
    }),
    defineTool({
      name: "aixterm_test",
      description: "Test connectivity and credentials of a saved SSH session.",
      parameters: {
        sessionId: { type: "string", required: true, description: "Session id." },
      },
      output: OUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        return host.test(args.sessionId);
      },
    }),
    defineTool({
      name: "aixterm_read_log",
      description:
        "Read a saved session's recent shared command log and its terminal scrollback tail, addressed by session id OR exact session name. Use this when the user references a terminal with @<session name> and asks what happened there.",
      parameters: {
        session: { type: "string", required: true, description: "Session id or exact session name." },
        maxBytes: { type: "integer", description: "Max scrollback bytes to read (default 12000)." },
      },
      output: OUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        return host.readLog(args.session, args.maxBytes);
      },
    }),
    defineTool({
      name: "aixterm_analyze",
      description:
        "Diagnose a saved session in one call: connection facts, resource monitor (CPU/memory/load/disk/network, SSH only), recent commands, and the terminal scrollback tail. Use when the user asks to analyze a terminal the conversation @-references.",
      parameters: {
        session: { type: "string", required: true, description: "Session id or exact session name." },
      },
      output: OUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        return host.analyze(args.session);
      },
    }),
    defineTool({
      name: "aixterm_create_session",
      description:
        "Save a new SSH session in the aixtem sidebar (does not connect). host and user are required; password/group/credentialEnv are optional.",
      parameters: {
        name: { type: "string", description: "Display name (default user@host)." },
        host: { type: "string", required: true, description: "Hostname or IP." },
        port: { type: "integer", description: "SSH port (default 22)." },
        user: { type: "string", required: true, description: "Login user." },
        password: { type: "string", description: "Optional password, stored encrypted." },
        group: { type: "string", description: "Optional group label." },
        credentialEnv: { type: "string", description: "Optional dsh credential key name instead of a password." },
      },
      output: OUT,
      isConcurrencySafe: () => false,
      async execute(args) {
        return host.createSession(args);
      },
    }),
    defineTool({
      name: "aixterm_tmux_sessions",
      description:
        "List the tmux sessions on a saved SSH session (by id or session name). Reports whether tmux is installed on the remote host. Pair with aixterm_run for tmux commands (send-keys, capture-pane).",
      parameters: {
        session: { type: "string", required: true, description: "Session id or exact session name." },
      },
      output: OUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        return host.tmuxList(args.session);
      },
    }),
    defineTool({
      name: "aixterm_term_open",
      description:
        "Open an interactive terminal (a PTY) for a saved SSH session, or a local shell when sessionId is omitted. Returns a terminalId for aixterm_term_read / aixterm_term_send. The human also opens terminals from the sidebar page; both share the same terminal.",
      parameters: {
        sessionId: { type: "string", description: "Saved SSH session id; omit to open a local shell." },
        shell: { type: "string", description: "Local shell (defaults to PowerShell on Windows, $SHELL elsewhere)." },
      },
      output: OUT,
      async execute(args) {
        return host.termOpen({ sessionId: args.sessionId, local: { shell: args.shell } });
      },
    }),
    defineTool({
      name: "aixterm_term_read",
      description: "Read the tail of an interactive terminal's buffer (the terminal the human and the agent share). Returns raw terminal text including escape codes.",
      parameters: {
        terminalId: { type: "string", required: true, description: "Terminal id." },
        maxBytes: { type: "integer", description: "Max bytes from the tail (default 16384)." },
      },
      output: OUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        return host.termRead(args.terminalId, args.maxBytes);
      },
    }),
    defineTool({
      name: "aixterm_term_send",
      description: "Send input (keystrokes or a command line) to the shared interactive terminal. Use \\r to press Enter. Prefer read-only commands; ask the human before destructive ones.",
      parameters: {
        terminalId: { type: "string", required: true, description: "Terminal id." },
        data: { type: "string", required: true, description: "Text to write; include \\r to run a line." },
      },
      output: OUT,
      async execute(args, exec) {
        return host.termSend(args.terminalId, args.data, exec);
      },
    }),
  ];
}
