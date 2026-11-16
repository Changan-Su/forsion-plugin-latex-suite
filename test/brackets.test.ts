// 括号着色 / 光标那一对 / `$` 着色:规则照上游 Latex Suite 1.12.8(highlight_brackets.ts、highlight_dollar.ts),
// 期望值来自同一批公式在 Obsidian 里的实测。
import { describe, expect, it } from 'vitest'
import { Schema, Slice, Fragment } from 'prosemirror-model'
import { EditorState, Plugin, PluginKey, TextSelection, Selection, NodeSelection, AllSelection } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { bracketTree, walkBrackets, cursorPair, bracketPlugins, MATH_TOKEN_CLASS } from '../src/editor/brackets'
import { dollarMarks, dollarPlugins } from '../src/editor/dollars'

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' },
  code_block: { group: 'block', content: 'text*', code: true },
  hard_break: { inline: true, group: 'inline' }, text: { group: 'inline' },
  divider: { group: 'block', atom: true },
}, marks: { code: {} } })
const pm = { Plugin, PluginKey, TextSelection, Selection, NodeSelection, Decoration, DecorationSet, Slice, Fragment } as never

/** 公式正文里每个括号 → `文字:颜色`(配上的给深度 % 3,配不上的给 x)。 */
function paint(math: string): string[] {
  const out: { from: number; s: string }[] = []
  for (const { node, depth } of walkBrackets(bracketTree(math, 0, math.length))) {
    if (node.kind === 'pair') {
      out.push({ from: node.open.from, s: `${node.open.text}:${depth % 3}` }, { from: node.close.from, s: `${node.close.text}:${depth % 3}` })
    } else out.push({ from: node.tok.from, s: `${node.tok.text}:x` })
  }
  return out.sort((a, b) => a.from - b.from).map((x) => x.s)
}

/** `|` 处的光标(或 «…» 选区)落在哪一对上 → 那一对的文字。 */
function cursorOn(source: string): string | null {
  const sel = source.includes('«')
  const from = sel ? source.indexOf('«') : source.indexOf('|')
  const text = source.replace(/[|«»]/g, '')
  const to = sel ? source.indexOf('»') - 1 : from
  const hit = cursorPair(bracketTree(text, 0, text.length), from, to)
  return hit ? `${text.slice(hit.open.from, hit.open.to)}@${hit.open.from}…${text.slice(hit.close.from, hit.close.to)}@${hit.close.from}` : null
}

