// tabout:在公式里按 Tab,光标跳到最近一层右定界符的**外侧**;已经在最外层就跳出整条公式。
//
// 对应上游 features/tabout.ts。逻辑照抄(分词 → 找光标后第一个右定界符 → 跳),
// 与上游的差异只有两处,都是被 Amadeus 的作用域逼出来的:
//
// 1. **未闭合公式一律不接管 Tab**。上游有语法树,`$x` 还没打完也能拿到 bounds;这里
//    `mathContext` 对未闭合公式返回的 innerTo 就是光标本身 —— 拿它当「公式结尾」去跳,会跳到
//    公式外面的正文里。宁可放行给宿主(Tab 缩进列表),也不要跳到一个猜出来的位置。
// 2. **不处理多行块公式**。上游的多行分支(在 `$$` 后面造新行、trim 行尾空白)在 Amadeus 里
//    没有对应物:一个 textblock 内的公式天然是单行,跨行的 `$$` 块是另一个 textblock(见
//    editor/mathMode.ts 文件头)。所以只保留上游的单行分支:跳到 outer_end。

import type { EditorView } from 'prosemirror-view'
import { blockTextAt } from '../editor/text'
import type { Token } from './shared'
import { mathCursorAt, setCursorInBlock, tokenize } from './shared'

/** 与上游 `taboutClosingSymbols` 默认值逐条一致。 */
export const DEFAULT_TABOUT_CLOSING = [
  ')', ']', '\\rbrack', '\\}', '\\rbrace', '\\rangle', '\\rvert', '\\rVert', '\\rfloor', '\\rceil', '\\urcorner', '}',
]

/** `\left(` / `\bigl[` 这类「尺寸命令 + 定界符」的左半边。 */
const LEFT_COMMANDS = new Set(['\\left', '\\bigl', '\\Bigl', '\\biggl', '\\Biggl'])
const RIGHT_COMMANDS = new Set(['\\right', '\\bigr', '\\Bigr', '\\biggr', '\\Biggr'])

/** 能跟在尺寸命令后面的定界符全集(含 `.` 这种「隐形定界符」)。 */
const DELIMITERS = new Set([
  '(', ')',
  '[', ']', '\\lbrack', '\\rbrack',
  '\\{', '\\}', '\\lbrace', '\\rbrace',
  '<', '>', '\\langle', '\\rangle', '\\lt', '\\gt',
  '|', '\\vert', '\\lvert', '\\rvert',
  '\\|', '\\Vert', '\\lVert', '\\rVert',
  '\\lfloor', '\\rfloor',
  '\\lceil', '\\rceil',
  '\\ulcorner', '\\urcorner',
  '/', '\\\\', '\\backslash',
  '\\uparrow', '\\downarrow',
  '\\Uparrow', '\\Downarrow',
  '.',
])

/** 左右对称的定界符对照表(用于「跳出被包住的那一层」)。 */
const DELIMITER_PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '\\lbrack': '\\rbrack',
  '\\lbrace': '\\rbrace',
  '\\langle': '\\rangle',
  '\\lvert': '\\rvert',
  '\\lVert': '\\rVert',
  '\\lfloor': '\\rfloor',
  '\\lceil': '\\rceil',
  '\\ulcorner': '\\urcorner',
  '<': '>',
}

/** 这个 token 是不是「该跳出去的右定界符」。
 *  ⚠️前一个 token 是尺寸命令时,由尺寸命令的左右属性说了算:`\left|` 的 `|` 是**左**边,
 *  `\right|` 的 `|` 才是右边 —— 单看 `|` 分不出来。 */
function isClosingDelimiterToken(tokens: Token[], index: number, closing: Set<string>): boolean {
  const current = tokens[index]
  if (index > 0) {
    const prev = tokens[index - 1]
    if (RIGHT_COMMANDS.has(prev.text) && DELIMITERS.has(current.text)) return true
    if (LEFT_COMMANDS.has(prev.text) && DELIMITERS.has(current.text)) return false
  }
  return closing.has(current.text)
}

/** `\right` 后面没跟定界符 = 用户漏打了。上游把光标直接送到这里让人补上 —— 动作和正常跳一样,
 *  意图完全不同,所以单独一条分支(照搬上游的 Case 2)。 */
function isUnmatchedRightCommand(tokens: Token[], index: number): boolean {
  if (!RIGHT_COMMANDS.has(tokens[index].text)) return false
  const next = tokens[index + 1]
  if (!next) return true
  return !DELIMITERS.has(next.text)
}

export interface TaboutOptions {
  /** 视为右定界符的 token(上游 `taboutClosingSymbols`)。 */
  closingSymbols?: string[]
  /** 只有光标后面全是空白时才允许跳出整条公式(上游 `taboutExitEquationOnlyOnEOL`,默认开)。 */
  exitOnlyOnEOL?: boolean
}

