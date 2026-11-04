# 诊断方案格式与使用说明

在设备排障面板点击“管理 / 导入导出”即可新建、编辑或复制方案。内置方案编辑时自动创建副本。编辑器支持输入参数、步骤增删与排序、超时与输出上限、AI 分析重点。保存、复制、导入与预览都不会执行命令。

用户方案存储于插件数据目录的 `diagnostic-profiles.json`。方案不保存连接凭据或报告；不要在命令或默认输入里硬编码密码。Windows、Linux、macOS 宿主使用相同文件格式，不依赖宿主 shell。首版主动检查的远端目标为 Linux / BusyBox。

## 文件格式

- [JSON Schema](diagnostic-profile.schema.json)：JSON Schema Draft 2020-12，同时接受单个方案和方案集合。
- [可导入示例](examples/diagnostic-profiles.json)：参数化服务检查与纯终端日志分析。

单个方案：

```json
{
  "schemaVersion": 1,
  "id": "my-storage",
  "name": "磁盘容量检查",
  "target": { "os": ["linux"], "transport": ["ssh"] },
  "checks": [
    { "id": "space", "name": "容量", "command": "df -kP", "timeoutMs": 5000, "maxOutputBytes": 16384 }
  ],
  "analysis": { "instructions": "指出高使用率分区，引用证据并提出后续验证建议。" }
}
```

集合格式为 `{ "schemaVersion": 1, "profiles": [方案, 方案] }`。集合内每个方案同样需要 `schemaVersion`。空集合可作为空库导出，但没有可导入的检查。

## 字段与约束

| 字段 | 含义 |
|---|---|
| `schemaVersion` | 固定为 `1`，未知版本拒绝导入 |
| `id` | 1–64 位小写字母开头，可包含数字、点、下划线、连字符；不能用路径或 `constructor` / `prototype` |
| `name` / `description` | 方案名称（120 字符）与可选说明（2000 字符） |
| `target.os` | 首版只接受 `["linux"]`，描述被诊断设备，不是 DSH 宿主 |
| `target.transport` | `ssh`、`serial`、`telnet` 的非空集合 |
| `inputs` | 最多 8 个输入；各有 `id`、`name`、可选 `required`（默认 true）和 `default` |
| `checks` | 1–12 个顺序执行的步骤，检查 ID 不重复；`platform` 保留给系统识别 |
| `analysis.instructions` | 最多 8000 字符的分析重点，与证据一起提交；不是操作授权 |

命令步骤 `type` 可省略或为 `command`，需要 `command`（最多 4096 字符）；`timeoutMs` 为 100–15000（默认 5000）；`maxOutputBytes` 为 256–32768（默认 16384）。命令步骤不能使用 `terminal` 作为 ID。

日志步骤必须指定 `type: "terminal"`，不允许 `command` 或 `timeoutMs`，默认输出上限 12000 字节。每个方案最多一个日志步骤。它只读取当前终端已有输出，不执行命令，且不能保证日志属于本次启动。

每个方案的命令超时合计最多 60000 毫秒，输出上限合计最多 131072 字节；SSH 目标识别另有 5 秒及 16 KiB 上限。文件与整个用户库最多 1 MiB，最多 100 个用户方案。JSON Schema 校验结构；插件还会校验 ID 唯一性、模板上下文和合计资源限制。未知字段被拒绝。

## 参数引用

输入 ID 为 1–32 位小写字母开头的字母、数字或下划线。值为最多 256 字符的单行文本。命令中用独立的 `{{service}}` 引用输入：

```json
{
  "inputs": [{ "id": "service", "name": "服务名", "required": true }],
  "checks": [{ "id": "status", "name": "服务状态", "command": "systemctl status --no-pager {{service}}" }]
}
```

以上是字段片段，不是可直接导入的完整文件。插件把参数转换成单个 POSIX shell 引用参数；不要给占位符额外加引号，不允许在注释、here-document 或字词拼接里使用。未定义参数、未知输入、缺失必填值都会拒绝执行。引用处理不是沙箱：`eval`、解释器脚本等命令仍可能把参数当代码，方案作者与运行用户必须检查实际命令。

## 导入、导出与冲突

- 导入先校验全部方案，任意条目失败则整批不写入。
- 文件内部重复 ID 拒绝；与库中已有 ID 冲突时自动另存为 `id-2` 等新 ID。
- 导入内置 ID 时另存为 `user-boot` 等用户 ID，内置方案不会覆盖。
- 编辑已有用户方案并保存会更新该方案；“复制为新方案”分配新 ID。
- “导出当前草稿”导出校验后的单方案集合；“导出用户方案”导出全部已保存的用户方案，不包含内置模板。

## 运行与审批

内置方案保留一键采集。自定义 SSH 命令方案先展示已替换参数的完整命令、目标和限制，再由用户确认运行。确认有效期 5 分钟，只能使用一次；目标、终端、方案或输入变更后需重新预览。

agent 使用 `aixterm_diagnostic_profiles` 查看方案定义，用 `aixterm_diagnose` 的 `profileId` 与 `inputs` 执行。自定义命令方案总是请求一批用户审批，即使命令未匹配危险关键词或通用危险命令审批开关关闭；审批不可用或被拒绝时不执行。

不适用当前连接的方案会拒绝运行。串口/Telnet 不执行命令步骤，会说明这些步骤缺少信息；纯日志方案不需要 SSH 连接或命令审批。缺少工具、无权限、超时、截断和目标系统不支持都不能视为设备正常。采集后仍需用户点击“交给 AI 分析”，才发送报告。
