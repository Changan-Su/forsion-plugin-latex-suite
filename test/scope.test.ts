import { describe, expect, it } from 'vitest'
import { Schema, Slice, Fragment } from 'prosemirror-model'
import { EditorState, Plugin, PluginKey, TextSelection, Selection, NodeSelection } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { keymap } from 'prosemirror-keymap'
import { InputRule, inputRules } from 'prosemirror-inputrules'
import { createEngine } from '../src/editor/expand'
import { createTabstops } from '../src/editor/tabstops'
import { mathBlockString, setTextSelectionCtor } from '../src/editor/text'
import { normalizeSnippets, parseSnippets, type RawSnippet } from '../src/snippets/parse'
import { DEFAULT_SNIPPETS } from '../src/snippets/defaults'
import { DEFAULT_SNIPPET_VARIABLES } from '../src/snippets/variables'
import { mathContext } from '../src/editor/mathMode'
import { autoEnlargeBrackets, autoFraction, exitMatrix, matrixShortcut, enterInlineMath } from '../src/features'
import { bracketPlugins } from '../src/editor/brackets'

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' },
  code_block: { group: 'block', content: 'text*', code: true },
  hard_break: { inline: true, group: 'inline' }, image: { inline: true, group: 'inline', atom: true }, text: { group: 'inline' },
}, marks: { code: {}, amadeusEscaped: {} } })
const pm = { Plugin, PluginKey, TextSelection, Selection, NodeSelection, Decoration, DecorationSet, Slice, Fragment, keymap, InputRule, inputRules }
setTextSelectionCtor(TextSelection)
function rig(source: string, opts: { snippets?: RawSnippet[]; prose?: boolean; code?: boolean; mark?: 'code' | 'amadeusEscaped'; enlarge?: boolean; select?: number; hardbreak?: boolean } = {}) {
  const pos = source.indexOf('|')
  const text = source.replace('|', '')
  const marks = opts.mark ? [schema.marks[opts.mark].create()] : []
  const children = opts.hardbreak ? text.split('\n').flatMap((line, i) => [...(i ? [schema.node('hard_break')] : []), ...(line ? [schema.text(line, marks)] : [])]) : text ? [schema.text(text, marks)] : []
  const doc = schema.node('doc', null, [schema.node(opts.code ? 'code_block' : 'paragraph', null, children)])
  const tabs = createTabstops(pm)
  let state = EditorState.create({ schema, doc, plugins: [tabs.plugin], selection: TextSelection.create(doc, opts.select ?? pos + 1, pos + 1) })
  const view = {
    composing: false,
    get state() { return state },
    dispatch(tr: ReturnType<EditorState['tr']['setTime']>) { state = state.applyTransaction(tr).state },
  } as unknown as EditorView
  const engine = createEngine(pm, tabs, () => normalizeSnippets(opts.snippets ?? DEFAULT_SNIPPETS, DEFAULT_SNIPPET_VARIABLES).snippets, () => ({
    proseSnippetsEnabled: opts.prose, wordDelimiters: ' .,\n', removeSnippetWhitespace: true,
    autoEnlargeBrackets: opts.enlarge ?? false, autoEnlargeBracketsTriggers: ['frac'], maxRecursion: 0,
  }), (v) => autoEnlargeBrackets(v))
  const type = (typed: string): boolean => {
    const { from, to } = view.state.selection
    const handled = engine.onTextInput(view, from, to, typed)
    if (!handled) view.dispatch(view.state.tr.insertText(typed, from, to))
    return handled
  }
  return { view, engine, tabs, type, text: () => view.state.doc.textContent }
}

