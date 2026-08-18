// 设置面板样式。一整份字符串,由 mountSettings 幂等注入(见 index.ts 的 ensureCss)。
//
// ⚠️宿主的 CSS 变量词表(实测 Forsion-Genesis/desktop/frontend/src/styles/base.css):
//   --text / --text-muted / --text-faint / --bg / --bg-card / --bg-input / --border / --overlay-* /
//   --accent / --accent-ink / --accent-light / --sel-line / --sel-fill / --danger / --radius-* / --font-mono
// **没有** --text-normal / --background-secondary / --interactive-accent(那是 Obsidian 的词表)。
// 所以这里先落一层自己的 --ls-*,fallback 链是「宿主真词表 → Obsidian 词表 → 中性灰派生」:
// 换宿主、换皮肤、甚至挂进一个什么变量都没有的容器,都还能看。
//
// ⚠️别用 --accent-light 当「所有淡色」的通用解:实测它是 `rgba(28,28,28,0.05)`(**5%**),
// 宿主拿它专做选中态底色。拿它画焦点环 / 代码框选区 / 配对括号高亮,结果是**肉眼看不见**。
// 所以这里按用途分三个强度,各司其职,别再合并回一个:
//   --ls-sel-fill  选中态底色(5% 级,只做背景)
//   --ls-sel-line  选中/焦点的线(14~36%,宿主 --sel-line 正典)
//   --ls-select-bg 文本选区、配对括号(14% 中性,不带 accent 色相 —— 默认 accent 是近黑/近白,
//                  染上去反而压住正文)
//
// ⚠️另一条正典(base.css 踩过):`color-mix()` 不被支持时,自定义属性照样「合法」,失效发生在
// **使用处** —— `border-color` 拿到 invalid-at-computed-value-time 就退成 `currentColor`(正文色的
// 刺眼描边),背景则整块消失。所以**兜底链的最后一环一律写成静态 rgba**,不留 color-mix 在末位。
//
// 唯一写死颜色的地方是**代码高亮的色相**(--ls-syn-*)与兜底 danger:语法高亮天然需要多个色相,
// 没法从单个 accent 派生。它分明暗两套,由 index.ts 实测容器文字亮度后加 .ls-dark 切换 ——
// 宿主主题不等于系统主题,prefers-color-scheme 在这里会猜错,所以不用媒体查询。

