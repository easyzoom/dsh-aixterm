import { useRef, useState } from "react";
import { profileDefinition, validateProfile, PROFILE_FILE_LIMIT } from "../../lib/diagnostic-profiles.js";

export function downloadProfiles(data, name = "diagnostic-profiles.json") {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// These are public identifiers, not authorization tokens. The fallback also
// works when the web UI is served over HTTP without secure-context UUID APIs.
const newId = () => "user-" + (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
const fresh = () => ({ schemaVersion: 1, id: newId(), name: "我的诊断方案", description: "", target: { os: ["linux"], transport: ["ssh"] }, inputs: [], checks: [{ id: "check-1", name: "系统信息", type: "command", command: "uname -a", timeoutMs: 5000, maxOutputBytes: 16384 }], analysis: { instructions: "" } });

export default function DiagnosticProfileEditor({ profiles, selectedId, onSaved, onClose, colors: C, styles: S }) {
  const initial = profiles.find((p) => p.id === selectedId);
  const copy = (p) => ({ ...profileDefinition(p), id: newId(), name: p.name.slice(0, 110) + " 副本" });
  const [source, setSource] = useState(initial?.id || "");
  const [draft, setDraft] = useState(() => initial ? initial.builtin ? copy(initial) : profileDefinition(initial) : fresh());
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [deleting, setDeleting] = useState(false);
  const fileRef = useRef(null);
  const sourceProfile = profiles.find((p) => p.id === source);
  const field = { ...S.input, width: "100%", boxSizing: "border-box" };
  const patch = (values) => { setDraft((p) => ({ ...p, ...values })); setDeleting(false); setMessage(""); };
  async function request(path, body) {
    const response = await fetch("/dsh-aixterm" + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  async function perform(action) {
    setBusy(true); setMessage("");
    try { await action(); } catch (e) { setMessage(e.message); }
    finally { setBusy(false); }
  }
  function select(p) {
    setSource(p.id); setDraft(p.builtin ? copy(p) : profileDefinition(p)); setMessage(""); setDeleting(false);
  }
  function updateItem(key, index, values) { patch({ [key]: draft[key].map((p, i) => i === index ? { ...p, ...values } : p) }); }
  function move(index, direction) {
    const next = [...draft.checks], target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; patch({ checks: next });
  }
  return <div style={{ position: "fixed", inset: 0, zIndex: 55, background: "rgba(0,0,0,.65)", display: "flex", alignItems: "center", justifyContent: "center" }}>
    <section role="dialog" aria-modal="true" aria-label="诊断方案管理" style={{ width: 940, maxWidth: "95vw", height: "86vh", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", color: C.text, fontSize: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <strong style={{ flex: 1, fontSize: 15 }}>诊断方案管理</strong>
        <button style={S.btn} disabled={busy} onClick={() => { setSource(""); setDraft(fresh()); setMessage(""); setDeleting(false); }}>新建方案</button>
        <button style={S.btn} disabled={busy} onClick={() => fileRef.current?.click()}>导入 JSON</button>
        <input ref={fileRef} type="file" accept=".json,application/json" aria-label="导入方案文件" style={{ display: "none" }} onChange={(e) => {
          const file = e.target.files?.[0]; e.target.value = "";
          if (!file) return;
          perform(async () => {
            if (file.size > PROFILE_FILE_LIMIT) throw new Error("导入文件不能超过 1 MiB");
            const result = await request("/diagnostic-profiles/import", { data: JSON.parse(await file.text()) });
            await onSaved(result.profiles[0]?.id);
            setMessage(`已导入 ${result.profiles.length} 个方案；同 ID 方案会另存，不覆盖原方案。`);
          });
        }} />
        <button style={S.btn} disabled={busy} onClick={() => perform(async () => downloadProfiles((await request("/diagnostic-profiles/export")).data))}>导出用户方案</button>
        <button style={S.btn} disabled={busy} onClick={onClose}>关闭</button>
      </div>
      <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
        <nav aria-label="方案列表" style={{ width: 190, flexShrink: 0, overflowY: "auto", borderRight: `1px solid ${C.border}`, paddingRight: 12 }}>
          {profiles.map((p) => <button key={p.id} style={{ ...S.btn, width: "100%", marginBottom: 7, textAlign: "left", background: p.id === source ? C.accentBg : C.panel2 }} disabled={busy} onClick={() => select(p)}>{p.name}<small style={{ display: "block", marginTop: 4 }}>{p.builtin ? "内置 · 编辑时创建副本" : "用户方案"}</small></button>)}
        </nav>
        <div style={{ flex: 1, minWidth: 0, overflowY: "auto", paddingRight: 4 }}>
          {sourceProfile?.builtin ? <p style={{ color: C.accent }}>正在编辑内置方案的副本，保存不会修改原方案。</p> : null}
          <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0 }}>
            <label>方案名称<input aria-label="方案名称" style={field} value={draft.name} maxLength={120} onChange={(e) => patch({ name: e.target.value })} /></label>
            <label style={{ display: "block", marginTop: 8 }}>方案 ID<input aria-label="方案 ID" style={field} value={draft.id} disabled={!!sourceProfile && !sourceProfile.builtin && source === draft.id} onChange={(e) => patch({ id: e.target.value })} /></label>
            <label style={{ display: "block", marginTop: 8 }}>说明<textarea aria-label="方案说明" style={field} rows={2} value={draft.description || ""} maxLength={2000} onChange={(e) => patch({ description: e.target.value })} /></label>
            <p style={{ color: C.dim }}>目标系统：Linux / BusyBox（与 DSH 宿主系统无关）。适用连接：</p>
            {["ssh", "serial", "telnet"].map((kind) => <label key={kind} style={{ marginRight: 14 }}><input type="checkbox" checked={draft.target.transport.includes(kind)} onChange={(e) => patch({ target: { ...draft.target, transport: e.target.checked ? [...draft.target.transport, kind] : draft.target.transport.filter((k) => k !== kind) } })} />{kind === "serial" ? "串口" : kind.toUpperCase()}</label>)}
            <h4>输入参数</h4>
            {draft.inputs.map((input, i) => <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto auto", gap: 5, marginBottom: 6 }}>
              <input aria-label={`参数 ${i + 1} ID`} style={field} placeholder="参数 ID" value={input.id} onChange={(e) => updateItem("inputs", i, { id: e.target.value })} />
              <input aria-label={`参数 ${i + 1} 名称`} style={field} placeholder="显示名称" value={input.name} onChange={(e) => updateItem("inputs", i, { name: e.target.value })} />
              <input aria-label={`参数 ${i + 1} 默认值`} style={field} placeholder="默认值" value={input.default || ""} maxLength={256} onChange={(e) => updateItem("inputs", i, { default: e.target.value })} />
              <label><input type="checkbox" checked={input.required !== false} onChange={(e) => updateItem("inputs", i, { required: e.target.checked })} />必填</label>
              <button style={S.btn} onClick={() => patch({ inputs: draft.inputs.filter((_, n) => n !== i) })}>移除</button>
            </div>)}
            <button style={S.btn} disabled={draft.inputs.length >= 8} onClick={() => patch({ inputs: [...draft.inputs, { id: `param${draft.inputs.length + 1}`, name: "参数", required: true, default: "" }] })}>添加参数</button>
            <h4>检查步骤</h4>
            <p style={{ color: C.dim, lineHeight: 1.5 }}>用 {"{{参数ID}}"} 插入参数，插件会统一引用。占位符须独立书写，不要放进引号、注释或 here-document。命令仅经 SSH 执行；串口 / Telnet 仅采集已有日志。</p>
            {draft.checks.map((check, i) => <div key={i} style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 7, alignItems: "center" }}>
                <strong>步骤 {i + 1} · {check.type === "terminal" ? "终端日志" : "SSH 命令"}</strong><span style={{ flex: 1 }} />
                <button style={S.btn} disabled={i === 0} onClick={() => move(i, -1)}>上移</button><button style={S.btn} disabled={i === draft.checks.length - 1} onClick={() => move(i, 1)}>下移</button><button style={S.btn} onClick={() => patch({ checks: draft.checks.filter((_, n) => n !== i) })}>移除步骤</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}><input aria-label={`步骤 ${i + 1} ID`} style={field} value={check.id} placeholder="检查 ID" onChange={(e) => updateItem("checks", i, { id: e.target.value })} /><input aria-label={`步骤 ${i + 1} 名称`} style={field} value={check.name} placeholder="检查名称" onChange={(e) => updateItem("checks", i, { name: e.target.value })} /></div>
              {check.type !== "terminal" ? <textarea aria-label={`步骤 ${i + 1} 命令`} style={{ ...field, fontFamily: "monospace", marginTop: 7 }} rows={3} maxLength={4096} value={check.command} onChange={(e) => updateItem("checks", i, { command: e.target.value })} /> : null}
              <div style={{ display: "flex", gap: 10, marginTop: 7 }}>
                {check.type !== "terminal" ? <label>超时（毫秒）<input aria-label={`步骤 ${i + 1} 超时`} style={field} type="number" min={100} max={15000} value={check.timeoutMs ?? 5000} onChange={(e) => updateItem("checks", i, { timeoutMs: Number(e.target.value) })} /></label> : null}
                <label>输出上限（字节）<input aria-label={`步骤 ${i + 1} 输出上限`} style={field} type="number" min={256} max={32768} value={check.maxOutputBytes ?? 16384} onChange={(e) => updateItem("checks", i, { maxOutputBytes: Number(e.target.value) })} /></label>
              </div>
            </div>)}
            <div style={{ display: "flex", gap: 7 }}><button style={S.btn} disabled={draft.checks.length >= 12} onClick={() => patch({ checks: [...draft.checks, { id: "check-" + newId().slice(5), name: "新检查", type: "command", command: "uname -a", timeoutMs: 5000, maxOutputBytes: 16384 }] })}>添加 SSH 检查</button><button style={S.btn} disabled={draft.checks.length >= 12 || draft.checks.some((c) => c.type === "terminal")} onClick={() => patch({ checks: [...draft.checks, { id: "terminal", name: "终端日志末尾", type: "terminal", maxOutputBytes: 12000 }] })}>添加终端日志</button></div>
            <label style={{ display: "block", marginTop: 15 }}>AI 分析重点<textarea aria-label="AI 分析重点" style={field} rows={3} maxLength={8000} value={draft.analysis?.instructions || ""} placeholder="例如：重点检查网络初始化与驱动错误，引用检查 ID。" onChange={(e) => patch({ analysis: { instructions: e.target.value } })} /></label>
          </fieldset>
        </div>
      </div>
      {message ? <p role="status" style={{ marginBottom: 4, overflowWrap: "anywhere", color: C.warn }}>{message}</p> : null}
      <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
        {sourceProfile && !sourceProfile.builtin ? <button style={{ ...S.btn, color: C.danger }} disabled={busy} onClick={() => deleting ? perform(async () => { await request("/diagnostic-profiles/delete", { id: source }); await onSaved(); setSource(""); setDraft(fresh()); setDeleting(false); setMessage("已删除用户方案。"); }) : setDeleting(true)}>{deleting ? "确认删除此方案" : "删除方案"}</button> : null}
        <button style={S.btn} disabled={busy} onClick={() => { setDraft(copy(draft)); setSource(""); setMessage(""); }}>复制为新方案</button>
        <button style={S.btn} disabled={busy} onClick={() => perform(async () => downloadProfiles({ schemaVersion: 1, profiles: [validateProfile(draft)] }, draft.id + ".json"))}>导出当前草稿</button>
        <button style={S.btnPrimary} disabled={busy} onClick={() => perform(async () => { const result = await request("/diagnostic-profiles", validateProfile(draft)); await onSaved(result.profile.id); setSource(result.profile.id); setDraft(result.profile); setMessage("方案已保存；没有执行任何命令。"); })}>{busy ? "处理中…" : "保存方案"}</button>
      </div>
    </section>
  </div>;
}
