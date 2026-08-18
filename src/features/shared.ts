// features/ 内部的公共零件 —— 四个特性都要的「我在哪条公式里」+ LaTeX 分词器。
//
// 为什么单独一个文件而不是塞进 editor/ 地基:地基那四个文件是**全插件**的契约(片段引擎也吃),
// 这里的东西只有 features 用得上(分词器只为 tabout / 自动放大括号服务)。放进地基等于给契约
// 加了没人需要的表面积。
//
// ⚠️运行时不许 import prosemirror —— 插件是被 `new Function('ctx', code)` 求值的,模块图不存在。
// 下面只有 `import type`(类型会被擦掉),真正的运行时接缝只有三处:view.state / view.dispatch、
// state.schema.text、以及地基 text.ts 注入过的 textSelectionAt。

import type { EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { BlockText } from '../editor/text'
import { blockTextAt, inInlineCode, isCodeBlock, textSelectionAt } from '../editor/text'
import type { MathContext, MathSpan } from '../editor/mathMode'
import { mathContext, mathSpanAt, scanMath } from '../editor/mathMode'

/** 光标所在公式的一次性快照。所有偏移都是 **textblock 文本坐标**(要文档坐标就 `+ bt.base`)。 */
export interface MathCursor {
  bt: BlockText
  ctx: MathContext
  /** 光标位置(= 选区右端,与上游 `selection.main.to` 同口径)。 */
  pos: number
  /** 公式正文范围。未闭合时 innerTo === pos(= 已经打出来的那一截)。 */
  innerFrom: number
  innerTo: number
  /** **闭合**的公式跨度(含 `$` 定界符);用户还没打收尾的 `$` 时为 null。
   *  需要「公式外侧在哪」的特性(tabout / box / select)必须先看这个,
   *  光看 ctx.span 会把「未闭合公式的光标位置」当成结尾,跳到公式外面去。 */
  closed: MathSpan | null
}

/** 光标在不在公式里?不在(或在代码块 / 行内代码里)→ null,调用方一律放行。 */
export function mathCursorAt(state: EditorState): MathCursor | null {
  const bt = blockTextAt(state)
  if (!bt) return null
  // 代码块 / 行内代码里用户在写字面量,`\frac` 就是要那五个字 —— 与片段引擎同一条闸。
  if (isCodeBlock(bt.node)) return null
  if (inInlineCode(bt.text, bt.from)) return null
  const pos = bt.to
  const ctx = mathContext(bt.text, pos, { inCodeBlock: false })
  if (!ctx.span) return null
  return {
    bt,
    ctx,
    pos,
    innerFrom: ctx.span.innerFrom,
    innerTo: ctx.span.innerTo,
    closed: mathSpanAt(scanMath(bt.text), pos),
  }
}

/** [from, to) 这段**文本坐标**里有没有行内原子(图片、双链芯片)。
 *
 *  ⚠️这是毁数据防线,不是洁癖。地基 blockString 把行内原子摊成等长的占位符,凡是「读出旧文本
 *  再插回去」的路径(加框、包公式、自动分式的分子)都会把真节点换成一串字面占位符 —— 图片当场
 *  变成几个方块字符,而且不可逆。所以这类路径必须先问一句,碰到原子就整个放弃。
 *
 *  判定走节点结构而不是「文本里有没有那个占位符」:占位符常量住在 text.ts 且没导出,
 *  在这儿复制一份就是第二真相,哪天地基换字符这道防线会静默失效。 */
export function hasInlineAtom(bt: BlockText, from: number, to: number): boolean {
  let found = false
  bt.node.forEach((child, offset) => {
    if (child.isText) return
    // 半开区间相交:零宽选区(from === to)永远相交不上 —— 光标本来就不可能停在原子内部。
    if (offset < to && offset + child.nodeSize > from) found = true
  })
  return found
}

/** 光标放到 textblock 文本坐标 `at`。 */
export function setCursorInBlock(view: EditorView, bt: BlockText, at: number): void {
  const pos = clampDocPos(view, bt.base + at)
  view.dispatch(view.state.tr.setSelection(textSelectionAt(view.state.doc, pos)).scrollIntoView())
}

/** 选中 textblock 文本坐标的 [from, to)。 */
export function setSelectionInBlock(view: EditorView, bt: BlockText, from: number, to: number): void {
  const a = clampDocPos(view, bt.base + from)
  const b = clampDocPos(view, bt.base + to)
  view.dispatch(view.state.tr.setSelection(textSelectionAt(view.state.doc, a, b)).scrollIntoView())
}

function clampDocPos(view: EditorView, pos: number): number {
  return Math.max(0, Math.min(view.state.doc.content.size, pos))
}

// ── 作用域栈 ──────────────────────────────────────────────────────────────────
// 「光标**最里层**被什么包着」:`\begin{pmatrix}` 环境?`\frac{` 的参数?还是只有一层裸 `{}`?
//
// 地基 mathMode 把环境名(envNamesAt)和宏名(macroNamesAt)拆成两个互不相干的栈 —— 够做
// 「排除某某环境」这类集合判断,但答不了「谁在最里层」。矩阵快捷键要的恰好是后者:上游取最内层
// 作用域,是环境就查环境名单、是宏就查宏名单、是公式本身就放行。少了这一步,
// `\begin{pmatrix} \frac{a|}{b} \end{pmatrix}` 里按 Tab 会把 ` & ` 插进分子。

export interface Scope {
  kind: 'env' | 'macro'
  name: string
}

/** 从 `from` 扫到 `pos`,返回由外到内的作用域栈。裸 `{}` 分组**透明**(只维持配平,不算一层)
 *  —— 上游的语法树里裸组不产出节点,`x^{a|b}` 里问「最里层」拿到的仍是外面那个环境。 */
export function scopeStackAt(text: string, from: number, pos: number): Scope[] {
  const stack: Array<Scope | null> = [] // null = 裸分组占位
  let i = Math.max(0, from)
  while (i < pos) {
    const c = text[i]
    if (c !== '\\') {
      if (c === '{') {
        stack.push(null)
      } else if (c === '}') {
        const closed = popBrace(stack)
        // `\frac{a}{b|}`:同一个命令的**第二个**参数。上游的语法树把它也算作 `\frac` 的
        // Argument,这里必须手动续链 —— 不续的话 `{b}` 会退化成裸分组、被当作透明的,
        // 「最里层」就答成外面那个环境:`\begin{pmatrix} \frac{a}{b|}` 按 Enter 会把
        // ` \\ ` 插进分母里(自动分式刚把光标送进分母,这条路径一点都不冷门)。
        // ⚠️只认**紧邻**的 `{`(`\frac{a} {b}` 宁可不续):允许跳空白的话,
        // `\text{x} {y}` 里那个无关的裸分组会被误标成 text —— 反方向的漂移。
        // ⚠️`i + 1 < pos` 不能省:光标正停在 `}|{` 之间时,人在两个参数**之外**。
        if (closed && closed.kind === 'macro' && text[i + 1] === '{' && i + 1 < pos) {
          stack.push(closed)
          i += 2
          continue
        }
      }
      i++
      continue
    }
    let j = i + 1
    while (j < text.length && /[A-Za-z]/.test(text[j])) j++
    // `\{` `\}` `\\`:转义符,连它后面那个字符一起跳过 —— `\{` 不是分组括号。
    if (j === i + 1) {
      i += 2
      continue
    }
    const name = text.slice(i + 1, j)
    if (name === 'begin' || name === 'end') {
      // ⚠️`\begin` 自带的那对花括号必须在这里一次吃掉。走通用分支的话它会 push 一层宏作用域
      // 'begin' 再被 `}` 弹掉,环境**永远进不了栈**,整个矩阵判定就成了摆设。
      const close = text[j] === '{' ? text.indexOf('}', j + 1) : -1
      if (close !== -1 && close < pos) {
        const env = text.slice(j + 1, close)
        if (name === 'begin') stack.push({ kind: 'env', name: env })
        else popEnv(stack, env)
        i = close + 1
        continue
      }
      // 环境名被光标劈开(`\begin{pma|trix}`)—— 不猜半个名字,退回按普通命令处理。
      i = j
      continue
    }
    if (text[j] === '{') {
      stack.push({ kind: 'macro', name })
      i = j + 1
      continue
    }
    i = j // `\alpha` 这类没带参数的命令不开作用域
  }
  return stack.filter((s): s is Scope => s !== null)
}

/** `}` 关掉最近一层花括号作用域,返回被关掉的那一层(裸分组 → null,没弹 → undefined)。
 *  ⚠️环境只认 `\end`,栈顶是环境时这个 `}` 是杂的,丢掉别乱弹。 */
function popBrace(stack: Array<Scope | null>): Scope | null | undefined {
  const top = stack[stack.length - 1]
  if (top === null || top?.kind === 'macro') return stack.pop()
  return undefined
}

/** `\end{x}` 关掉最近一层同名环境(连同它里面没闭合的花括号)。找不到同名的 = 用户写错了,no-op。 */
function popEnv(stack: Array<Scope | null>, name: string): void {
  for (let i = stack.length - 1; i >= 0; i--) {
    const s = stack[i]
    if (s?.kind === 'env' && s.name === name) {
      stack.length = i
      return
    }
  }
}

/** 光标最里层的作用域;只有公式本身包着 → null(对应上游的 `kind: 'math'`,那种情况一律放行)。 */
export function innermostScope(text: string, from: number, pos: number): Scope | null {
  const stack = scopeStackAt(text, from, pos)
  return stack[stack.length - 1] ?? null
}

// ── LaTeX 分词 ────────────────────────────────────────────────────────────────
// 逐字符判「这是不是右括号」会把 `\rangle` 拆成七个字符、把 `\{` 的反斜杠当成前一个 token 的尾巴。
// 上游 utils/tokenizer.ts 就是为这个存在的,这里原样移植(它本来就只吃字符串,与编辑器无关)。

export interface Token {
  readonly start: number
  readonly end: number
  readonly text: string
}

export function tokenize(latex: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < latex.length) {
    const c = latex[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '%') {
      // 注释吃到行尾(单 textblock 里通常没有换行,那就吃到底)
      let j = i + 1
      while (j < latex.length && latex[j] !== '\n') j++
      tokens.push({ start: i, end: j, text: latex.slice(i, j) })
      i = j
      continue
    }
    if (c === '\\') {
      let j = i + 1
      // ⚠️必须先判越界:上游这里直接 `/[A-Za-z]/.test(latex[j])`,越界拿到 undefined
      // 会被强转成字符串 "undefined" 而**匹配成功** —— 行尾一个孤零零的 `\` 就会吞掉后面的空气。
      if (/[A-Za-z]/.test(latex[j] ?? '')) {
        while (j < latex.length && /[A-Za-z]/.test(latex[j])) j++
      } else {
        j++
      }
      tokens.push({ start: i, end: j, text: latex.slice(i, j) })
      i = j
      continue
    }
    tokens.push({ start: i, end: i + 1, text: c })
    i++
  }
  return tokens
}

// ── 单字符括号配对(自动分数用) ──────────────────────────────────────────────

const OPEN_OF: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/** `close` 对应的左括号;不是右括号 → undefined。 */
export function openBracketOf(close: string): string | undefined {
  return OPEN_OF[close]
}

/** 从 `closeIndex`(必须正好是一个右括号)向左找配对的左括号,找不到 → null。 */
export function matchBracketBackward(text: string, closeIndex: number, open: string, close: string): number | null {
  let depth = 0
  for (let i = closeIndex; i >= 0; i--) {
    if (text[i] === close) depth++
    else if (text[i] === open) {
      depth--
      if (depth === 0) return i
    }
  }
  return null
}

/** 从 `openIndex` 向右找配对的右括号,找不到 → null。 */
export function matchBracketForward(text: string, openIndex: number, open: string, close: string): number | null {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return null
}
