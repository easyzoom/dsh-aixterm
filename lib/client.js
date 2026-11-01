/**
 * dsh-aixterm — client UI (hand-written __ModuleLoader__ bundle, no build step).
 *
 * Shared by the human and the agent: the session list, the per-session shared
 * log (who ran what), the command console, and SFTP browsing all call the host
 * routes. Registered on the plugin page and as a Settings → Built-in plugins
 * tab. Registration is guarded and waits for a declared seat.
 */
window.__ModuleLoader__.load({
  id: "dsh-aixterm",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useCallback = react.useCallback;

    var PREFIX = "/dsh-aixterm";

    var S = {
      wrap: { display: "flex", flexDirection: "column", gap: "12px", padding: "4px 0", maxWidth: "720px", color: "#1a1a1a" },
      row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
      field: { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 150px" },
      label: { fontSize: "12px", color: "#666" },
      input: { border: "1px solid #d9d9d9", borderRadius: "7px", padding: "6px 9px", fontSize: "13px", background: "#fff", color: "#1a1a1a", outline: "none", width: "100%", boxSizing: "border-box" },
      primary: { background: "#111", color: "#fff", border: "1px solid #111", borderRadius: "7px", padding: "6px 14px", fontSize: "13px", cursor: "pointer" },
      secondary: { background: "#fff", color: "#1a1a1a", border: "1px solid #d9d9d9", borderRadius: "7px", padding: "6px 14px", fontSize: "13px", cursor: "pointer" },
      muted: { color: "#666", fontSize: "12px" },
      card: { border: "1px solid #e5e5e5", borderRadius: "9px", padding: "10px 12px", background: "#fff", display: "flex", flexDirection: "column", gap: "6px" },
      logBox: { border: "1px solid #e5e5e5", borderRadius: "9px", background: "#fafafa", padding: "10px", maxHeight: "360px", overflow: "auto", display: "flex", flexDirection: "column", gap: "10px" },
      pre: { margin: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#333" },
      badgeHuman: { fontSize: "11px", background: "#e8f0fe", color: "#1a56db", borderRadius: "10px", padding: "1px 8px" },
      badgeAgent: { fontSize: "11px", background: "#fde8e8", color: "#b91c1c", borderRadius: "10px", padding: "1px 8px" },
      ok: { fontSize: "12px", color: "#0a7d32" },
      err: { fontSize: "12px", color: "#c0392b" },
    };

    function fetchJson(path, init) {
      return fetch(path, init).then(function (r) {
        return r.json();
      });
    }
    function fmtTime(ts) {
      try {
        return new Date(ts).toLocaleTimeString();
      } catch (_) {
        return "";
      }
    }
    function Input(props) {
      return h("input", Object.assign({ style: S.input }, props));
    }
    function Field(label, control) {
      return h("div", { style: S.field }, h("div", { style: S.label }, label), control);
    }

    /** The sidebar row glyph (a terminal box with a > prompt). */
    function AixtermIcon(props) {
      var size = (props && props.size) || 16;
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          "data-dsh-panel-entry": "dsh-aixterm",
        },
        h("rect", { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.5 }),
        h("path", { d: "M4.5 6l2 2-2 2" }),
        h("path", { d: "M8.5 10h3" })
      );
    }

    var EMPTY_FORM = { name: "", host: "", port: "22", user: "", authKind: "password", password: "", keyPath: "" };

    function Card() {
      var st = useState([]);
      var sessions = st[0];
      var setSessions = st[1];
      var vw = useState("list");
      var view = vw[0];
      var setView = vw[1];
      var cur = useState(null);
      var currentId = cur[0];
      var setCurrentId = cur[1];
      var lg = useState([]);
      var log = lg[0];
      var setLog = lg[1];
      var bz = useState(false);
      var busy = bz[0];
      var setBusy = bz[1];
      var ms = useState(null);
      var msg = ms[0];
      var setMsg = ms[1];
      var sh = useState(false);
      var showCreate = sh[0];
      var setShowCreate = sh[1];
      var fm = useState(EMPTY_FORM);
      var form = fm[0];
      var setForm = fm[1];
      var cmdS = useState("");
      var cmd = cmdS[0];
      var setCmd = cmdS[1];
      var sftpS = useState(".");
      var sftpPath = sftpS[0];
      var setSftpPath = sftpS[1];
      var sftpE = useState(null);
      var sftpEntries = sftpE[0];
      var setSftpEntries = sftpE[1];

      var loadSessions = useCallback(function () {
        fetchJson(PREFIX + "/sessions")
          .then(function (d) {
            if (d && d.ok) setSessions(d.sessions || []);
          })
          .catch(function (e) {
            setMsg({ kind: "err", text: String(e) });
          });
      }, []);
      useEffect(function () {
        loadSessions();
      }, [loadSessions]);

      var loadLog = useCallback(function (id) {
        if (!id) return;
        fetchJson(PREFIX + "/log?sessionId=" + encodeURIComponent(id))
          .then(function (d) {
            if (d && d.ok) setLog(d.entries || []);
          })
          .catch(function () {});
      }, []);

      useEffect(
        function () {
          if (view !== "session" || !currentId) return undefined;
          loadLog(currentId);
          var t = setInterval(function () {
            loadLog(currentId);
          }, 3000);
          return function () {
            clearInterval(t);
          };
        },
        [view, currentId, loadLog]
      );

      function patch(k, v) {
        setForm(function (f) {
          var n = {};
          for (var key in f) n[key] = f[key];
          n[k] = v;
          return n;
        });
      }

      function createSession() {
        setBusy(true);
        setMsg(null);
        var body = {
          name: form.name || form.host,
          host: form.host,
          port: Number(form.port) || 22,
          user: form.user,
          auth: { kind: form.authKind },
        };
        if (form.authKind === "key") body.auth.keyPath = form.keyPath;
        else body.password = form.password;
        fetchJson(PREFIX + "/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
          .then(function (d) {
            if (d && d.ok) {
              setMsg({ kind: "ok", text: "已保存会话" });
              setShowCreate(false);
              setForm(EMPTY_FORM);
              loadSessions();
            } else setMsg({ kind: "err", text: (d && d.error) || "保存失败" });
          })
          .catch(function (e) {
            setMsg({ kind: "err", text: String(e) });
          })
          .finally(function () {
            setBusy(false);
          });
      }

      function removeSession(id) {
        fetchJson(PREFIX + "/sessions?id=" + encodeURIComponent(id), { method: "DELETE" })
          .then(function () {
            if (currentId === id) {
              setView("list");
              setCurrentId(null);
            }
            loadSessions();
          })
          .catch(function (e) {
            setMsg({ kind: "err", text: String(e) });
          });
      }

      function openSession(id) {
        setCurrentId(id);
        setView("session");
        setLog([]);
        setSftpEntries(null);
        setMsg(null);
      }

      function runCmd() {
        if (!currentId || !cmd.trim()) return;
        setBusy(true);
        setMsg(null);
        fetchJson(PREFIX + "/exec", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: currentId, command: cmd }) })
          .then(function (d) {
            if (d && d.error && d.code === undefined) setMsg({ kind: "err", text: d.error });
            setCmd("");
            loadLog(currentId);
          })
          .catch(function (e) {
            setMsg({ kind: "err", text: String(e) });
          })
          .finally(function () {
            setBusy(false);
          });
      }

      function testConn(id) {
        setBusy(true);
        setMsg(null);
        fetchJson(PREFIX + "/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: id }) })
          .then(function (d) {
            setMsg(d && d.ok ? { kind: "ok", text: "连接正常" } : { kind: "err", text: (d && d.error) || "连接失败" });
          })
          .catch(function (e) {
            setMsg({ kind: "err", text: String(e) });
          })
          .finally(function () {
            setBusy(false);
          });
      }

      function sftpList() {
        if (!currentId) return;
        setBusy(true);
        fetchJson(PREFIX + "/sftp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: currentId, op: "list", path: sftpPath }) })
          .then(function (d) {
            if (d && d.ok) setSftpEntries(d.entries || []);
            else setMsg({ kind: "err", text: (d && d.error) || "列目录失败" });
          })
          .catch(function (e) {
            setMsg({ kind: "err", text: String(e) });
          })
          .finally(function () {
            setBusy(false);
          });
      }

      var msgLine = msg ? h("div", { style: msg.kind === "ok" ? S.ok : S.err }, msg.text) : null;

      if (view === "session") {
        var s = null;
        for (var i = 0; i < sessions.length; i++) if (sessions[i].id === currentId) s = sessions[i];
        var logNodes = log.map(function (e, idx) {
          return h(
            "div",
            { key: idx, style: { borderBottom: "1px solid #eee", paddingBottom: "8px" } },
            h(
              "div",
              { style: { display: "flex", gap: "8px", alignItems: "center", marginBottom: "4px" } },
              h("span", { style: e.source === "agent" ? S.badgeAgent : S.badgeHuman }, e.source === "agent" ? "AI" : "人"),
              h("code", { style: { fontSize: "12px", color: "#111" } }, "$ " + e.command),
              h("span", { style: S.muted }, fmtTime(e.ts) + (e.code != null ? " · exit " + e.code : ""))
            ),
            e.stdout ? h("pre", { style: S.pre }, e.stdout) : null,
            e.stderr ? h("pre", { style: Object.assign({}, S.pre, { color: "#c0392b" }) }, e.stderr) : null
          );
        });
        return h(
          "div",
          { style: S.wrap },
          h(
            "div",
            { style: S.row },
            h("button", { style: S.secondary, onClick: function () { setView("list"); setCurrentId(null); } }, "← 会话列表"),
            h("strong", null, s ? s.name : currentId),
            h("span", { style: S.muted }, s ? s.user + "@" + s.host + ":" + s.port : ""),
            h("button", { style: S.secondary, disabled: busy, onClick: function () { testConn(currentId); } }, "测试连接")
          ),
          msgLine,
          h("div", { style: S.label }, "共享记录（人和 AI 共用）"),
          h("div", { style: S.logBox }, logNodes.length ? logNodes : h("div", { style: S.muted }, "暂无记录")),
          h(
            "div",
            { style: S.row },
            h(Input, { placeholder: "输入命令，回车执行，例如：ls -la", value: cmd, disabled: busy, onChange: function (e) { setCmd(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") runCmd(); } }),
            h("button", { style: S.primary, disabled: busy, onClick: runCmd }, busy ? "执行中…" : "执行")
          ),
          h(
            "div",
            { style: S.row },
            h(Input, { style: Object.assign({}, S.input, { flex: "1 1 200px", width: "auto" }), value: sftpPath, onChange: function (e) { setSftpPath(e.target.value); } }),
            h("button", { style: S.secondary, disabled: busy, onClick: sftpList }, "SFTP 列目录")
          ),
          sftpEntries
            ? h(
                "div",
                { style: S.logBox },
                sftpEntries.length === 0
                  ? h("div", { style: S.muted }, "空目录")
                  : sftpEntries.map(function (it, idx) {
                      return h(
                        "div",
                        { key: idx, style: { display: "flex", gap: "8px", fontSize: "12px", fontFamily: "ui-monospace, monospace" } },
                        h("span", null, it.isDirectory ? "📁" : "📄"),
                        h("span", { style: { flex: 1 } }, it.name),
                        h("span", { style: S.muted }, it.isDirectory ? "" : it.size + " B")
                      );
                    })
              )
            : null
        );
      }

      // list view
      var createForm = showCreate
        ? h(
            "div",
            { style: S.card },
            h(
              "div",
              { style: S.row },
              Field("名称", h(Input, { value: form.name, onChange: function (e) { patch("name", e.target.value); } })),
              Field("主机", h(Input, { placeholder: "192.168.1.10", value: form.host, onChange: function (e) { patch("host", e.target.value); } })),
              Field("端口", h(Input, { value: form.port, onChange: function (e) { patch("port", e.target.value); } }))
            ),
            h(
              "div",
              { style: S.row },
              Field("用户名", h(Input, { value: form.user, onChange: function (e) { patch("user", e.target.value); } })),
              Field(
                "认证",
                h(
                  "select",
                  { style: S.input, value: form.authKind, onChange: function (e) { patch("authKind", e.target.value); } },
                  h("option", { value: "password" }, "密码"),
                  h("option", { value: "key" }, "私钥文件"),
                  h("option", { value: "agent" }, "ssh-agent")
                )
              )
            ),
            form.authKind === "password"
              ? Field("密码", h(Input, { type: "password", value: form.password, onChange: function (e) { patch("password", e.target.value); } }))
              : form.authKind === "key"
                ? Field("私钥路径（本机绝对路径）", h(Input, { placeholder: "C:\\\\Users\\\\you\\\\.ssh\\\\id_ed25519", value: form.keyPath, onChange: function (e) { patch("keyPath", e.target.value); } }))
                : h("div", { style: S.muted }, "使用 ssh-agent（SSH_AUTH_SOCK）"),
            h(
              "div",
              { style: S.row },
              h("button", { style: S.primary, disabled: busy, onClick: createSession }, "保存会话"),
              h("button", { style: S.secondary, disabled: busy, onClick: function () { setShowCreate(false); } }, "取消")
            )
          )
        : null;

      var listNodes = sessions.map(function (s) {
        return h(
          "div",
          { key: s.id, style: Object.assign({}, S.card, { flexDirection: "row", alignItems: "center" }) },
          h("div", { style: { flex: 1 } }, h("strong", null, s.name), h("div", { style: S.muted }, s.user + "@" + s.host + ":" + s.port + " · " + (s.auth && s.auth.kind) + (s.hasSecret ? " · 已存凭据" : ""))),
          h("button", { style: S.primary, onClick: function () { openSession(s.id); } }, "打开"),
          h("button", { style: S.secondary, disabled: busy, onClick: function () { testConn(s.id); } }, "测试"),
          h("button", { style: S.secondary, disabled: busy, onClick: function () { removeSession(s.id); } }, "删除")
        );
      });

      return h(
        "div",
        { style: S.wrap },
        h("div", { style: Object.assign({}, S.row, { justifyContent: "space-between" }) }, h("strong", null, "SSH 会话"), h("button", { style: S.primary, onClick: function () { setShowCreate(!showCreate); } }, showCreate ? "收起" : "新建会话")),
        msgLine,
        createForm,
        listNodes.length ? listNodes : h("div", { style: S.muted }, "还没有会话。点「新建会话」添加。")
      );
    }

    function apply(ctx) {
      try {
        var slots = ctx && ctx.slots;
        if (!slots || typeof slots.register !== "function") return;
        var FAMILY = "web-ui.plugin.item";
        var OFFICIAL = "plugins.bundle.config";
        var dispose = null;
        var current = null;
        var reconciling = false;
        function familyLoaded() {
          try {
            return typeof ctx.get === "function" && ctx.get("webUiSettings") !== undefined;
          } catch (_) {
            return false;
          }
        }
        function reconcile() {
          if (reconciling) return;
          var target = familyLoaded() ? FAMILY : OFFICIAL;
          if (current === target) return;
          if (typeof slots.spec === "function" && slots.spec(target) === undefined) return;
          reconciling = true;
          var prev = dispose;
          dispose = null;
          current = null;
          try {
            prev && prev();
          } catch (_) {}
          try {
            var cfg =
              target === FAMILY
                ? { name: FAMILY, id: "dsh-aixterm", order: 100, label: function () { return "SSH 会话"; }, locale: "dsh-aixterm" }
                : { name: OFFICIAL, key: "dsh-aixterm", locale: "dsh-aixterm" };
            dispose = slots.register(cfg, Card);
            current = target;
          } catch (e) {
            try { console.warn("[dsh-aixterm] seat " + target + " refused", e); } catch (_) {}
          } finally {
            reconciling = false;
          }
        }
        if (typeof ctx.on === "function") {
          try { ctx.on("slots/changed", reconcile); } catch (_) {}
        }
        reconcile();
        if (typeof ctx.effect === "function") {
          ctx.effect(function () { return function () { try { dispose && dispose(); } catch (_) {} }; }, "dsh-aixterm: card");
        }
        // Sidebar page: a row under Plugins plus its center-column page
        // (the same sidebar.panellist + main pattern the task board uses).
        try {
          if (typeof slots.inject === "function") {
            var panelDisposers = [];
            panelDisposers.push(
              slots.inject("sidebar.panellist", function () {
                try {
                  return slots.register({ name: "sidebar.panellist", id: "dsh-aixterm", order: 30, label: function () { return "SSH 会话"; } }, AixtermIcon);
                } catch (e) {
                  try { console.warn("[dsh-aixterm] sidebar row failed", e); } catch (_) {}
                  return undefined;
                }
              })
            );
            panelDisposers.push(
              slots.inject("main", function () {
                try {
                  return slots.register({ name: "main", key: "dsh-aixterm" }, Card);
                } catch (e) {
                  try { console.warn("[dsh-aixterm] main page failed", e); } catch (_) {}
                  return undefined;
                }
              })
            );
            if (typeof ctx.effect === "function") {
              ctx.effect(function () {
                return function () {
                  for (var i = 0; i < panelDisposers.length; i++) {
                    try { panelDisposers[i] && panelDisposers[i](); } catch (_) {}
                  }
                };
              }, "dsh-aixterm: sidebar page");
            }
          }
        } catch (e) {
          try { console.warn("[dsh-aixterm] sidebar page inject failed", e); } catch (_) {}
        }
      } catch (e) {
        try { console.warn("[dsh-aixterm] client registration failed", e); } catch (_) {}
      }
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
