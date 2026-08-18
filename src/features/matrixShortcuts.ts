// 矩阵快捷键:光标在 matrix / cases / align 这类环境里时,Tab 加一个单元格,Enter 换一行。
//
// 对应上游 features/matrix_shortcuts.ts。上游每个动作都有「多行 / 单行」两条分支 —— Amadeus 里
// 一个 textblock 装的公式天然是单行(跨行的 `$$` 块是另一个 textblock,见 editor/mathMode.ts),
// 所以这里**只保留单行分支**。这不是砍功能:`\\` 在 KaTeX 里本来就是行分隔符,不需要真的敲回车,
// 上游的单行分支 `replaceSelection(" \\\\  ")` 干的就是这件事。真敲进去一个 `\n` 反而会让
// mathMode 的扫描在换行处停下 —— 那条公式从此在插件眼里不是公式了。

import type { EditorView } from 'prosemirror-view'
import type { BlockText } from '../editor/text'
import { replaceInBlock } from '../editor/text'
import { innermostScope, mathCursorAt, setCursorInBlock } from './shared'
import { taboutByEnclosedBrackets } from './tabout'

/** 与上游 `matrixShortcutsEnvNames` 默认值一致。 */
export const DEFAULT_MATRIX_ENVS = [
  'pmatrix', 'cases', 'align', 'gather', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'array', 'matrix',
]

/** 与上游 `matrixShortcutsMacroNames` 默认值一致(上游就只有这一个)。 */
export const DEFAULT_MATRIX_MACROS = ['eqalign']

export interface MatrixOptions {
  /** 同样吃矩阵快捷键的**宏**参数(上游 `matrixShortcutsMacroNames`)。 */
  macros?: string[]
  /** 传给「先跳出括号」那一步的右定界符名单(上游用的是 `taboutClosingSymbols` 设置本身)。
   *  ⚠️不传就退回默认表 —— 那会让同一次 Tab 出现两套名单,接线层请把用户设置透传进来。 */
  closingSymbols?: string[]
}

export function matrixShortcut(
  view: EditorView,
  key: 'Tab' | 'Enter',
  envs: string[] = DEFAULT_MATRIX_ENVS,
  opts: MatrixOptions = {},
): boolean {
  if (view.composing) return false

  const m = mathCursorAt(view.state)
  if (!m) return false
  // strictlyInMath:`\text{}` 里的 Tab/Enter 归宿主管。
  if (m.ctx.mode.textEnv) return false

  // 只认**最内层**作用域,而且环境和宏都要看 —— 上游取的是语法树上离光标最近的那个节点:
  //   `align` 里嵌 `pmatrix` → 按 pmatrix 的规矩;
  //   `\begin{pmatrix} \frac{a|}{b}` → 最里层是宏 `frac`,不在宏名单里就**放行**,
  //   让 Tab 落到 tabout 去跳出分子 —— 只看环境栈的话会把 ` & ` 插进分数里。
  const scope = innermostScope(m.bt.text, m.innerFrom, m.pos)
  if (!scope) return false
  const allowed = scope.kind === 'env' ? envs : (opts.macros ?? DEFAULT_MATRIX_MACROS)
  if (!allowed.includes(scope.name)) return false

  if (key === 'Enter') {
    // 上游还会把行首的 `&` 数量复制到新行(`added_cells`)—— 那是为「另起一行」服务的缩进补偿,
    // 我们不另起行,复制过来只会凭空多出对齐符。
    return insertAt(view, m.bt, ' \\\\ ')
  }

  // Tab:上游把 priorityTaboutMatrixShortcut 排在插入 `&` **之前** —— 光标正被一对括号包着时
  // (`\begin{pmatrix} (a|b) & c`),Tab 的意思是「跳出这对括号」,不是「开新单元格」。
  // 这一步不能挪到外面靠 tabout 兜底:`}` 在 tabout 的默认右定界符名单里,完整 tabout 会把
  // `\begin{…}` 环境里的每一次 Tab 都劫走。
  const rel = taboutByEnclosedBrackets(m.bt.text.slice(m.pos, m.innerTo), opts.closingSymbols)
  if (rel !== null) {
    setCursorInBlock(view, m.bt, m.pos + rel)
    return true
  }

  if (m.bt.from !== m.bt.to) return false // 上游 addCell 要求空选区
  // 前后留空格是上游的写法:矩阵源码里 `a & b` 比 `a&b` 好读,渲染结果完全一样。
  return insertAt(view, m.bt, ' & ')
}

/** 替换掉选区(空选区 = 就地插入),光标落到插入内容之后。 */
function insertAt(view: EditorView, bt: BlockText, text: string): boolean {
  view.dispatch(replaceInBlock(view.state, bt, bt.from, bt.to, text, bt.from + text.length).scrollIntoView())
  return true
}
