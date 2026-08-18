# 更新日志

## 1.0.0 — 2026-08-15

首个版本。从 Obsidian 的 obsidian-latex-suite(MIT, artisticat1)移植到 Forsion/Amadeus —— 上游长在
CodeMirror 6 上,Amadeus 是 ProseMirror,所以纯逻辑与数据原样搬、编辑器那一层整体重写。

- **片段展开**:默认表 200 余条开箱即用;options 标志(m/n/M/t/c/A/r/w/v/U)、优先级、正则捕获组
  `[[n]]`、`${VISUAL}`、片段变量 `${GREEK}` 等全部与上游逐字兼容 —— Obsidian 那边的 snippets.js 可整份贴过来。
- **占位跳转**:`$0` / `${0:默认值}`,Tab 前进、Shift-Tab 后退、Esc 退出;同名占位点**镜像联动**
  (ProseMirror 没有多光标,这是必要且更稳的替代)。
- **Tabout / 自动分式 / 矩阵快捷 / 自动放大括号**。
- **实时符号(conceal)**:光标不在那一段时把 LaTeX 显示成真符号。
- **公式命令**:框住当前公式 / 选中当前公式 / 插入行内或块级公式。
- **设置界面**:自绘面板 + 内嵌 CodeMirror 编辑片段库;片段库可放在笔记库的文件或文件夹里,存盘即热重载。
- 零 schema / 零序列化改动:公式在磁盘上始终是标准 markdown 的 `$…$`。

需要 Forsion 2.8.0 及以上(依赖 2026-08-15 新增的四条插件接缝:registerEditorExtension /
registerSettingsView / loadData·saveData / app.watchFile)。