describe('bracket colors (upstream depth cycle)', () => {
  it('nested groups on the reported formula get three different colors', () => {
    expect(paint(' t({n_{j}})')).toEqual(['(:0', '{:1', '{:2', '}:2', '}:1', '):0'])
  })
  it('sibling groups stay on the first color; \\left( \\right) is one token each', () => {
    expect(paint('\\frac{a}{b} + \\alpha_{i}^{2} \\left( x \\right)')).toEqual(['{:0', '}:0', '{:0', '}:0', '{:0', '}:0', '{:0', '}:0', '\\left(:0', '\\right):0'])
  })
  it('command brackets take part and nest by depth', () => {
    expect(paint('\\left( \\{ a \\} \\right)')).toEqual(['\\left(:0', '\\{:1', '\\}:1', '\\right):0'])
    expect(paint('\\langle x, \\lvert y \\rvert \\rangle')).toEqual(['\\langle:0', '\\lvert:1', '\\rvert:1', '\\rangle:0'])
    expect(paint('\\left\\langle x \\right\\rangle')).toEqual(['\\left\\langle:0', '\\right\\rangle:0'])
  })
  it('the fourth level wraps back to the first color', () => {
    expect(paint('((([x])))')).toEqual(['(:0', '(:1', '(:2', '[:0', ']:0', '):2', '):1', '):0'])
  })
  it('an unmatched opener stays red and does not count as a level', () => {
    expect(paint('( a ( b )')).toEqual(['(:x', '(:0', '):0'])
    expect(paint('a )')).toEqual([')' + ':x'])
    expect(paint('(a]')).toEqual(['(:x', ']:x'])
    expect(paint('{a')).toEqual(['{:x'])
    expect(paint('a}')).toEqual(['}:x'])
  })
  it('an unclosed \\left( is red, and so is a stray \\right)', () => {
    expect(paint('\\left( x')).toEqual(['\\left(:x'])
    expect(paint('x \\right)')).toEqual(['\\right):x'])
  })
  it('a closer for an outer group ends the inner one instead of being swallowed', () => {
    // `{` 里漏了 `)` → `(` 标红,外层 `{}` 照样配上。
    expect(paint('{ ( a }')).toEqual(['{:0', '(:x', '}:0'])
  })
  it('arrow commands that start with \\left / \\right are not delimiters', () => {
    expect(paint('a \\rightarrow b')).toEqual([])
    expect(paint('A \\leftrightarrow B')).toEqual([])
    expect(paint('{a \\leftarrow b}')).toEqual(['{:0', '}:0'])
    expect(paint('\\left( a \\rightarrow b \\right)')).toEqual(['\\left(:0', '\\right):0'])
    expect(paint('\\left\\{ x \\mid x \\rightarrow 0 \\right\\}')).toEqual(['\\left\\{:0', '\\right\\}:0'])
    expect(paint('\\lefteqn{a}')).toEqual(['{:0', '}:0'])
    expect(cursorOn('\\left( a| \\rightarrow b \\right)')).toBe('\\left(@0…\\right)@23')
  })
  it('thousands of nested or unmatched brackets neither overflow the stack nor go quadratic', () => {
    for (const math of ['('.repeat(100000), '{'.repeat(50000) + 'x' + '}'.repeat(50000), '(a,b] '.repeat(20000), '\\left( '.repeat(20000)]) {
      const t0 = Date.now()
      const nodes = bracketTree(math, 0, math.length)
      let n = 0
      for (const _ of walkBrackets(nodes)) n++
      expect(n).toBeGreaterThan(0)
      expect(cursorPair(nodes, 1, 1) === undefined).toBe(false)
      expect(Date.now() - t0).toBeLessThan(1500)
    }
  })
  it('escaped dollars, comments and other control symbols are not brackets', () => {
    expect(paint('a % ( b\n c')).toEqual([])
    expect(paint('\\\\ \\, x')).toEqual([])
  })
})

describe('bracket under the cursor (upstream highlightCursorBrackets)', () => {
  it('matches what Obsidian shades on the two reference formulas', () => {
    // Obsidian 实测:V1a 光标在 n_{ 与 j 之间 → 最内层 {};V3 光标在 x 后 → \left( \right)。
    expect(paint(' t(\\{n_{j}\\}) ')).toEqual(['(:0', '\\{:1', '{:2', '}:2', '\\}:1', '):0'])
    expect(cursorOn(' t(\\{n_{|j}\\}) ')).toBe('{@7…}@9')
    expect(cursorOn(' \\frac{a}{b} + \\alpha_{i}^{2} \\left( x| \\right) ')).toBe('\\left(@30…\\right)@39')
  })
  it('counts both ends as inside and picks the innermost pair', () => {
    expect(cursorOn('|( a )')).toBe('(@0…)@4')
    expect(cursorOn('( a )|')).toBe('(@0…)@4')
    expect(cursorOn('( a |( b ) )')).toBe('(@4…)@8')
    expect(cursorOn('( a ( b )| )')).toBe('(@4…)@8')
    expect(cursorOn('( a ( b ) |)')).toBe('(@0…)@10')
  })
  it('between two adjacent pairs the later one wins (same loop order as upstream)', () => {
    expect(cursorOn('()|()')).toBe('(@2…)@3')
  })
  it('outside any pair there is nothing to shade', () => {
    expect(cursorOn('x| ( a )')).toBeNull()
    expect(cursorOn('( a ) |y')).toBeNull()
  })
  it('unmatched brackets are never the cursor pair', () => {
    expect(cursorOn('( a |')).toBeNull()
  })
  it('a selection takes the first pair whose closer lies inside it', () => {
    expect(cursorOn('( a «( b )» )')).toBe('(@4…)@8')
  })
})

