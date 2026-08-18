// 编辑器命令:一组 `(view) => boolean` 的纯函数,不依赖宿主命令面板 —— 谁想接就接
// (命令面板、快捷键、设置页按钮都行)。返回 false = 当前光标位置轮不到我,调用方该放行。
//
// 对应上游 features/editor_commands.ts 的前两条(box / select)。上游其余几条是「开关全部功能」
// 之类的设置操作,那属于设置层不属于编辑器,不在这里。
// 新增的两条(插入行内 / 块级公式)是 Amadeus 侧的补充:Obsidian 用户靠 `mk`/`dm` 片段起手,
// 但片段要先落进公式模式才好用,得有个不靠片段的入口。

import type { EditorView } from 'prosemirror-view'
import { blockTextAt, inInlineCode, isCodeBlock, replaceInBlock } from '../editor/text'
import { hasInlineAtom, mathCursorAt, setSelectionInBlock } from './shared'

const BOXED = '\\boxed{'

/** 把光标所在公式的正文包进 `\boxed{}`。 */
export function boxCurrentEquation(view: EditorView): boolean {
  if (view.composing) return false
  const m = mathCursorAt(view.state)
  // 未闭合的公式(`$x` 还没打收尾的 `$`)没有确定的正文范围 —— innerTo 就是光标,
  // 包起来只会把光标后面的字挡在盒子外面,不如不动。
  if (!m || !m.closed) return false

  const inner = m.bt.text.slice(m.innerFrom, m.innerTo)
  if (inner.trim().length === 0) return false
  // 公式里夹着行内原子(图片、双链芯片)时放弃:这一步是「读出正文再整段插回去」,
  // 插回去的只是占位符字符,原子节点会被抹掉(见 shared.hasInlineAtom)。
  if (hasInlineAtom(m.bt, m.innerFrom, m.innerTo)) return false

  // 上游在块公式里还会前后补换行(`\n\boxed{…}\n`)。这里不补:一个 textblock 里塞 `\n`
  // 会让 mathMode 的扫描在换行处停住,这条公式从此在插件眼里不再是公式(见 enterBlockMath 注释)。
  view.dispatch(
    replaceInBlock(view.state, m.bt, m.innerFrom, m.innerTo, `${BOXED}${inner}}`, m.pos + BOXED.length).scrollIntoView(),
  )
  return true
}

/** 选中光标所在公式的正文(不含 `$` 定界符)。 */
export function selectCurrentEquation(view: EditorView): boolean {
  if (view.composing) return false
  const m = mathCursorAt(view.state)
  if (!m || !m.closed) return false

  // 上游把正文首尾的换行排除在选区外。单 textblock 里没有换行,但 `$$ x $$` 的首尾空格是同一回事:
  // 用户要的是「那条式子」,不是它两边的排版空白。
  let from = m.innerFrom
  let to = m.innerTo
  while (from < to && /\s/.test(m.bt.text[from])) from++
  while (to > from && /\s/.test(m.bt.text[to - 1])) to--
  if (from === to) return false

  setSelectionInBlock(view, m.bt, from, to)
  return true
}

/** 插入行内公式 `$…$`,光标落在中间;有选区就把选区包进去。 */
export function enterInlineMath(view: EditorView): boolean {
  return insertMath(view, '$', '$')
}

/** 插入块级公式,光标落在中间;有选区就把选区包进去。
 *
 *  ⚠️**与任务书写的 `$$\n\n$$` 不同,这里插入的是单行的 `$$  $$`。** 不是偷懒,是那个形态在
 *  Amadeus 里当场就是坏的:地基 mathMode 的 `openMathAt` 一遇到 `\n` 就返回 null,而片段引擎判
 *  「在不在公式里」用的是「光标前的文本 + 刚打的字」这半截串(见 editor/expand.ts 的 line),
 *  永远看不到收尾的 `$$` —— 也就是说 `$$\n…` 里**任何片段都不会触发**,用户会拿到一个
 *  写不了片段的死公式。单行 `$$  $$` 则一路可用(scanMath 认它是 display,openMathAt 也认)。
 *  Amadeus 的多行块公式本来就是另一个 textblock,不是一次纯文本插入能造出来的。 */
export function enterBlockMath(view: EditorView): boolean {
  return insertMath(view, '$$ ', ' $$')
}

function insertMath(view: EditorView, open: string, close: string): boolean {
  if (view.composing) return false
  const bt = blockTextAt(view.state)
  if (!bt) return false
  if (isCodeBlock(bt.node)) return false // 代码块里 `$` 就是字面量
  if (inInlineCode(bt.text, bt.from)) return false // 行内代码同理:`` `$x$` `` 是要展示这几个字符
  // 已经在公式里就别再套一层:`$x$` 中间插 `$…$` 会把定界符插花,那条公式当场作废。
  if (mathCursorAt(view.state)) return false
  // 选区里有行内原子(图片、双链芯片)→ 放弃。下面把选区文本原样重插,
  // 原子会变成一串字面占位符(见 shared.hasInlineAtom)。
  if (hasInlineAtom(bt, bt.from, bt.to)) return false

  const selected = bt.text.slice(bt.from, bt.to)
  const insert = `${open}${selected}${close}`
  // 有选区 → 光标停在选区末尾(定界符外侧再打字会跑出公式);没选区 → 停在正中间。
  const caret = bt.from + open.length + selected.length
  view.dispatch(replaceInBlock(view.state, bt, bt.from, bt.to, insert, caret).scrollIntoView())
  return true
}

export interface EditorCommand {
  id: string
  titleZh: string
  titleEn: string
  run(view: EditorView): boolean
}

export const EDITOR_COMMANDS: EditorCommand[] = [
  { id: 'latex-suite-box-equation', titleZh: '给当前公式加框', titleEn: 'Box current equation', run: boxCurrentEquation },
  { id: 'latex-suite-select-equation', titleZh: '选中当前公式', titleEn: 'Select current equation', run: selectCurrentEquation },
  { id: 'latex-suite-insert-inline-math', titleZh: '插入行内公式', titleEn: 'Insert inline math', run: enterInlineMath },
  { id: 'latex-suite-insert-block-math', titleZh: '插入块级公式', titleEn: 'Insert block math', run: enterBlockMath },
]
