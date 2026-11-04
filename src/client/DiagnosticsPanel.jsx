import { useEffect, useRef, useState } from "react";
import { formatDiagnosticPrompt } from "../../lib/diagnostics.js";
import { builtinProfiles } from "../../lib/diagnostic-profiles.js";
import DiagnosticProfileEditor from "./DiagnosticProfileEditor.jsx";

const errors = {
  "invalid-service": "请输入服务名：以字母或数字开头，最多 64 个字符，可包含 . _ @ -。",
  "session-not-found": "会话已不存在，请重新选择。",
  "terminal-session-mismatch": "终端与当前连接配置不匹配，请关闭并重新连接终端。",
  "diagnostic-in-progress": "此会话已有诊断任务正在运行，请稍后再试。",
  "locked": "插件已锁定，请先解锁。",
  "timeout": "检查超时，已保留收到的输出。",
  "output-limit": "输出达到上限，已截断。",
  "unsupported-target-platform": "首版主动检查支持远端 Linux / BusyBox；当前目标系统不支持。",
  "no-terminal-output": "当前没有可用终端输出，请先连接设备并接收日志。",
  "terminal-route-unverified": "本次诊断经跳板连接，终端日志的连接路径无法核实，已排除这些日志。",
  "confirmation-required-or-stale": "确认已失效，请重新预览当前方案后再运行。",
  "unsupported-profile-transport": "此方案不适用于当前连接类型，请选择其他方案或修改适用连接。",
  "command-requires-ssh": "此步骤需要 SSH；当前连接仅能读取已有日志，没有发送命令。",
};

