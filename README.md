# LaTeX 套件

[English](README.en.md)

在 Forsion 的 Amadeus 笔记中用短触发串输入 LaTeX。公式以 Markdown 的美元符号语法保存在笔记里。

## 快速上手

1. 在 Forsion 的插件市场安装并启用 **LaTeX 套件**。
2. 打开一篇 Amadeus 笔记，把光标放进正文。打开命令面板，运行 **插入行内公式**。命令会插入一对美元符号，光标停在中间。单独排版的公式用 **插入块级公式**。
3. 在定界符之间输入 `@a`，它会展开成 `\alpha`。继续输入 `sr`，得到 `\alpha^{2}`。
4. 另插一条空公式，输入 `//`，得到 `\frac{}{}`。输入分子，按 **Tab** 跳到分母。输入分母后再按 **Tab** 跳到分式后。

默认只在闭合的公式内自动展开片段。写正文时可以照常输入 `mk`、`dm`。想让它们自动插入公式，可在插件设置的 **片段**中开启 **正文自动片段**。

在插件设置的 **教程与练习**中，可按触发串、LaTeX 命令或说明搜索当前片段库。练习区使用与笔记相同的输入规则，练习内容只保留在内存中。

## 指南

- [快捷键与排障](docs/shortcuts.md)
- [自定义片段与 Obsidian 迁移](docs/custom-snippets.md)

## 开发

`npm ci` 安装依赖。`npm run verify` 执行类型检查、单元测试、打包和插件装载检查。修改源码后，把重新构建的 `main.js` 一起提交，插件市场安装时直接使用它。

- `npm run test:ui` 在独立的 Chromium 测试环境中验证设置面板。可用 `PW_HOST=/path/to/Forsion-Genesis/desktop/package.json` 指定已安装 `playwright-core` 的项目。运行前需安装 Playwright 的 Chromium。
- `DESKTOP_DIR=/path/to/Forsion-Genesis/desktop npm run test:host` 使用实际构建的 Forsion Electron 桌面端，检查笔记输入、重启后的配置和设置面板截图。先构建插件和 Genesis 桌面端，确保 Electron 主进程、preload 及前端构建产物齐全。测试使用隔离的临时用户目录和笔记库。可用 `OUT_DIR` 指定截图和结果输出目录，或设置 `KEEP_STATE=1` 保留临时状态以便排查。

默认片段、变量和符号表源自 [Obsidian LaTeX Suite](https://github.com/artisticat1/obsidian-latex-suite)。上游 MIT 许可见 [LICENSE-upstream.md](LICENSE-upstream.md)。
