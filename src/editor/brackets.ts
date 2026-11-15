// 公式里的括号:按深度着色 + 光标那一对加底色(上游 editor_extensions/highlight_brackets.ts 的对位)。
//
// 规则逐条照上游(上游靠 lezer 语法树,这里公式就是一段纯文本,自己扫):
//  ① **结构括号优先**:`{…}`、`\left… \right…`、`[…]` 先按结构配,里面的东西单独再配;
//     `(` `)` 与 `\{ \}`、`\langle \rangle`、`\lvert \rvert` 这类命令括号在同一层里按栈配
//     (遇到右括号找最近的同类左括号,中间没配上的左括号留着标红)。
//  ② **颜色按配对深度三色轮换**(只有配上的那一对算一层),配不上的标红。
//     `\left(`、`\{` 这种多字符的括号整个着色。
//  ③ **光标那一对**:包住光标的最内层一对,两端都算包住(光标贴在 `(` 左边或 `)` 右边也算),
//     只加底色、不描边。有选区时取第一对右端落在选区里的。
//
// 与上游刻意不同的两处(都是上游的笔误,照抄会把正常公式标红):上游表里 `"[": "}"`、
// `"\\langle "`(多一个空格)—— 这里 `[` 配 `]`、`\langle` 配 `\rangle`。
//
// 只在公式跨度内工作:正文里的括号是散文的一部分,染色会很吵。

import type { EditorState, Plugin } from 'prosemirror-state'
import type { DecorationSet, Decoration } from 'prosemirror-view'
import type { Node as PmNode } from 'prosemirror-model'
import type { PmToolkit } from '../../types/forsion'
import { mathBlockString, isCodeBlock } from './text'
import { scanMath, type MathSpan } from './mathMode'

/** 所有本插件画在公式源码上的颜色都带这个类:选择器靠它多一层特异性,压过宿主的源码着色(见 main.ts 样式)。 */
export const MATH_TOKEN_CLASS = 'latex-suite-math-token'
const N_COLORS = 3

export interface Tok {
  /** textblock 文本坐标。 */
  from: number
  to: number
  text: string
}

/** 命令形式的成对括号(上游 bracket_delimiters,去掉笔误)。 */
const COMMAND_PAIRS: Record<string, string> = {
  '\\{': '\\}',
  '\\langle': '\\rangle',
  '\\lvert': '\\rvert',
  '\\lVert': '\\rVert',
  '\\lbrace': '\\rbrace',
  '\\lbrack': '\\rbrack',
  '\\lceil': '\\rceil',
  '\\lfloor': '\\rfloor',
  '\\lgroup': '\\rgroup',
  '\\llcorner': '\\lrcorner',
  '\\lmoustache': '\\rmoustache',
  '\\lparen': '\\rparen',
  '(': ')',
}
const COMMAND_OPEN_OF: Record<string, string> = Object.fromEntries(Object.entries(COMMAND_PAIRS).map(([o, c]) => [c, o]))

/** 公式文本切成 token:命令(`\frac`)、控制符(`\{`、`\\`)、单字符;`%` 注释到行尾整段跳过;
 *  `\left` / `\right` 连同后面的定界符(中间可以有空白)合成一个 token。 */
export function tokenizeMath(text: string, from: number, to: number): Tok[] {
  const raw: Tok[] = []
  let i = from
  while (i < to) {
    const c = text[i]
    if (c === '%') {
      while (i < to && text[i] !== '\n') i++
      continue
    }
    if (/\s/.test(c)) { i++; continue }
    if (c === '\\') {
      let j = i + 1
      if (/[A-Za-z]/.test(text[j] ?? '')) while (j < to && /[A-Za-z]/.test(text[j])) j++
      else j = Math.min(to, j + 1)
      raw.push({ from: i, to: j, text: text.slice(i, j) })
      i = j
      continue
    }
    raw.push({ from: i, to: i + 1, text: c })
    i++
  }
  const out: Tok[] = []
  for (let k = 0; k < raw.length; k++) {
    const t = raw[k]
    const next = raw[k + 1]
    if ((t.text === '\\left' || t.text === '\\right') && next && isDelimiter(next.text)) {
      out.push({ from: t.from, to: next.to, text: text.slice(t.from, next.to) })
      k++
    } else out.push(t)
  }
  return out
}