export const SETTINGS_CSS = `
/* ls-settings-css-v1 —— 哨兵串。主入口把这份 CSS 拼进它自己的 style 标签时,mountSettings 靠
   扫这一行认出「已经有人注入过了」,不再重复注入,也不去动别人的标签。改这行要同步 index.ts。 */
.ls-settings {
  /* 语义层:宿主词表优先,Obsidian 词表次之,最后用 currentColor 派生(永远可读)。 */
  --ls-text: var(--text, var(--text-normal, currentColor));
  --ls-muted: var(--text-muted, var(--text-faint, rgba(128, 128, 128, 0.92)));
  --ls-faint: var(--text-faint, rgba(128, 128, 128, 0.72));
  /* 描边:兜底不留 color-mix(见文件头正典)—— 退成 currentColor 是**反向劣化**,不是降级。 */
  --ls-border: var(--overlay-medium, var(--border, rgba(128, 128, 128, 0.28)));
  --ls-surface: var(--overlay-subtle, var(--background-secondary, rgba(128, 128, 128, 0.08)));
  --ls-surface-strong: var(--overlay-light, rgba(128, 128, 128, 0.14));
  --ls-accent: var(--accent-ink, var(--accent, var(--interactive-accent, currentColor)));
  --ls-sel-fill: var(--sel-fill, var(--accent-light, rgba(128, 128, 128, 0.12)));
  --ls-sel-line: var(--sel-line, var(--overlay-strong, rgba(128, 128, 128, 0.42)));
  --ls-select-bg: var(--overlay-strong, rgba(128, 128, 128, 0.24));
  --ls-field-bg: var(--bg-input, var(--bg-card, var(--background-primary, transparent)));
  --ls-danger: var(--danger, #c8503f);
  --ls-radius: var(--radius-sm, 8px);
  --ls-mono: var(--font-mono, ui-monospace, 'SF Mono', Menlo, monospace);

  /* 代码高亮色相(亮色)。 */
  --ls-syn-comment: #8a8f98;
  --ls-syn-string: #3f7f5f;
  --ls-syn-regexp: #a15c00;
  --ls-syn-number: #2f6f9f;
  --ls-syn-keyword: #7c4dbe;
  --ls-syn-property: #1f6feb;
  --ls-syn-function: #8250df;

  color: var(--ls-text);
  font-size: 13px;
  line-height: 1.5;
}
.ls-settings.ls-dark {
  --ls-syn-comment: #8b949e;
  --ls-syn-string: #86c99a;
  --ls-syn-regexp: #e3b341;
  --ls-syn-number: #79c0ff;
  --ls-syn-keyword: #d2a8ff;
  --ls-syn-property: #79c0ff;
  --ls-syn-function: #d2a8ff;
  --ls-danger: var(--danger, #e0736a);
}

/* ── 标签栏:换行而不是横向滚动。设置卡宽度随窗口变,七个标签在窄卡里必然溢出,
      横向滚动条会和宿主的滚动条策略打架(宿主全局禁自绘 ::-webkit-scrollbar)。 */
.ls-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--ls-border);
}
.ls-tab {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--ls-muted);
  font: inherit;
  font-size: 12px;
  padding: 4px 11px;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.14s, color 0.14s;
}
.ls-tab:hover { background: var(--ls-surface); color: var(--ls-text); }
/* 选中态照宿主正典:细线 --sel-line + 淡填充 --sel-fill。**不叠满强度 accent 的 box-shadow** ——
   单色配色下那是深色态近白、浅色态近黑的一道粗边。 */
.ls-tab.is-active {
  background: var(--ls-sel-fill);
  border-color: var(--ls-sel-line);
  color: var(--ls-accent);
  font-weight: 600;
}

.ls-pane { display: flex; flex-direction: column; gap: 2px; }
.ls-pane[hidden] { display: none; }

/* ── 一行 = 左说明 + 右控件。窄容器下折行,控件不被挤成一条缝。 */
.ls-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 0;
  border-bottom: 1px solid var(--ls-border);
  flex-wrap: wrap;
}
.ls-row:last-child { border-bottom: none; }
.ls-row[hidden] { display: none; }
.ls-row-main { flex: 1 1 260px; min-width: 0; }
.ls-row-label { font-size: 13px; color: var(--ls-text); }
.ls-row-desc { font-size: 11.5px; color: var(--ls-muted); margin-top: 2px; }
.ls-row-ctl { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding-top: 1px; }

/* ── 整块行(编辑器 / 大文本框):控件占满宽度,说明在上方。 */
.ls-block { padding: 10px 0; border-bottom: 1px solid var(--ls-border); }
.ls-block:last-child { border-bottom: none; }
.ls-block[hidden] { display: none; }
.ls-block-head { margin-bottom: 7px; }

.ls-input, .ls-select, .ls-textarea {
  background: var(--ls-field-bg);
  color: inherit;
  border: 1px solid var(--ls-border);
  border-radius: var(--ls-radius);
  padding: 4px 8px;
  font: inherit;
  font-size: 12px;
  min-width: 0;
}
.ls-input { width: 190px; }
.ls-input.ls-input--num { width: 82px; }
.ls-input.ls-input--mono, .ls-textarea { font-family: var(--ls-mono); font-size: 11.5px; }
.ls-textarea { display: block; width: 100%; min-height: 84px; resize: vertical; }
.ls-select { padding-right: 4px; cursor: pointer; }
/* 焦点环走 --ls-sel-line(14~36%)。曾经用的 --accent-light 是 5%,焦点在哪儿完全看不出来。 */
.ls-input:focus, .ls-select:focus, .ls-textarea:focus {
  outline: none;
  border-color: var(--ls-accent);
  box-shadow: 0 0 0 2px var(--ls-sel-line);
}
/* 非法输入(非负整数框)只标红不落盘 —— 用户清空重打的中间态不该把设置改成 0。 */
.ls-input[aria-invalid='true'] { border-color: var(--ls-danger); }
.ls-ctl { display: inline-flex; align-items: center; }

/* ── 开关:用 button[role=switch] 而不是 input[type=checkbox] —— 后者的原生外观由系统主题决定,
      宿主深色皮肤下会突然冒出一个亮色方块。 */
.ls-switch {
  appearance: none;
  position: relative;
  width: 36px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--ls-border);
  border-radius: 999px;
  background: var(--ls-surface-strong);
  cursor: pointer;
  transition: background 0.16s, border-color 0.16s;
}
.ls-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  /* 静态 rgba,不用 color-mix:不支持时背景整个消失 = 开关没有把手,比颜色不准严重得多。 */
  background: rgba(128, 128, 128, 0.75);
  transition: transform 0.16s, background 0.16s;
}
.ls-switch[aria-checked='true'] { background: var(--ls-accent); border-color: transparent; }
.ls-switch[aria-checked='true']::after { transform: translateX(16px); background: var(--ls-field-bg); }
.ls-switch:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--ls-sel-line); }

.ls-btn {
  appearance: none;
  border: 1px solid var(--ls-border);
  background: var(--ls-field-bg);
  color: var(--ls-muted);
  font: inherit;
  font-size: 11.5px;
  padding: 3px 10px;
  border-radius: var(--ls-radius);
  cursor: pointer;
  transition: background 0.14s, color 0.14s, border-color 0.14s;
}
.ls-btn:hover { background: var(--ls-surface); color: var(--ls-text); }
.ls-btn.is-armed { color: var(--ls-danger); border-color: var(--ls-danger); }

/* ── 片段库解析错误:显示在编辑器**上方**。放下方的话,长文本编辑器会把它挤出视野,
      用户改坏了片段却看不到原因。 */
.ls-errors {
  border: 1px solid var(--ls-danger);
  border-radius: var(--ls-radius);
  background: var(--danger-light, rgba(163, 80, 63, 0.08));
  padding: 7px 10px;
  margin-bottom: 8px;
  font-size: 11.5px;
}
.ls-errors[hidden] { display: none; }
.ls-errors-title { color: var(--ls-danger); font-weight: 600; margin-bottom: 3px; }
.ls-errors-item { color: var(--ls-text); font-family: var(--ls-mono); word-break: break-word; }
.ls-errors-item + .ls-errors-item { margin-top: 2px; }

.ls-note {
  font-size: 11.5px;
  color: var(--ls-muted);
  background: var(--ls-surface);
  border-radius: var(--ls-radius);
  padding: 6px 9px;
  margin-bottom: 8px;
}
.ls-note[hidden] { display: none; }

/* ── CodeMirror 宿主容器。高度封顶 + 内部滚动:片段库默认 200 条,不封顶的话整页被它撑爆。 */
.ls-cm {
  border: 1px solid var(--ls-border);
  border-radius: var(--ls-radius);
  overflow: hidden;
  background: var(--ls-field-bg);
}
.ls-cm .cm-editor { max-height: 340px; }
.ls-cm .cm-editor.cm-focused { outline: none; }
.ls-cm .cm-scroller { font-family: var(--ls-mono); font-size: 11.5px; line-height: 1.55; }
.ls-cm .cm-gutters {
  background: transparent;
  border-right: 1px solid var(--ls-border);
  color: var(--ls-faint);
}
.ls-cm .cm-activeLine { background: var(--ls-surface); }
.ls-cm .cm-activeLineGutter { background: var(--ls-surface); color: var(--ls-muted); }
.ls-cm .cm-cursor, .ls-cm .cm-dropCursor { border-left-color: var(--ls-text); }
/* 选区与配对括号用**中性**的 --overlay-strong,不掺 accent:默认 accent 是近黑(浅色态)/近白
   (深色态),染在正文底下会把字压没。CM6 自带的选区色是写死的灰,这里只是让它跟着皮肤走。 */
.ls-cm .cm-selectionBackground,
.ls-cm .cm-editor.cm-focused .cm-selectionBackground,
.ls-cm .cm-content ::selection { background: var(--ls-select-bg); }
.ls-cm .cm-matchingBracket, .ls-cm .cm-editor.cm-focused .cm-matchingBracket {
  background: var(--ls-select-bg);
  outline: 1px solid var(--ls-sel-line);
}
.ls-cm .cm-nonmatchingBracket { background: rgba(200, 80, 63, 0.24); }

.ls-cm-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 7px;
  flex-wrap: wrap;
}
.ls-cm-status { font-size: 11.5px; color: var(--ls-faint); transition: opacity 0.12s; }
.ls-cm-status.is-invalid { color: var(--ls-danger); }
/* 打字中:还没到落盘那一刻,状态先褪色,别让用户以为「已保存」是刚才那一下的结果。 */
.ls-cm-status.is-pending { opacity: 0.45; }
.ls-cm-actions { display: flex; gap: 6px; }
`