export function tabout(view: EditorView, opts: TaboutOptions = {}): boolean {
  if (view.composing) return false
  // 有选区时不接管 Tab(上游 exitEquation 同款):用户多半想缩进,不是想跳。
  if (view.state.selection.from !== view.state.selection.to) return false

  const m = mathCursorAt(view.state)
  if (!m) return false
  if (!m.closed) return false // 见文件头 1

  const closing = new Set(opts.closingSymbols ?? DEFAULT_TABOUT_CLOSING)
  const inner = m.bt.text.slice(m.innerFrom, m.innerTo)
  const tokens = tokenize(inner)
  const rel = m.pos - m.innerFrom

  // 光标之后的第一个 token 起扫;光标后面没 token 了就直接进「跳出公式」分支。
  const found = tokens.findIndex((t) => t.end > rel)
  for (let i = found === -1 ? tokens.length : found; i < tokens.length; i++) {
    if (isClosingDelimiterToken(tokens, i, closing) || isUnmatchedRightCommand(tokens, i)) {
      setCursorInBlock(view, m.bt, m.innerFrom + tokens[i].end)
      return true
    }
  }

  // 没有可跳的括号了 → 跳出 `$`。上游默认要求光标后面只剩空白才肯跳出去,
  // 否则中间按 Tab 会把人一路弹到公式外,后半截公式就再也不方便回去改了。
  const rest = m.bt.text.slice(m.pos, m.innerTo)
  if (rest.trim().length !== 0 && (opts.exitOnlyOnEOL ?? true)) return false
  setCursorInBlock(view, m.bt, m.closed.to)
  return true
}

/** 只有这三个裸括号做「打穿」—— 与上游一致。`\}` 之类命令形态的定界符不在此列:
 *  用户打的是单个字符 `}`,而那种定界符要两个 token 才算数。 */
const TYPE_OVER_KEYS = new Set([')', ']', '}'])

/** 光标右边正好就是刚打下的那个右括号吗?(上游 `shouldTaboutByCloseBracket`) */
export function shouldTaboutByCloseBracket(view: EditorView, key: string): boolean {
  if (!TYPE_OVER_KEYS.has(key)) return false
  const sel = view.state.selection
  if (sel.from !== sel.to) return false // 有选区时这个键是「用括号替换选区」,不是跳过
  const bt = blockTextAt(view.state)
  if (!bt) return false
  return bt.text[bt.from] === key
}

/** 括号「打穿」:光标右边已经有一个 `)`,再打一次 `)` 不该多出一个,而是跳过去。
 *
 *  ⚠️上游此处不是简单地「光标 +1」,而是**整条 tabout**:`(a|)` 打 `)` 会跳到最近一层右定界符
 *  外侧,也就是那个 `)` 的后面 —— 结果看着一样,但 `\left(a|\right)` 这种就能跳过整个
 *  `\right)` 而不是卡在反斜杠中间。所以这里也委托 tabout,别自作聪明写成加一。
 *
 *  ⚠️**当前未接线**:得由接线层在 `handleTextInput` 里调(`text` 就是 key,返回 true 吞掉输入)。
 *  main.ts 不归本文件管,加不加由接线层决定。 */
export function taboutByCloseBracket(view: EditorView, key: string, opts: TaboutOptions = {}): boolean {
  if (view.composing) return false
  if (!shouldTaboutByCloseBracket(view, key)) return false
  return tabout(view, opts)
}

/** 从 `latex` 开头扫,返回**第一个没有配对左括号的右括号**的结尾偏移;没有 → null。
 *  即「光标正被哪一层括号包着」。矩阵快捷键要用它抢在插入 `&` 之前跳出括号(上游同款)。 */
export function taboutByEnclosedBrackets(latex: string, closingSymbols: string[] = DEFAULT_TABOUT_CLOSING): number | null {
  const closing = new Set(closingSymbols)
  // 只认「左右都在名单里」的括号对:closingSymbols 里没有 `)` 的话,`(` 也不该被压栈,
  // 否则 `(` 会把后面真正该跳的那个右括号吃掉一层。
  const closers = new Set(Object.values(DELIMITER_PAIRS).filter((c) => closing.has(c)))
  const openers = new Set(Object.keys(DELIMITER_PAIRS).filter((o) => closers.has(DELIMITER_PAIRS[o])))

  const stack: string[] = []
  for (const token of tokenize(latex)) {
    if (closers.has(token.text)) {
      if (stack.length === 0) return token.end
      stack.pop()
    } else if (openers.has(token.text)) {
      stack.push(token.text)
    }
  }
  return null
}