/** 能跟在 `\left` / `\right` 后面的东西:单个非字母字符,或一条命令(`\langle`、`\{`、`\vert`…)。 */
function isDelimiter(s: string): boolean {
  if (s.startsWith('\\')) return s !== '\\left' && s !== '\\right'
  return s.length === 1 && !/[A-Za-z0-9{}]/.test(s)
}

type Ctx = 'brace' | 'bracket' | 'left'

// ⚠️`\right` / `\left` 后面必须**不是字母**:tokenizeMath 已把 `\right)` 合成一个 token,而 `\rightarrow`、
// `\leftarrow`、`\lefteqn` 是另一条命令。曾经用 startsWith 判:箭头全被当成定界符,单独出现标红、
// 在 `\left( … \right)` 里抢走配对。裸的 `\left` / `\right`(后面没跟定界符)也不算。
const RIGHT_DELIM = /^\\right(?![A-Za-z])/
const LEFT_DELIM = /^\\left(?![A-Za-z])/

function closerOf(t: Tok): Ctx | null {
  if (t.text === '}') return 'brace'
  if (t.text === ']') return 'bracket'
  if (t.text !== '\\right' && RIGHT_DELIM.test(t.text)) return 'left'
  return null
}
function openerOf(t: Tok): Ctx | null {
  if (t.text === '{') return 'brace'
  if (t.text === '[') return 'bracket'
  if (t.text !== '\\left' && LEFT_DELIM.test(t.text)) return 'left'
  return null
}

export type BracketNode =
  | { kind: 'pair'; open: Tok; close: Tok; children: BracketNode[] }
  | { kind: 'mismatched'; tok: Tok; children: BracketNode[] }

// 下面全是显式栈的迭代实现。⚠️别改回递归:曾经 parse / 配对 / 遍历都是递归,单条公式里几千层
// 嵌套或没配上的左括号就爆栈(init 里抛 = 编辑器起不来),到那之前耗时也按平方涨。

/** 第一遍:结构括号(`{}`、`[]`、`\left \right`)怎么配。返回 match[i] = 配上的另一端下标,
 *  -1 = 没配上(标红)。规则:右括号先找栈顶;栈顶不是同类、但更外层有同类在等 → 中间那些
 *  没收口的左括号都算没配上,由外层收;谁也不等它 → 它自己没配上。 */
function matchStructural(toks: Tok[]): Int32Array {
  const match = new Int32Array(toks.length).fill(-1)
  const stack: Array<{ ctx: Ctx; i: number }> = []
  const waiting: Record<Ctx, number> = { brace: 0, bracket: 0, left: 0 }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    const closes = closerOf(t)
    if (closes) {
      if (!waiting[closes]) continue
      for (;;) {
        const top = stack.pop()!
        waiting[top.ctx]--
        if (top.ctx === closes) {
          match[top.i] = i
          match[i] = top.i
          break
        }
      }
      continue
    }
    const opens = openerOf(t)
    if (opens) {
      stack.push({ ctx: opens, i })
      waiting[opens]++
    }
  }
  return match
}

/** 一段公式正文里的括号树(textblock 文本坐标)。
 *  第二遍:配上的结构括号开一层;同一层里 `( )` 与 `\{ \}` 这类命令括号按栈配(上游 pairBrackets):
 *  右括号找最近的同类左括号,中间没配上的左括号原样留着(标红),它们之后的内容挂在它们下面、不算一层。
 *  没配上的结构左括号不开层,它里面的东西留在本层一起配。 */
