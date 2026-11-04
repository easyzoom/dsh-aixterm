// Fixed, read-only Linux checks. No interactive terminal input or model calls.
export const DIAGNOSTIC_SCENARIOS = [
  { id: "boot", label: "启动慢 / 启动异常" },
  { id: "service", label: "服务未启动" },
  { id: "storage", label: "存储不足 / 挂载异常" },
];

export function diagnosticChecks(scenario, service = "") {
  if (!DIAGNOSTIC_SCENARIOS.some((s) => s.id === scenario)) throw new Error("invalid-scenario");
  if (typeof service !== "string" || (service && !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/.test(service)) || (scenario === "service" && !service)) {
    throw new Error("invalid-service");
  }
  const identity = { id: "identity", label: "系统与运行时间", command: "uname -a; printf '\\nuptime: '; cat /proc/uptime; printf '\\ninit: '; cat /proc/1/comm" };
  const kernel = { id: "kernel", label: "内核日志末尾", command: "dmesg | tail -n 100" };
  if (scenario === "boot") return [identity,
    { id: "boot", label: "启动耗时", command: "if [ -d /run/systemd/system ] && command -v systemd-analyze >/dev/null 2>&1; then systemd-analyze time && systemd-analyze blame --no-pager; else printf '[unavailable] systemd-analyze; current uptime only:\\n'; cat /proc/uptime; fi" },
    kernel,
    { id: "processes", label: "当前进程", command: "ps" },
  ];
  if (scenario === "storage") return [identity,
    { id: "space", label: "文件系统容量", command: "df -kP" },
    { id: "inodes", label: "inode 使用情况", command: "df -i" },
    { id: "mounts", label: "挂载与只读状态", command: "cat /proc/mounts" },
  ];
  return [identity,
    { id: "service", label: `服务状态：${service}`, command: `if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then systemctl status --no-pager --full '${service}'; else printf 'No systemd; process matches (absence is not proof of failure):\\n'; ps | grep -F '${service}'; printf '\\nAvailable init script names (not executed):\\n'; ls /etc/init.d; fi` },
    kernel,
  ];
}
