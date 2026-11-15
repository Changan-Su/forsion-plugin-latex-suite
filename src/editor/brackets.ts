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

type Spec =
  | { kind: 'group'; open: Tok; close: Tok; children: Spec[] }
  | { kind: 'open'; tok: Tok }
  | { kind: 'close'; tok: Tok }
  | { kind: 'bad'; tok: Tok }

function closerOf(t: Tok): Ctx | null {
  if (t.text === '}') return 'brace'
  if (t.text === ']') return 'bracket'
  if (t.text.startsWith('\\right') && t.text !== '\\right') return 'left'
  return null
}
function openerOf(t: Tok): Ctx | null {
  if (t.text === '{') return 'brace'
  if (t.text === '[') return 'bracket'
  if (t.text.startsWith('\\left') && t.text !== '\\left') return 'left'
  return null
}

/** 结构括号一层层往下配;返回这一层的序列。没配上的结构左括号标红,它后面的内容留在本层。 */
function parse(toks: Tok[], i: number, ctx: Ctx[]): { specs: Spec[]; i: number; closer: Tok | null } {
  const specs: Spec[] = []
  const want = ctx[ctx.length - 1]
  while (i < toks.length) {
    const t = toks[i]
    const closes = closerOf(t)
    if (closes) {
      if (closes === want) return { specs, i: i + 1, closer: t }
      // 外层在等它 → 本层到此为止(本层的左括号没配上),交给外层收。
      if (ctx.includes(closes)) return { specs, i, closer: null }
      specs.push({ kind: 'bad', tok: t })
      i++
      continue
    }
    const opens = openerOf(t)
    if (opens) {
      const r = parse(toks, i + 1, [...ctx, opens])
      if (r.closer) specs.push({ kind: 'group', open: t, close: r.closer, children: r.specs })
      else specs.push({ kind: 'bad', tok: t }, ...r.specs)
      i = r.i
      continue
    }
    if (COMMAND_PAIRS[t.text]) specs.push({ kind: 'open', tok: t })
    else if (COMMAND_OPEN_OF[t.text]) specs.push({ kind: 'close', tok: t })
    i++
  }
  return { specs, i, closer: null }
}

export type BracketNode =
  | { kind: 'pair'; open: Tok; close: Tok; children: BracketNode[] }
  | { kind: 'mismatched'; tok: Tok; children: BracketNode[] }

/** 同一层里的非结构括号按栈配(上游 pairBrackets):右括号找最近的同类左括号,
 *  中间没配上的左括号原样留着(标红),它们之后的内容挂在它们下面、不算一层。 */
function pairLevel(specs: Spec[]): BracketNode[] {
  const top: BracketNode[] = []
  type Open = { node: BracketNode & { kind: 'mismatched' }; parent: Open | null; text: string }
  let parent: Open | null = null
  const stack: Open[] = []
  for (const s of specs) {
    const children = parent ? parent.node.children : top
    if (s.kind === 'open') {
      const o: Open = { node: { kind: 'mismatched', tok: s.tok, children: [] }, parent, text: s.tok.text }
      children.push(o.node)
      stack.push(o)
      parent = o
    } else if (s.kind === 'close') {
      const want = COMMAND_OPEN_OF[s.tok.text]
      let idx = -1
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k].text === want) { idx = k; break }
      if (idx < 0) {
        children.push({ kind: 'mismatched', tok: s.tok, children: [] })
        continue
      }
      const o = stack[idx]
      stack.length = idx
      const paired = o.node as unknown as BracketNode & { kind: 'pair' }
      Object.assign(paired, { kind: 'pair', open: o.node.tok, close: s.tok })
      delete (paired as unknown as { tok?: Tok }).tok
      parent = o.parent
    } else if (s.kind === 'group') {
      children.push({ kind: 'pair', open: s.open, close: s.close, children: pairLevel(s.children) })
    } else {
      children.push({ kind: 'mismatched', tok: s.tok, children: [] })
    }
  }
  return top
}

/** 一段公式正文里的括号树(textblock 文本坐标)。 */
export function bracketTree(text: string, from: number, to: number): BracketNode[] {
  return pairLevel(parse(tokenizeMath(text, from, to), 0, []).specs)
}

/** 先序遍历,配上的那一对往里一层深度 +1(上游 walkPairedBrackets)。 */
export function* walkBrackets(nodes: BracketNode[], depth = 0): Generator<{ node: BracketNode; depth: number }> {
  for (const node of nodes) {
    yield { node, depth }
    yield* walkBrackets(node.children, node.kind === 'pair' ? depth + 1 : depth)
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
