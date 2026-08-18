// 自动放大括号:公式里出现 `\sum` `\int` `\frac` 这类「长」结构时,把包住它的那对括号换成
// `\left( … \right)`,让括号跟着内容长高。
//
// 对应上游 features/auto_enlarge_brackets.ts。上游靠 mathjax 语法树拿配对括号,这里用自己的
// 分词器 + 一个栈 —— 公式在 Amadeus 里就是纯文本,没有树可问。判定条件逐条对齐上游:
// 跳过 `{}`(它是 LaTeX 的分组,不是显示出来的括号)、跳过已经被尺寸命令管着的括号、
// 内容里没有触发词就不动。
//
// 由片段引擎在展开出含触发词的片段后回调(EngineSettings.autoEnlargeBrackets),所以要能在
// **公式还没闭合**时工作 —— 用 ctx.span 而不是 closed span。

import type { EditorView } from 'prosemirror-view'
import type { Transaction } from 'prosemirror-state'
import { textSelectionAt } from '../editor/text'
import type { Token } from './shared'
import { mathCursorAt, tokenize } from './shared'

/** 与上游 `autoEnlargeBracketsTriggers` 默认值一致(设置里也是这几个**裸词**)。
 *  ⚠️引擎的 EngineSettings 也有同一份名单,接线时请从这里取,别两头各写一份 ——
 *  分叉了就会出现「展开了却不放大」。 */
export const DEFAULT_ENLARGE_TRIGGERS = ['sum', 'int', 'frac', 'prod', 'bigcup', 'bigcap']

/** 触发词归一化:纯裸词要补上反斜杠再拿去比对。
 *
 *  ⚠️不补的话 `int` 会命中散文里的 `point`、`sum` 会命中 `consumer` —— `(\text{point taken})`
 *  会被莫名其妙放大成 `\left( … \right)`。上游在设置解析处就补了(`\sum`),这里补在使用点,
 *  因为引擎那份名单是用来做「要不要回调」的粗筛(裸词更宽松,只会多调不会漏调),精确判定在这儿。
 *
 *  与上游的差:上游对已经写了 `\sum` 的用户会再补一个反斜杠(`\\sum`,匹配不上任何东西)——
 *  那是上游的 bug,这里按「已经以 `\` 开头就不动」处理。 */
function normalizeTriggers(triggers: string[]): string[] {
  const out: string[] = []
  for (const raw of triggers) {
    const t = raw.trim()
    if (!t) continue
    out.push(/[A-Za-z]/.test(t) && !t.startsWith('\\') ? `\\${t}` : t)
  }
  return out
}

/** 左右括号对照表。`{` 只用来跟踪嵌套层级,永远不放大(它不显示)。 */
const PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '\\{': '\\}',
  '\\lbrace': '\\rbrace',
  '\\lbrack': '\\rbrack',
  '\\langle': '\\rangle',
  '\\lvert': '\\rvert',
  '\\lVert': '\\rVert',
  '\\lfloor': '\\rfloor',
  '\\lceil': '\\rceil',
  '\\ulcorner': '\\urcorner',
}

/** 已经在管括号大小的命令。它后面那个括号别再套一层 `\left`,否则会得到 `\left\left(`。
 *  这也是本函数的幂等保证:放大过一次之后 `(` 前面就是 `\left`,再跑不会重复加。 */
const SIZE_CONTROLS = new Set([
  '\\big', '\\Big', '\\bigg', '\\Bigg',
  '\\bigl', '\\Bigl', '\\biggl', '\\Biggl',
  '\\bigr', '\\Bigr', '\\biggr', '\\Biggr',
  '\\left', '\\right',
])

export interface EnlargeOptions {
  /** 裸词即可(`sum`),反斜杠由 normalizeTriggers 补 —— 接线层把设置原样切开递进来就行。 */
  triggers?: string[]
  /** `\left(` 与内容之间加一个空格(上游 `autoEnlargeBracketsSpace`,默认开)。 */
  space?: boolean
}