export function bracketTree(text: string, from: number, to: number): BracketNode[] {
  const toks = tokenizeMath(text, from, to)
  const match = matchStructural(toks)
  type Open = { node: BracketNode & { kind: 'mismatched' }; cur: BracketNode[] }
  type Level = { cur: BracketNode[]; opens: Open[]; byText: Map<string, number[]> }
  const top: BracketNode[] = []
  const levels: Level[] = [{ cur: top, opens: [], byText: new Map() }]
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    const level = levels[levels.length - 1]
    if (closerOf(t) || openerOf(t)) {
      const m = match[i]
      if (m < 0) {
        level.cur.push({ kind: 'mismatched', tok: t, children: [] })
      } else if (m > i) {
        const node: BracketNode = { kind: 'pair', open: t, close: toks[m], children: [] }
        level.cur.push(node)
        levels.push({ cur: node.children, opens: [], byText: new Map() })
      } else {
        levels.pop() // 本层收口;层里没配上的命令左括号保持标红
      }
      continue
    }
    if (COMMAND_PAIRS[t.text]) {
      const node: BracketNode & { kind: 'mismatched' } = { kind: 'mismatched', tok: t, children: [] }
      level.cur.push(node)
      const list = level.byText.get(t.text) ?? []
      list.push(level.opens.length)
      level.byText.set(t.text, list)
      level.opens.push({ node, cur: level.cur })
      level.cur = node.children
      continue
    }
    const want = COMMAND_OPEN_OF[t.text]
    if (!want) continue
    const list = level.byText.get(want)
    if (!list || !list.length) {
      level.cur.push({ kind: 'mismatched', tok: t, children: [] })
      continue
    }
    const idx = list[list.length - 1]
    const o = level.opens[idx]
    // 弹掉 idx 及以上的左括号(它们在各自文字的列表里都排在最后)。
    for (let k = level.opens.length - 1; k >= idx; k--) level.byText.get(level.opens[k].node.tok.text)!.pop()
    level.opens.length = idx
    const opened = o.node.tok
    const paired = o.node as unknown as { kind: string; open?: Tok; close?: Tok; tok?: Tok }
    paired.kind = 'pair'
    paired.open = opened
    paired.close = t
    delete paired.tok
    level.cur = o.cur
  }
  return top
}

/** 先序遍历,配上的那一对往里一层深度 +1(上游 walkPairedBrackets)。 */
export function* walkBrackets(nodes: BracketNode[], depth = 0): Generator<{ node: BracketNode; depth: number }> {
  const stack: Array<{ nodes: BracketNode[]; i: number; depth: number }> = [{ nodes, i: 0, depth }]
  while (stack.length) {
    const frame = stack[stack.length - 1]
    if (frame.i >= frame.nodes.length) {
      stack.pop()
      continue
    }
    const node = frame.nodes[frame.i++]
    yield { node, depth: frame.depth }
    if (node.children.length) stack.push({ nodes: node.children, i: 0, depth: node.kind === 'pair' ? frame.depth + 1 : frame.depth })
  }
}

/** 光标那一对(上游 highlightCursorBrackets 的循环原样搬):有选区时取第一对右端落在选区里的;
 *  光标时取包住它的最内层一对,两端都算包住。 */
export function cursorPair(nodes: BracketNode[], from: number, to: number): (BracketNode & { kind: 'pair' }) | null {
  let hit: (BracketNode & { kind: 'pair' }) | null = null
  const empty = from === to
  for (const { node } of walkBrackets(nodes)) {
    if (node.kind !== 'pair') continue
    if (!empty && ((node.close.to <= to && node.close.to >= from) || (node.open.from >= to && node.open.from <= from))) {
      hit = node
      break
    }
    if (node.open.from <= to && node.close.to >= to) {
      hit = node
      continue
    }
    if (node.open.from > to) break
  }
  return hit
}

export interface BracketOptions {
  /** 光标那一对加底色(上游 highlightCursorBracketsEnabled)。 */
  highlight: () => boolean
  /** 按深度着色(上游 colorPairedBracketsEnabled)。 */
  colorize: () => boolean
}

interface SpanAt {
  span: MathSpan
  text: string
  base: number
}