export default function DiagnosticsPanel({ sessionId, terminalId, sessionName, sessionKind = "ssh", onAsk, colors: C, styles: S }) {
  const [scenario, setScenario] = useState("boot");
  const [profiles, setProfiles] = useState(builtinProfiles);
  const [values, setValues] = useState({});
  const [preview, setPreview] = useState(null);
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const profileGeneration = useRef(0);
  useEffect(() => {
    generation.current++;
    setReport(null);
    setPreview(null);
    setError("");
    setBusy(false);
    return () => { generation.current++; };
  }, [sessionId, terminalId]);

  useEffect(() => {
    let alive = true;
    const current = ++profileGeneration.current;
    fetch("/dsh-aixterm/diagnostic-profiles").then((r) => r.json()).then((data) => {
      if (!data.ok) throw new Error(data.error || "无法读取方案");
      if (alive && current === profileGeneration.current) setProfiles(data.profiles);
    }).catch((err) => { if (alive && current === profileGeneration.current) setError(`方案列表加载失败：${err.message}；仍可使用内置方案。`); });
    return () => { alive = false; };
  }, []);

  function clearResult() { generation.current++; setPreview(null); setReport(null); setError(""); }
  const selected = profiles.find((p) => p.id === scenario) || profiles[0];
  async function reloadProfiles(id) {
    const current = ++profileGeneration.current;
    const response = await fetch("/dsh-aixterm/diagnostic-profiles"), result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "无法读取方案");
    if (current !== profileGeneration.current) return;
    setProfiles(result.profiles);
    setScenario(id || (result.profiles.some((p) => p.id === scenario) ? scenario : "boot"));
    setValues({}); clearResult();
  }

  async function collect(confirmation) {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setReport(null);
    try {
      const payload = confirmation?.request || { sessionId, terminalId, profileId: selected.id, inputs: Object.fromEntries(selected.inputs.map((input) => [input.id, values[input.id] ?? input.default ?? ""])) };
      const needsPreview = !confirmation && !selected.builtin && sessionKind === "ssh" && selected.checks.some((c) => c.type === "command");
      const response = await fetch("/dsh-aixterm/diagnose" + (needsPreview ? "/preview" : ""), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, ...(confirmation ? { confirmationToken: confirmation.confirmationToken } : {}) }),
      });
      const result = await response.json();
      if (current !== generation.current) return;
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (result.session?.id !== sessionId) throw new Error("terminal-session-mismatch");
      if (needsPreview) setPreview({ ...result, request: payload });
      else { setPreview(null); setReport(result); }
    } catch (err) {
      if (current === generation.current) setError(errors[err.message] || `采集失败：${err.message}`);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  const field = { ...S.input, boxSizing: "border-box", width: "100%", marginTop: 5 };
  return (
    <section aria-label="设备排障" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12, fontSize: 12, color: C.text }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>设备排障</div>
      <div style={{ color: C.dim, lineHeight: 1.6, marginBottom: 12 }}>
        {sessionName || sessionId}<br />
        内置方案只读采集；用户命令运行前可预览。串口 / Telnet 仅读已有日志。
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}><span>诊断方案</span><button style={S.btn} disabled={busy} onClick={() => setManage(true)}>管理 / 导入导出</button></div>
      <label>
        <select aria-label="诊断方案" style={field} value={selected.id} disabled={busy} onChange={(e) => { setScenario(e.target.value); setValues({}); clearResult(); }}>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.builtin ? "[内置] " : "[用户] "}{p.name}</option>)}
        </select>
      </label>
      {selected.description ? <p style={{ color: C.dim }}>{selected.description}</p> : null}
      {selected.inputs.map((input) => <label key={input.id} style={{ display: "block", marginTop: 10 }}>{input.name}{input.required ? " *" : ""}
        <input aria-label={input.name} style={field} value={values[input.id] ?? input.default ?? ""} maxLength={256} disabled={busy} onChange={(e) => { setValues((p) => ({ ...p, [input.id]: e.target.value })); clearResult(); }} />
      </label>)}
      <button style={{ ...S.btnPrimary, marginTop: 12, width: "100%" }} disabled={busy || !sessionId || selected.inputs.some((input) => input.required && !(values[input.id] ?? input.default ?? "").trim())} onClick={() => collect()}>
        {busy ? "处理中…" : !selected.builtin && sessionKind === "ssh" && selected.checks.some((c) => c.type === "command") ? "预览运行方案" : "采集诊断信息"}
      </button>
      {busy ? <p role="status" style={{ color: C.dim }}>按方案的超时与输出上限处理，建立连接可能需要额外时间。</p> : null}
      {error ? <p role="alert" style={{ color: C.danger, overflowWrap: "anywhere" }}>{error}</p> : null}
      {preview ? <div style={{ border: `1px solid ${C.warn}`, borderRadius: 6, padding: 10, marginTop: 12 }}>
        <strong>确认运行用户方案</strong>
        <p>目标：{preview.session.name} · {preview.session.user ? preview.session.user + "@" : ""}{preview.session.host}{preview.session.port ? ":" + preview.session.port : ""}</p>
        {preview.jump ? <p>经跳板：{preview.jump.name} · {preview.jump.user}@{preview.jump.host}:{preview.jump.port}</p> : null}
        <p style={{ color: C.warn }}>以下命令尚未执行。用户方案可能修改设备，请核对后确认。</p>
        {preview.checks.map((c) => <div key={c.id}><strong>{c.name}</strong><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.command || "仅读取已有终端日志"}</pre>{c.command ? <small>{c.timeoutMs} ms · 最多 {c.maxOutputBytes} 字节</small> : null}</div>)}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}><button style={S.btn} disabled={busy} onClick={() => setPreview(null)}>取消</button><button style={S.btnPrimary} disabled={busy} onClick={() => collect(preview)}>确认并执行这些命令</button></div>
      </div> : null}
      {report ? <div style={{ marginTop: 16 }}>
        <div style={{ fontWeight: 600 }}>{report.partial ? "已采集，部分信息不完整" : "诊断信息已采集"}</div>
        <p style={{ color: C.dim, lineHeight: 1.6 }}>
          {report.session.name} · {new Date(report.collectedAt).toLocaleString()}<br />
          {report.mode === "buffer-only" ? "仅终端日志；未向设备发送命令。" : report.profile?.builtin === false ? "用户方案已运行；采集成功不表示设备正常。" : "远端只读检查；采集成功不表示设备正常。"}
        </p>
        {report.findings.map((f, i) => <p key={i} style={{ lineHeight: 1.5, color: f.level === "warning" ? C.warn : C.dim }}>[{f.evidenceId}] {f.message}</p>)}
        {report.evidence.map((item) => <details key={item.id} open={item.status !== "collected"} style={{ borderTop: `1px solid ${C.border}`, padding: "9px 0" }}>
          <summary style={{ cursor: "pointer", overflowWrap: "anywhere" }}>
            [{item.id}] {item.label} {item.status === "collected" ? "✓" : "⚠"}{item.truncated ? " · 已截断" : ""}
          </summary>
          <div style={{ color: C.dim, fontSize: 11, marginTop: 6 }}>
            {item.collectedAt}{item.code != null ? ` · 退出码 ${item.code}` : ""}
          </div>
          {item.command ? <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: C.accent }}>$ {item.command}</pre> : null}
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 250, overflowY: "auto", marginBottom: 4 }}>{item.stdout || "（无输出）"}</pre>
          {item.stderr ? <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: C.warn }}>{item.stderr}</pre> : null}
          {item.error ? <p style={{ color: C.warn }}>{errors[item.error] || item.error}</p> : null}
        </details>)}
        <p style={{ color: C.dim, lineHeight: 1.5 }}>请先检查报告中的设备日志。点击下方按钮才会将报告发送到 AI 对话。</p>
        <button style={{ ...S.btnPrimary, width: "100%" }} disabled={!onAsk} title={onAsk ? "将此报告交给主 AI 会话分析" : "请先切回此报告对应的终端会话"} onClick={() => onAsk?.(report, formatDiagnosticPrompt(report))}>交给 AI 分析</button>
        {!onAsk ? <p style={{ color: C.dim }}>请切回此报告对应的终端会话，再交给 AI 分析。</p> : null}
      </div> : null}
      {manage ? <DiagnosticProfileEditor profiles={profiles} selectedId={selected.id} onSaved={reloadProfiles} onClose={() => setManage(false)} colors={C} styles={S} /> : null}
    </section>
  );
}