describe('scope: actual ProseMirror documents', () => {
  it.each(['价格 $5 后面 s|r', '价格 $5-$10 后面 @|a', '$HOME/$USER 后面 s|r', '普通 m|k', '正文 d|m', '$s|r', '\\$s|r\\$'])('does not capture prose or unclosed math: %s', (source) => {
    const r = rig(source)
    const typed = source.includes('@|') ? 'a' : source.includes('m|') ? 'k' : source.includes('d|') ? 'm' : 'r'
    expect(r.type(typed)).toBe(false)
  })
  it('works in closed math and empty paired inline math', () => {
    const r = rig('$@|$'); expect(r.type('a')).toBe(true); expect(r.text()).toBe('$\\alpha$')
    const empty = rig('$|$'); empty.type('@'); expect(empty.type('a')).toBe(true); expect(empty.text()).toBe('$\\alpha$')
  })
  it.each(['$ps|$', '$$ps|$$', '$x+ps|$'])('expands Greek at a math boundary while preserving its prefix: %s', (source) => {
    const r = rig(source)
    expect(r.type('i')).toBe(true)
    expect(r.text()).toBe(source.replace('ps|', '\\psi'))
  })
  it('expands upper-case Psi from the default Greek vocabulary', () => {
    const r = rig('$Ps|$')
    expect(r.type('i')).toBe(true)
    expect(r.text()).toBe('$\\Psi$')
  })
  it('does not consume a closing dollar as part of a math trigger', () => {
    const r = rig('$x|$', { snippets: [{ trigger: '$', replacement: 'BAD', options: 'mA' }] })
    expect(r.type('$')).toBe(false)
  })
  it.each([{ code: true }, { mark: 'code' as const }, { mark: 'amadeusEscaped' as const }])('excludes marked code and escaped literals %j', (opts) => {
    const r = rig('$@|$', opts); expect(r.type('a')).toBe(false)
    expect(autoFraction(r.view, '\\frac', { enabled: true })).toBe(false)
    const bracket = bracketPlugins(pm, { highlight: () => true, colorize: () => true })[0]
    const state = EditorState.create({ schema, doc: r.view.state.doc, plugins: [bracket] })
    const set = bracket.props.decorations!.call(bracket, state) as DecorationSet
    expect(set.find()).toHaveLength(0)
  })
  it('does not treat a dollar inside an earlier code mark as an opener', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('$', [schema.marks.code.create()]), schema.text(' amount sr')])])
    const text = mathBlockString(doc.firstChild!)
    expect(mathContext(text, text.length, { inCodeBlock: false }).mode.text).toBe(true)
  })
  it('respects a code mark enabled for the next typed character', () => {
    const r = rig('$@|$')
    r.view.dispatch(r.view.state.tr.setStoredMarks([schema.marks.code.create()]))
    expect(r.type('a')).toBe(false)
    expect(r.text()).toBe('$@a$')
    expect(r.view.state.doc.firstChild!.child(1).marks[0].type.name).toBe('code')
  })
  it('a backslash cannot hide a hardbreak from inline-math scope', () => {
    const r = rig('$x\\\n@|$', { hardbreak: true })
    expect(r.type('a')).toBe(false)
  })
  it('does not rewrite a numerator containing a code-marked node', () => {
    const r = rig('seed|')
    const paragraph = schema.node('paragraph', null, [schema.text('$a'), schema.text('b', [schema.marks.code.create()]), schema.text('c$')])
    const tr = r.view.state.tr.replaceWith(0, r.view.state.doc.content.size, paragraph)
    r.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 5)))
    expect(autoFraction(r.view, '\\frac')).toBe(false)
    expect(r.view.state.doc.firstChild!.child(1).marks[0].type.name).toBe('code')
  })
  it('requires explicit opt-in for prose automatic snippets, preserves manual prose', () => {
    const r = rig('m|', { prose: true }); expect(r.type('k')).toBe(true); expect(r.text()).toBe('$$')
    const m = rig('hello|', { snippets: [{ trigger: 'hello', replacement: 'world', options: 't' }] })
    expect(m.engine.expandManual(m.view)).toBe(true); expect(m.text()).toBe('world')
  })
  it('uses visual defaults only on an in-math selection', () => {
    const r = rig('$x|$', { select: 2 }); expect(r.type('U')).toBe(true); expect(r.text()).toBe('$\\underbrace{ x }_{ }$')
    const noSelection = rig('$|$'); expect(noSelection.type('U')).toBe(false)
    const crosses = rig('text $x|$', { select: 1 }); expect(crosses.type('U')).toBe(false)
  })
  it('keeps hardbreak positions and supports multiline block math', () => {
    const r = rig('$$\n@|\n$$', { hardbreak: true }); expect(r.type('a')).toBe(true)
    expect(r.text()).toContain('\\alpha'); expect(r.view.state.doc.firstChild!.child(1).type.name).toBe('hard_break')
  })
  it('does not split inline math across a hardbreak', () => {
    const r = rig('$a\n@|$', { hardbreak: true }); expect(r.type('a')).toBe(false)
  })
  it('does not expand prose snippets in text macro arguments by default', () => {
    const r = rig('$\\text{m|}$'); expect(r.type('k')).toBe(false)
  })
  it('preserves IME composition and multi-character insertions', () => {
    const r = rig('$@|$'); Object.defineProperty(r.view, 'composing', { value: true }); expect(r.type('a')).toBe(false)
    expect(rig('$|$').type('@a')).toBe(false)
  })
  it('walks fraction tabstops and can return with Shift+Tab', () => {
    const r = rig('$/|$'); r.type('/'); expect(r.text()).toBe('$\\frac{}{}$')
    r.type('a'); expect(r.tabs.cycle(r.view, 1)).toBe(true); r.type('b')
    expect(r.text()).toBe('$\\frac{a}{b}$'); expect(r.tabs.cycle(r.view, -1)).toBe(true)
    expect(r.view.state.doc.textBetween(r.view.state.selection.from, r.view.state.selection.to)).toBe('a')
  })
  it('restores literal trigger including selected defaults and preceding bracket enlargement', () => {
    const r = rig('$(/|)$', { enlarge: true }); r.type('/'); expect(r.text()).toContain('\\left')
    expect(r.engine.undoExpansion(r.view)).toBe(true); expect(r.text()).toBe('$(//)$')
    const d = rig('$zz|$', { snippets: [{ trigger: 'zzx', replacement: '${0:default}', options: 'mA' }] })
    d.type('x'); expect(d.view.state.selection.empty).toBe(false)
    expect(d.engine.undoExpansion(d.view)).toBe(true); expect(d.text()).toBe('$zzx$')
  })
  it('restoration retains an outer fraction tabstop session', () => {
    const r = rig('$/|$'); r.type('/'); r.type('@'); r.type('a')
    expect(r.engine.undoExpansion(r.view)).toBe(true)
    expect(r.text()).toBe('$\\frac{@a}{}$')
    expect(r.tabs.cycle(r.view, 1)).toBe(true)
    r.type('z'); expect(r.text()).toBe('$\\frac{@a}{z}$')
  })
  it('restoration mirrors the full literal trigger into linked placeholders', () => {
    const r = rig('$x|$', { snippets: [
      { trigger: 'xx', replacement: '$0 + $0$1', options: 'mA' },
      { trigger: '@a', replacement: '\\alpha', options: 'mA' },
    ] })
    r.type('x'); r.type('@'); r.type('a')
    expect(r.text()).toBe('$\\alpha + \\alpha$')
    expect(r.engine.undoExpansion(r.view)).toBe(true)
    expect(r.text()).toBe('$@a + @a$')
    expect(r.tabs.hasActive(r.view.state)).toBe(true)
  })
  it('never restores over subsequent document changes', () => {
    const r = rig('$@|$'); r.type('a'); r.view.dispatch(r.view.state.tr.insertText(' changed', r.view.state.doc.content.size - 1))
    expect(r.engine.undoExpansion(r.view)).toBe(false); expect(r.text()).toContain('changed')
  })
  it('matrix Enter adds a row, Shift+Enter exits to after matching end', () => {
    const r = rig('$$\n\\begin{pmatrix} a| \\end{pmatrix}\n$$', { hardbreak: true })
    expect(matrixShortcut(r.view, 'Enter')).toBe(true); expect(r.text()).toContain(' \\\\ ')
    expect(exitMatrix(r.view)).toBe(true)
    expect(r.view.state.doc.textBetween(1, r.view.state.selection.from)).toContain('\\end{pmatrix}')
  })
  it('separates adjacent equation insertion', () => {
    const r = rig('$x$|'); expect(enterInlineMath(r.view)).toBe(true); expect(r.text()).toBe('$x$ $$')
  })
})

