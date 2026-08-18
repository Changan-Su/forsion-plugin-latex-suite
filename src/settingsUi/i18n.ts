// 设置面板的中英文案表。
//
// 为什么是一张表而不是散在各处的三元表达式:这一屏有 30+ 条说明,散着写的话「改了中文忘了英文」
// 是必然事件。表里一条就是一对,漏了一半 TS 当场报错(元组长度固定)。
//
// 文案取向:上游的说明是写给「已经在用 Obsidian latex-suite 的人」的,这里改写成不预设前置知识 ——
// 每条都先说**看得见的效果**,再说参数怎么填。

type Pair = readonly [zh: string, en: string]

const STRINGS = {
  // ── 标签页
  'tab.snippets': ['片段', 'Snippets'],
  'tab.autofraction': ['自动分式', 'Auto-fraction'],
  'tab.tabout': ['Tabout', 'Tabout'],
  'tab.matrix': ['矩阵', 'Matrix'],
  'tab.brackets': ['括号', 'Brackets'],
  'tab.display': ['显示', 'Display'],
  'tab.advanced': ['高级', 'Advanced'],

  // ── 片段
  'snippets.enabled.label': ['启用片段', 'Enable snippets'],
  'snippets.enabled.desc': [
    '关掉后所有触发串都不再展开,其余功能不受影响。',
    'Turn off to stop all snippet expansion. Other features keep working.',
  ],
  'snippets.trigger.label': ['触发键', 'Trigger key'],
  'snippets.trigger.desc': [
    '手动片段(选项里没写 A 的那些)按哪个键展开。自动片段不受影响 —— 它们打完就展开。',
    'Which key expands manual snippets (those without the `A` option). Automatic snippets are unaffected.',
  ],
  'snippets.trigger.tab': ['Tab 键', 'Tab'],
  'snippets.trigger.space': ['空格键', 'Space'],
  'snippets.source.label': ['片段库来源', 'Snippet library source'],
  'snippets.source.desc': [
    '用下面的正文,或从库里的某个文件 / 整个文件夹加载。选文件或文件夹时,下面的正文只作备份留着不用。',
    'Use the text below, or load from a file / folder in your vault. The text below is kept but unused when loading externally.',
  ],
  'snippets.source.user': ['插件内正文', 'Built-in editor'],
  'snippets.source.file': ['单个文件', 'Single file'],
  'snippets.source.folder': ['整个文件夹', 'Folder'],
  'snippets.file.label': ['片段文件', 'Snippet file'],
  'snippets.file.desc': [
    '相对库根的路径,例如 LaTeX/snippets.js。文件改动会自动重新加载。',
    'Path relative to the vault root, e.g. LaTeX/snippets.js. Reloaded automatically when the file changes.',
  ],
  'snippets.folder.label': ['片段文件夹', 'Snippet folder'],
  'snippets.folder.desc': [
    '文件夹里的每个文件都会被当成一份片段库加载,便于按主题拆分。',
    'Every file in the folder is loaded as its own snippet library — handy for splitting by topic.',
  ],
  'snippets.editor.label': ['片段库', 'Snippet library'],
  'snippets.editor.desc': [
    '一个 JS 数组,每条形如 {trigger: "@a", replacement: "\\\\alpha", options: "mA"}。反斜杠要写两遍,行首 // 是注释。改动会在停手 0.3 秒后保存。',
    'A JS array; each entry looks like {trigger: "@a", replacement: "\\\\alpha", options: "mA"}. Escape backslashes twice; lines starting with // are comments. Saved 0.3s after you stop typing.',
  ],
  'snippets.saved': ['已保存', 'Saved'],
  'snippets.invalid': ['语法有误,未保存', 'Invalid syntax — not saved'],
  'snippets.reset': ['恢复默认', 'Reset to defaults'],
  'snippets.resetConfirm': ['再点一次确认(自定义片段会丢)', 'Click again to confirm — custom snippets will be lost'],
  'snippets.clear': ['清空', 'Clear all'],
  'snippets.clearConfirm': ['再点一次确认清空', 'Click again to confirm'],
  'snippets.problems': ['片段库有问题', 'Problems in the snippet library'],
  'snippets.externalHint': [
    '当前从外部文件加载,下面的正文不生效。',
    'Currently loading from an external source; the text below is not in use.',
  ],

  // ── 自动分式
  'af.enabled.label': ['启用自动分式', 'Enable auto-fraction'],
  'af.enabled.desc': [
    '在公式里打 a/b,松手就变成 \\frac{a}{b},不用自己数花括号。',
    'Type a/b inside math and it becomes \\frac{a}{b} — no bracket counting.',
  ],
  'af.symbol.label': ['分式命令', 'Fraction command'],
  'af.symbol.desc': ['替换时用哪个命令,如 \\frac、\\dfrac、\\tfrac。', 'Which command to use: \\frac, \\dfrac, \\tfrac.'],
  'af.breaking.label': ['断字符', 'Breaking characters'],
  'af.breaking.desc': [
    '决定分子从哪儿开始。含 + 时 a+b/c 展开成 a+\\frac{b}{c};不含则整体成 \\frac{a+b}{c}。',
    'Decides where the numerator starts. With + included, a+b/c becomes a+\\frac{b}{c}; without it, \\frac{a+b}{c}.',
  ],
  'af.excluded.label': ['排除环境', 'Excluded environments'],
  'af.excluded.desc': [
    'JSON 数组,每项是 [开始, 结束] 一对。例如 ["^{", "}"] 表示指数里不跑自动分式。',
    'A JSON array of [open, close] pairs. e.g. ["^{", "}"] keeps auto-fraction out of exponents.',
  ],

  // ── Tabout
  'tabout.enabled.label': ['启用 Tabout', 'Enable tabout'],
  'tabout.enabled.desc': [
    '按 Tab 直接跳到右括号外面,不用把光标一格格挪出去。',
    'Press Tab to jump past the closing bracket instead of arrowing out.',
  ],
  'tabout.eol.label': ['仅在行尾跳出公式', 'Exit equation only at end of line'],
  'tabout.eol.desc': [
    '开:只有光标在行尾时 Tab 才跳出整个公式;关:公式里任何位置按 Tab 都跳出去。',
    'On: Tab leaves the equation only at end of line. Off: Tab leaves it from anywhere inside.',
  ],
  'tabout.symbols.label': ['闭合符号', 'Closing symbols'],
  'tabout.symbols.desc': ['逗号分隔;Tab 会跳过这些符号。', 'Comma-separated; Tab jumps over these.'],

  // ── 矩阵
  'matrix.enabled.label': ['启用矩阵快捷键', 'Enable matrix shortcuts'],
  'matrix.enabled.desc': [
    '在矩阵类环境里,Tab = 下一列(插入 &),回车 = 下一行(插入 \\\\)。',
    'Inside matrix environments: Tab moves to the next column (&), Enter to the next row (\\\\).',
  ],
  'matrix.envs.label': ['环境名', 'Environments'],
  'matrix.envs.desc': [
    '逗号分隔;在这些 \\begin{…} 里启用矩阵快捷键。',
    'Comma-separated; matrix shortcuts run inside these \\begin{…} blocks.',
  ],
  'matrix.macros.label': ['宏名', 'Macros'],
  'matrix.macros.desc': ['逗号分隔;这些宏的花括号里同样启用。', 'Comma-separated; also enabled inside these macros.'],

  // ── 括号
  'brk.enlarge.label': ['自动放大括号', 'Auto-enlarge brackets'],
  'brk.enlarge.desc': [
    '括号里出现 \\sum、\\int、\\frac 时,自动换成 \\left( … \\right),括号跟着内容长高。',
    'When a bracket contains \\sum, \\int or \\frac, switch it to \\left( … \\right) so it grows with the content.',
  ],
  'brk.triggers.label': ['触发命令', 'Triggers'],
  'brk.triggers.desc': ['逗号分隔,不用写反斜杠。', 'Comma-separated, without the leading backslash.'],
  'brk.space.label': ['两侧加空格', 'Add spaces'],
  'brk.space.desc': ['\\left( 之后与 \\right) 之前各加一个空格。', 'Insert a space after \\left( and before \\right).'],

  // ── 显示
  'disp.conceal.label': ['隐藏 LaTeX 语法', 'Conceal LaTeX syntax'],
  'disp.conceal.desc': [
    '把 \\dot{x}^{2} 直接显示成 ẋ²,光标走到哪儿哪儿还原成源码。默认关着,用熟了再开会很舒服。',
    'Renders \\dot{x}^{2} as ẋ² and reveals the source under the cursor. Off by default; worth turning on once you are used to the plugin.',
  ],
  'disp.concealDelay.label': ['还原延迟(毫秒)', 'Reveal delay (ms)'],
  'disp.concealDelay.desc': [
    '光标移到公式上多久后才还原成源码。填 300 之类的正数,方向键穿过公式时不会一路闪。整数 ≥ 0。',
    'How long to wait before revealing source under the cursor. A positive value like 300 stops the flicker when arrowing through equations. Integer ≥ 0.',
  ],
  'disp.preview.label': ['公式弹出预览', 'Math popup preview'],
  'disp.preview.desc': [
    '光标在公式里时,在旁边弹一个渲染结果,不用切到预览模式。',
    'Shows a rendered preview next to the equation while the cursor is inside it.',
  ],
  'disp.highlight.label': ['高亮配对括号', 'Highlight matching bracket'],
  'disp.highlight.desc': [
    '光标贴着一个括号时,把和它配对的那一个也标出来。',
    'When the cursor sits next to a bracket, highlight its partner.',
  ],
  'disp.color.label': ['括号按层级着色', 'Color paired brackets'],
  'disp.color.desc': ['嵌套的括号按深度给不同颜色,一眼看出层级。', 'Nested brackets get different colors per depth.'],

  // ── 高级
  'adv.variables.label': ['片段变量', 'Snippet variables'],
  'adv.variables.desc': [
    'JSON 对象。在触发串里写 ${GREEK} 就会展开成对应的一长串正则分支,省得每个希腊字母写一条。',
    'A JSON object. Write ${GREEK} in a trigger and it expands to the matching regex alternation — one snippet instead of thirty.',
  ],
  'adv.varFromFile.label': ['从文件加载片段变量', 'Load snippet variables from file'],
  'adv.varFromFile.desc': ['开启后忽略上面的正文,改从下面的路径读。', 'Ignores the text above and reads the path below instead.'],
  'adv.varFile.label': ['片段变量文件', 'Snippet variables file'],
  'adv.varFile.desc': ['相对库根的路径,也可以填文件夹。', 'Path relative to the vault root; a folder works too.'],
  'adv.wordDelimiters.label': ['词分隔符', 'Word delimiters'],
  'adv.wordDelimiters.desc': [
    '带 w 选项的片段用它判断词边界。这里的 \\n 是**两个字符**的字面量,代表换行。',
    'Used by snippets with the `w` option to find word boundaries. Note \\n here is the two-character literal, meaning newline.',
  ],
  'adv.trimWhitespace.label': ['去掉行内公式的尾随空格', 'Trim trailing whitespace in inline math'],
  'adv.trimWhitespace.desc': [
    '在 $…$ 末尾展开片段时,去掉替换文本尾部的空格,免得 $ 前面多一格。',
    'Removes trailing spaces when a snippet expands at the end of inline math, so no gap is left before the closing $.',
  ],
  'adv.recursion.label': ['片段递归次数', 'Snippet recursion'],
  'adv.recursion.desc': [
    '展开一次后,再拿展开出来的新文本试着触发别的片段,最多几轮。0 = 不递归。',
    'How many extra rounds to re-run snippets on freshly expanded text. 0 disables recursion.',
  ],
} satisfies Record<string, Pair>

export type StringKey = keyof typeof STRINGS
export type Translate = (key: StringKey) => string

export function createT(locale: 'zh' | 'en'): Translate {
  const i = locale === 'zh' ? 0 : 1
  return (key) => STRINGS[key][i]
}
