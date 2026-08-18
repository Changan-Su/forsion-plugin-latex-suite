# LaTeX 套件 / LaTeX Suite for Forsion

把敲 LaTeX 公式变得和手写一样快。移植自 Obsidian 的
[obsidian-latex-suite](https://github.com/artisticat1/obsidian-latex-suite)(MIT, artisticat1)。

## 这不是"抄文件",是重实现

上游整个长在 **CodeMirror 6** 上(52 个源文件里 33 个死绑 CM6 或 Obsidian API),
而 Amadeus 的编辑器是 **Milkdown / ProseMirror**。所以:

- **纯逻辑与数据原样搬**:默认片段表、片段变量、conceal 符号表、选项标志语义、优先级排序。
  用户写的片段格式与上游**逐字兼容** —— 从 Obsidian 那边把 `snippets.js` 整份贴过来就能用。
- **编辑器那一层全部重写**:tabstop 状态机、按键拦截、装饰渲染,照 ProseMirror 的方式重来。
- **"我在不在公式里"不用语法树**:Amadeus 的公式本来就是纯文本 `$…$`,扫一遍字符串就是精确答案,
  而且与宿主自己的公式渲染(mathLivePreview 的 scanMath)**用同一套规则** —— 两处口径必须一致,
  否则会出现"片段以为在公式里、渲染却不认"。上游那 750 行的 `context.ts` 在这里塌成几十行。

## 功能

| | |
|---|---|
| **片段展开** | 公式里打 `@a` → `\alpha`、`//` → 分式、`sr` → 平方。默认表 200 余条,可整份替换 |
| **占位跳转** | 展开后 Tab 在 `\frac{}{}`、`\begin{}\end{}` 的空位间跳;Shift-Tab 回退;Esc 退出 |
| **占位联动** | 同名占位点自动镜像:`\begin{$0}…\end{$0}` 改一处环境名,两头一起变 |
| **Tabout** | 公式里 Tab 跳出括号,再按跳出 `$` |
| **自动分式** | 打 `/` 把前一项变成 `\frac{}{}`;`(a+b)/` 会把整个括号吃进分子 |
| **矩阵快捷** | matrix / cases / align 里 Tab 分列、回车换行 |
| **自动放大括号** | 出现 `\sum` 之类的高结构时把括号换成 `\left( \right)` |
| **实时符号(conceal)** | 光标不在那一段时 `\alpha` 显示成 α、上下标缩上去;光标一进就露出源码 |
| **公式命令** | 命令面板:框住当前公式 / 选中当前公式 / 插入行内或块级公式 |
| **设置界面** | 自绘面板 + 内嵌代码编辑器改片段库;也可以把片段放库里的文件/文件夹,存盘即热重载 |

## 磁盘上什么都没变

公式始终是标准 markdown 的 `$…$` / `$$…$$`。本插件**零 schema 改动、零序列化改动** ——
只做三件事:纯文本改动、装饰(Decoration)、按键拦截。卸载插件,你的笔记一个字都不会变。

## Tab 键的四重身份

按这个顺序试,前一个不接才轮到后一个;四个都不接就把 Tab **原样还给笔记**(列表缩进照常):

1. 有占位点 → 跳下一个占位点
2. 手动片段(没有 `A` 标志的)→ 展开
3. 在矩阵环境里 → 插入 `&`
4. 在公式里 → 跳出最近一层括号 / 跳出 `$`

## 写自己的片段

设置 → LaTeX 套件 → 片段。格式与上游一致:

```js
[
  {trigger: "@a", replacement: "\\alpha", options: "mA"},
  {trigger: "//", replacement: "\\frac{$0}{$1}$2", options: "mA"},
  {trigger: /([A-Za-z])(\d)/, replacement: "[[0]]_{[[1]]}", options: "mA"},
  {trigger: "U", replacement: "\\underbrace{${VISUAL}}", options: "mAv"},
]
```

- **options 标志**:`m` 行内+块级数学 / `n` 只行内 / `M` 只块级 / `t` 正文 / `c` 代码块 /
  `A` 自动展开(不带则按 Tab 展开) / `r` 正则 / `w` 要求词边界 / `v` 作用于选区 / `U` 不作为独立撤销点
- **`$0` 是第一个占位点**(不是 LSP 那套"最终光标"),`${0:默认值}` 带默认文本
- **`[[0]]` 是正则捕获组**,与占位点 `$0` 刻意用不同语法,不会打架
- **`${VISUAL}`** 在 `v` 片段里代表当前选区
- 片段变量:`${GREEK}` / `${SYMBOL}` / `${MORE_SYMBOLS}` / `${ACCENT}` 可直接写进正则 trigger

片段库也可以放在笔记库里(设置 → 来源 → 文件 / 文件夹),用你惯用的编辑器维护,**存盘即热重载**。

## 与上游的已知差异

诚实列出来,不粉饰。

**结构性的(改不了,或者改了代价更大)**

- **占位点用镜像而不是多光标**。ProseMirror 没有多选区,所以同名占位点里只有一个真光标,
  它的文本在每次事务后同步到同组其它位点。用户看到的效果一样(甚至更稳:不会出现另一个光标飘走)。
- **作用域是当前段落,不支持多行块公式**。跨段落的 `$$…$$` 不识别 —— 宿主自己的公式渲染也不识别,
  这里刻意不做得更强。连带:tabout 的换行分支、矩阵的多行分支、「框住公式」的前后补空行都只有单行版。
- **conceal 用扫描器,不是 LaTeX 语法树**。常见的命令符号 / 上下标 / 分式 / 字体 / 重音 / 括号都覆盖;
  上下标走 Unicode 映射,映不全就保留源码(上游会渲染成真 `<sup>`/`<sub>`)。
- **conceal 的 reveal 粒度是整段公式**,不是上游的单个构造:光标进 `$…$` 整段回源码,
  编辑当前这段时看不到 conceal。ProseMirror 没有 CM 的 `atomicRanges`,按构造 reveal 会让方向键走进隐形字符。
- **没有 vim 集成**。Amadeus 没有 vim 模式,没有可对接的对象。

**刻意不做的**

- 上游的 `mousedown → 全部 conceal`(拖选时不抖)与 `revealTimeout`(边界延迟):
  整段粒度下拖选只抖一次、也不存在「边界」这个中间态;而 mousedown 那套要在 window 上挂 mouseup,
  鼠标在编辑器外松开就漏事件 → conceal 卡在永远藏着 → 公式没法编辑,比它治的痒贵得多。
- 上游的 Shift-Enter 退出矩阵环境。
- 自动分式展开后不留占位点(上游留两个)。这里按 Tab 会走 tabout 跳出括号,体验近似但不等价。

**已知的视觉冗余(两个功能各自正确的叠加)**

宿主会给光标所在行的**每一段**公式挂一枚浮层 KaTeX 预览(不只光标那段),所以同一行里
没被光标碰到的公式会同时出现「conceal 出来的 α」和上方的 KaTeX 气泡。消掉它等于让 conceal 在活动行罢工。

## 开发

```bash
npm i
npm run verify     # typecheck + 单测 + 打包 + 宿主等价冒烟
```

- `npm run check` 用**和宿主一模一样的方式**装载产物(`new Function('ctx', code)`)。
  这条链上每一段都栽过人:产物混进 import/export、忘了返回 disposer、用到宿主没有的 API 却没走可选链。
  绿了才算能装。
- `main.js` 是构建产物但**必须提交**(市场装 zip 不构建),改 `src/` 后务必 `npm run build`。

## 许可

MIT。默认片段表、片段变量、conceal 符号表逐条取自
[obsidian-latex-suite](https://github.com/artisticat1/obsidian-latex-suite)(MIT © 2022 artisticat1),
上游许可证全文见 `LICENSE-upstream.md`。conceal 符号表本身再上溯到 vimtex 与 MathJax(见 `src/conceal/maps.ts` 文件头)。