describe('bracket plugin decorations', () => {
  const doc = (blocks: Array<[string, string]>) => schema.node('doc', null, blocks.map(([type, text]) => schema.node(type, null, text ? [schema.text(text)] : [])))
  const run = (d: ReturnType<typeof doc>, cursor: number) => {
    const plugins = bracketPlugins(pm, { highlight: () => true, colorize: () => true })
    const state = EditorState.create({ schema, doc: d, plugins, selection: TextSelection.create(d, cursor) })
    return plugins.flatMap((p) => (p.props.decorations!.call(p, state) as DecorationSet).find())
      .map((x) => `${state.doc.textBetween(x.from, x.to)}@${x.from}:${(x as unknown as { type: { attrs: { class: string } } }).type.attrs.class}`)
  }
  it('colors only inside math, shades the pair around the cursor, and carries the shared marker class', () => {
    const d = doc([['paragraph', 'f(x) $(a)$']])
    // 正文的 f(x) 不动;公式里的 ( ) 着色,光标在公式里时再加底色。
    expect(run(d, 9)).toEqual([
      `(@7:${MATH_TOKEN_CLASS} latex-suite-color-bracket-0`,
      `)@9:${MATH_TOKEN_CLASS} latex-suite-color-bracket-0`,
      `(@7:${MATH_TOKEN_CLASS} latex-suite-highlighted-bracket`,
      `)@9:${MATH_TOKEN_CLASS} latex-suite-highlighted-bracket`,
    ])
    expect(run(d, 3)).toHaveLength(2)
  })
  it('a selection that is not inside a textblock (select all, a selected block atom) does not throw', () => {
    const d = schema.node('doc', null, [schema.node('divider'), schema.node('paragraph', null, [schema.text('$(a)$')])])
    const plugins = bracketPlugins(pm, { highlight: () => true, colorize: () => true })
    for (const sel of [new AllSelection(d), NodeSelection.create(d, 0)]) {
      const state = EditorState.create({ schema, doc: d, plugins, selection: sel })
      expect(() => state.apply(state.tr.setSelection(sel))).not.toThrow()
      // 着色照常,光标那一对没有可画的。
      expect(plugins.flatMap((p) => (p.props.decorations!.call(p, state) as DecorationSet).find())).toHaveLength(2)
    }
  })
  it('a formula with thousands of open braces still lets the editor start', () => {
    const d = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('$$' + '{'.repeat(10000) + 'x$$')])])
    const plugins = bracketPlugins(pm, { highlight: () => true, colorize: () => true })
    expect(() => EditorState.create({ schema, doc: d, plugins, selection: TextSelection.create(d, 5000) })).not.toThrow()
  })
  it('code blocks are left alone', () => {
    expect(run(doc([['code_block', '$(a)$']]), 3)).toEqual([])
  })
})

describe('dollar delimiters (upstream highlightDollar)', () => {
  const show = (text: string) => dollarMarks(text).map((m) => `${text.slice(m.from, m.to)}@${m.from}:${m.error ? 'red' : 'green'}`)
  it('paired inline and display delimiters are green', () => {
    expect(show('Intro $qr$ line.')).toEqual(['$@6:green', '$@9:green'])
    expect(show('$$ t({n_{j}})$$')).toEqual(['$$@0:green', '$$@13:green'])
    expect(show('$$\ncd\n$$')).toEqual(['$$@0:green', '$$@6:green'])
  })
  it('a stray $ inside display math is red', () => {
    expect(show('$$ a c$ b $$')).toEqual(['$$@0:green', '$@6:red', '$$@10:green'])
  })
  it('an unclosed $$ that opens the block is red', () => {
    expect(show('$$ a+bc')).toEqual(['$$@0:red'])
  })
  it('prose dollars, escaped dollars and the bare auto-paired $$ stay uncolored', () => {
    expect(show('costs $5 and more')).toEqual([])
    expect(show('\\$ and \\$')).toEqual([])
    expect(show('$$')).toEqual([])
  })
  it('the plugin marks with the shared class and can be switched off', () => {
    const d = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('$a$')])])
    const classes = (on: boolean) => {
      const [p] = dollarPlugins(pm, { enabled: () => on })
      const state = EditorState.create({ schema, doc: d, plugins: [p] })
      return (p.props.decorations!.call(p, state) as DecorationSet).find().map((x) => (x as unknown as { type: { attrs: { class: string } } }).type.attrs.class)
    }
    expect(classes(true)).toEqual([`${MATH_TOKEN_CLASS} latex-suite-highlighted-dollar-inline`, `${MATH_TOKEN_CLASS} latex-suite-highlighted-dollar-inline`])
    expect(classes(false)).toEqual([])
  })
})