interface Edit {
  /** textblock 文本坐标。 */
  from: number
  to: number
  text: string
}

export function autoEnlargeBrackets(view: EditorView, opts: EnlargeOptions = {}): void {
  if (view.composing) return
  const m = mathCursorAt(view.state)
  if (!m) return

  const triggers = normalizeTriggers(opts.triggers ?? DEFAULT_ENLARGE_TRIGGERS)
  if (triggers.length === 0) return
  const space = opts.space === false ? '' : ' '
  // ⚠️公式还没闭合时 ctx.span 的 innerTo **就是光标**,只扫到那儿等于永远看不见右括号 ——
  // 而右括号总在光标后面(片段刚展开出 `(\sum_i x|)`),括号配对会一个都配不上。
  // 所以往后扫;但只能扫到下一个 `$` 为止:那个 `$` 是 scanMath 拒收的杂散符号(真能配对的话
  // m.closed 就不是 null 了),拿它当保守边界正好 —— 一路扫到块尾会把公式**后面的散文**
  // 里的括号也放大掉(`$(\sum a` 后面跟着一句「(见 \int 附注)」就中招)。
  const stray = m.bt.text.indexOf('$', m.pos)
  const scanEnd = m.closed ? m.innerTo : stray === -1 ? m.bt.text.length : stray
  const inner = m.bt.text.slice(m.innerFrom, scanEnd)
  const tokens = tokenize(inner)

  const edits: Edit[] = []
  const stack: Array<{ token: Token; index: number }> = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (PAIRS[t.text]) {
      stack.push({ token: t, index: i })
      continue
    }
    const top = stack[stack.length - 1]
    // 对不上的右括号(`(a]`)直接忽略:公式本身是残的,这时候乱配对只会改错地方。
    if (!top || PAIRS[top.token.text] !== t.text) continue
    stack.pop()

    if (top.token.text === '{') continue // 分组括号不显示,放大它等于凭空多出一对括号
    if (isSizeControlled(tokens, top.index) || isSizeControlled(tokens, i)) continue

    const content = inner.slice(top.token.end, t.start)
    if (!triggers.some((w) => content.includes(w))) continue

    edits.push({
      from: m.innerFrom + top.token.start,
      to: m.innerFrom + top.token.end,
      text: `\\left${top.token.text}${space}`,
    })
    edits.push({
      from: m.innerFrom + t.start,
      to: m.innerFrom + t.end,
      text: `${space}\\right${t.text}`,
    })
  }

  if (edits.length === 0) return

  // 从右往左改:每一笔的坐标都是在**原文**上算的,先改右边,左边的坐标才还作数。
  // 嵌套的括号对也安全 —— 所有被改的范围两两不相交。
  edits.sort((a, b) => b.from - a.from)
  const tr: Transaction = view.state.tr
  for (const e of edits) {
    tr.replaceWith(m.bt.base + e.from, m.bt.base + e.to, view.state.schema.text(e.text))
  }

  // 光标自己算,不指望 ProseMirror 的默认映射:光标正好停在某个括号上时(`\sum_i x|)`),
  // 默认偏置会把它推到 `\right)` 后面,用户下一个字就打到公式外面去了。
  let caret = m.pos
  for (const e of edits) {
    if (e.to <= m.pos) caret += e.text.length - (e.to - e.from)
  }
  const pos = Math.max(0, Math.min(tr.doc.content.size, m.bt.base + caret))
  view.dispatch(tr.setSelection(textSelectionAt(tr.doc, pos)))
}

/** 这个括号前面是不是跟着尺寸命令(`\left(`、`\bigl[`)。 */
function isSizeControlled(tokens: Token[], index: number): boolean {
  const prev = tokens[index - 1]
  return prev ? SIZE_CONTROLS.has(prev.text) : false
}