/** 每个 textblock 里的公式跨度(代码块除外)。 */
function eachMath(doc: PmNode, fn: (s: SpanAt) => void, range?: { from: number; to: number }): void {
  const visit = (node: PmNode, pos: number): boolean => {
    if (!node.isTextblock) return true
    if (isCodeBlock(node)) return false
    const text = mathBlockString(node)
    for (const span of scanMath(text)) fn({ span, text, base: pos + 1 })
    return false
  }
  if (range) doc.nodesBetween(range.from, range.to, visit)
  else doc.descendants(visit)
}

export function bracketPlugins(pm: PmToolkit, opts: BracketOptions): Plugin[] {
  const colorKey = new pm.PluginKey<DecorationSet>('LATEX_SUITE_BRACKET_COLORS')
  const cursorKey = new pm.PluginKey<DecorationSet>('LATEX_SUITE_BRACKET_CURSOR')
  const mark = (from: number, to: number, cls: string): Decoration =>
    pm.Decoration.inline(from, to, { class: `${MATH_TOKEN_CLASS} ${cls}` })

  const buildColors = (state: EditorState): DecorationSet => {
    if (!opts.colorize()) return pm.DecorationSet.empty
    const decos: Decoration[] = []
    eachMath(state.doc, ({ span, text, base }) => {
      for (const { node, depth } of walkBrackets(bracketTree(text, span.innerFrom, span.innerTo))) {
        if (node.kind === 'pair') {
          const cls = `latex-suite-color-bracket-${depth % N_COLORS}`
          decos.push(mark(base + node.open.from, base + node.open.to, cls), mark(base + node.close.from, base + node.close.to, cls))
        } else {
          decos.push(mark(base + node.tok.from, base + node.tok.to, 'latex-suite-mismatched-bracket'))
        }
      }
    })
    return pm.DecorationSet.create(state.doc, decos)
  }

  const buildCursor = (state: EditorState): DecorationSet => {
    if (!opts.highlight()) return pm.DecorationSet.empty
    const { from, to, $from } = state.selection
    // 全选、选中一个块级原子(图片、分割线)时选区不在任何文本块里:没有「光标那一对」。
    // ⚠️别去掉:顶层 $from.before() 会抛,而这里跑在 init / apply 里,一抛整个编辑器起不来。
    if (!$from.parent.isTextblock) return pm.DecorationSet.empty
    const decos: Decoration[] = []
    eachMath(state.doc, ({ span, text, base }) => {
      if (decos.length) return
      // 选区起点要落在这条公式的正文里(定界符内侧也算)。
      if (from < base + span.innerFrom || from > base + span.innerTo) return
      const hit = cursorPair(bracketTree(text, span.innerFrom, span.innerTo), from - base, to - base)
      if (!hit) return
      decos.push(
        mark(base + hit.open.from, base + hit.open.to, 'latex-suite-highlighted-bracket'),
        mark(base + hit.close.from, base + hit.close.to, 'latex-suite-highlighted-bracket'),
      )
    }, { from: $from.before(), to: $from.after() })
    return pm.DecorationSet.create(state.doc, decos)
  }

  return [
    new pm.Plugin<DecorationSet>({
      key: colorKey,
      state: {
        init: (_c, state) => buildColors(state),
        // 着色只看文本:选区变了不重扫(长笔记里每挪一下光标都全文扫一遍会卡)。
        apply: (tr, prev, _old, state) => (tr.docChanged || tr.getMeta('latex-suite-settings') ? buildColors(state) : prev),
      },
      props: { decorations: (state) => colorKey.getState(state) ?? null },
    }),
    new pm.Plugin<DecorationSet>({
      key: cursorKey,
      state: {
        init: (_c, state) => buildCursor(state),
        apply: (tr, prev, _old, state) => (tr.docChanged || tr.selectionSet || tr.getMeta('latex-suite-settings') ? buildCursor(state) : prev),
      },
      props: { decorations: (state) => cursorKey.getState(state) ?? null },
    }),
  ]
}