describe('compatibility: right-hand matching and safety', () => {
  it('consumes string triggerAfter only if the suffix matches', () => {
    const snippets: RawSnippet[] = [{ trigger: 'ab', triggerAfter: 'cd', replacement: 'X', options: 'mA' }]
    const r = rig('$a|cd$', { snippets }); expect(r.type('b')).toBe(true); expect(r.text()).toBe('$X$')
    expect(rig('$a|no$', { snippets }).type('b')).toBe(false)
  })
  it('anchors regex triggerAfter and preserves only left captures', () => {
    const r = rig('$a|cd$', { snippets: [{ trigger: /(a)b/, triggerAfter: /(c)d/, replacement: '[[0]]', options: 'mA' }] })
    expect(r.type('b')).toBe(true); expect(r.text()).toBe('$a$')
  })
  it('cannot consume delimiters or marked code through triggerAfter', () => {
    const r = rig('$a|$ trailing', { snippets: [{ trigger: 'ab', triggerAfter: '$ trailing', replacement: 'X', options: 'mA' }] })
    expect(r.type('b')).toBe(false)
  })
  it('reports unsupported modes instead of broadening their scope', () => {
    expect(parseSnippets('[{trigger:"x",replacement:"y",options:"TA"}]', {}).errors).toHaveLength(1)
  })
})
