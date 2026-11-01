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
      async execute(args) {
        return host.run(args.sessionId, args.command, "agent", args.timeoutMs);
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
  ];
}
