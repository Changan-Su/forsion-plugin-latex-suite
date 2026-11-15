// 占位跳转与上游 obsidian-latex-suite 逐键对齐。
//
// 期望值不是推出来的:每一行都是在 Obsidian 1.15 + 上游 Latex Suite 1.12.8(全部缺省设置)里
// 真按键得到的光标落点与画出来的占位标记,原样抄过来。跑的是和真编辑器同一条按键链
// (src/keys.ts:手动片段 → 占位跳转 → 矩阵 → 跳出公式 → 放行)+ 默认片段表 + 真 ProseMirror。
//
// 记号:`|` 光标,`«…»` 选区;第三列是画出来的占位标记,`·` = 空格的点线,`[…]` = 有字格的底色框。
// `pass` = 插件没接这一下(Obsidian 里落成一个制表符;Forsion 里交给宿主)。

import { describe, expect, it } from 'vitest'
import { Schema, Slice, Fragment } from 'prosemirror-model'
import { EditorState, Plugin, PluginKey, TextSelection, Selection, NodeSelection, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { keymap } from 'prosemirror-keymap'
import { InputRule, inputRules } from 'prosemirror-inputrules'
import { createEngine } from '../src/editor/expand'
import { createTabstops } from '../src/editor/tabstops'
import { setTextSelectionCtor } from '../src/editor/text'
import { normalizeSnippets, type RawSnippet } from '../src/snippets/parse'
import { DEFAULT_SNIPPETS } from '../src/snippets/defaults'
import { DEFAULT_SNIPPET_VARIABLES } from '../src/snippets/variables'
import { mergeSettings, splitList, type LatexSuiteSettings } from '../src/settingsUi/model'
import { autoEnlargeBrackets } from '../src/features'
import { createKeyHandlers } from '../src/keys'

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' },
  hard_break: { inline: true, group: 'inline' }, text: { group: 'inline' },
} })
const pm = { Plugin, PluginKey, TextSelection, Selection, NodeSelection, Decoration, DecorationSet, Slice, Fragment, keymap, InputRule, inputRules }
setTextSelectionCtor(TextSelection)

// widget 装饰在 node 下要 document.createElement;单测只看位置,不需要真 DOM。
if (typeof globalThis.document === 'undefined') {
  ;(globalThis as unknown as { document: unknown }).document = { createElement: () => ({ className: '' }) }
}

function rig(source: string, overrides: Partial<LatexSuiteSettings> = {}, raw: RawSnippet[] = DEFAULT_SNIPPETS) {
  const pos = source.indexOf('|')
  const text = source.replace('|', '')
  const children = text.split('\n').flatMap((line, i) => [...(i ? [schema.node('hard_break')] : []), ...(line ? [schema.text(line)] : [])])
  const doc = schema.node('doc', null, [schema.node('paragraph', null, children)])
  const settings = mergeSettings({ ...overrides })
  const tabstops = createTabstops(pm)
  let state = EditorState.create({ schema, doc, plugins: [tabstops.plugin], selection: TextSelection.create(doc, pos + 1) })
  const view = {
    composing: false,
    editable: true,
    get state() { return state },
    dispatch(tr: Transaction) { state = state.apply(tr) },
  } as unknown as EditorView
  const snippets = normalizeSnippets(raw, DEFAULT_SNIPPET_VARIABLES).snippets
  const enlarge = (v: EditorView): void => autoEnlargeBrackets(v, { triggers: splitList(settings.autoEnlargeBracketsTriggers), space: settings.autoEnlargeBracketsSpace })
  const engine = createEngine(pm, tabstops, () => snippets, () => ({
    proseSnippetsEnabled: settings.proseSnippetsEnabled,
    wordDelimiters: settings.wordDelimiters,
    removeSnippetWhitespace: settings.removeSnippetWhitespace,
    autoEnlargeBrackets: settings.autoEnlargeBrackets,
    autoEnlargeBracketsTriggers: splitList(settings.autoEnlargeBracketsTriggers),
    maxRecursion: settings.snippetRecursion,
  }), enlarge)
  const keys = createKeyHandlers({ settings: () => settings, ready: () => true, paused: () => false, engine, tabstops, enlarge })

  const blockText = (from: number, to: number): string => state.doc.textBetween(from, to, '\n', '\n')
  /** 光标所在 textblock 的文本,`|` / «» 标出选区。 */
  const line = (): string => {
    const sel = state.selection
    const $f = sel.$from
    const start = $f.start(), end = $f.end()
    const a = blockText(start, sel.from), b = blockText(sel.to, end)
    return sel.empty ? `${a}|${b}` : `${a}«${blockText(sel.from, sel.to)}»${b}`
  }
  /** 同一 textblock 里画出来的占位标记:`·` 点线、`[…]` 底色框。 */
  const marks = (): { text: string; colors: number[] } => {
    const $f = state.selection.$from
    const start = $f.start(), end = $f.end()
    const decos = tabstops.key.getState(state)!.decos.find(start, end)
    const at = new Map<number, { close: number; field: number; open: number }>()
    const slot = (p: number) => at.get(p) ?? (at.set(p, { close: 0, field: 0, open: 0 }), at.get(p)!)
    const colors: number[] = []
    for (const d of [...decos].sort((x, y) => x.from - y.from)) {
      if (d.from === d.to) slot(d.from).field++
      else {
        slot(d.from).open++
        slot(d.to).close++
        const cls = String((d as unknown as { type: { attrs: { class: string } } }).type.attrs.class)
        colors.push(Number(/placeholder-(\d)/.exec(cls)?.[1]))
      }
    }
    let text = ''
    for (let p = start; p <= end; p++) {
      const m = at.get(p)
      if (m) text += ']'.repeat(m.close) + '·'.repeat(m.field) + '['.repeat(m.open)
      if (p < end) text += blockText(p, p + 1)
    }
    return { text, colors }
  }

  const input = (step: string): boolean | null => {
    if (step === 'Tab' || step === 'S-Tab') {
      const before = state.doc
      const handled = keys.handleKeyDown(view, { key: 'Tab', shiftKey: step === 'S-Tab', ctrlKey: false, metaKey: false, altKey: false, isComposing: false })
      if (!handled) expect(state.doc.eq(before)).toBe(true)
      return handled
    }
    if (step === '→') {
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, state.selection.to + 1)))
      return null
    }
    if (step.startsWith('click:')) {
      // 鼠标点 = 一笔只设选区的事务,落在锚点文字后面。
      const needle = step.slice(6)
      const $f = state.selection.$from
      const idx = blockText($f.start(), $f.end()).indexOf(needle)
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, $f.start() + idx + needle.length)))
      return null
    }
    for (const ch of step) {
      const { from, to } = state.selection
      if (!keys.handleTextInput(view, from, to, ch)) {
        // 宿主默认的打字:插入并把光标放到字后面(真编辑器从 DOM 读回选区,也是 selectionSet)。
        const tr = state.tr.insertText(ch, from, to)
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1)))
      }
    }
    return null
  }

  return { input, line, marks, hasActive: () => tabstops.hasActive(state), get state() { return state } }
}

type Step = [input: string, line: string, marks?: string]

function play(seed: string, steps: Step[], overrides: Partial<LatexSuiteSettings> = {}): ReturnType<typeof rig> {
  const r = rig(seed, overrides)
  for (const [i, [inp, want, wantMarks]] of steps.entries()) {
    const handled = r.input(inp)
    const label = `step ${i} (${inp})`
    if (want === 'pass') {
      expect(handled, label).toBe(false)
      continue
    }
    if (inp === 'Tab' || inp === 'S-Tab') expect(handled, label).toBe(true)
    expect(r.line(), label).toBe(want)
    if (wantMarks !== undefined) expect(r.marks().text, `${label} marks`).toBe(wantMarks)
    else expect(r.hasActive(), `${label} cleared`).toBe(false)
  }
  return r
}

describe('占位跳转与 Obsidian 逐键一致', () => {
  it('T1b 用户原样:$$ $$ 里 t({n_j 再连按 Tab', () => {
    play('$$ | $$', [
      ['t', '$$ t| $$', '$$ t $$'],
      ['(', '$$ t(|) $$', '$$ t()· $$'],
      ['{', '$$ t({|}) $$', '$$ t({}·)· $$'],
      ['n', '$$ t({n|}) $$', '$$ t({n}·)· $$'],
      ['_', '$$ t({n_{|}}) $$', '$$ t({n_{}·}·)· $$'],
      ['j', '$$ t({n_{j|}}) $$', '$$ t({n_{j}·}·)· $$'],
      ['Tab', '$$ t({n_{j}|}) $$', '$$ t({n_{j}·}·)· $$'],
      ['Tab', '$$ t({n_{j}}|) $$', '$$ t({n_{j}·}·)· $$'],
      ['Tab', '$$ t({n_{j}})| $$'],
      ['Tab', '$$ t({n_{j}}) $$|'],
    ])
  })

  it('T1b-EOLfalse 用户设置(只在行尾才跳出公式 = 关)下同样的落点', () => {
    play('$$ | $$', [
      ['t({n_j', '$$ t({n_{j|}}) $$', '$$ t({n_{j}·}·)· $$'],
      ['Tab', '$$ t({n_{j}|}) $$', '$$ t({n_{j}·}·)· $$'],
      ['Tab', '$$ t({n_{j}}|) $$', '$$ t({n_{j}·}·)· $$'],
      ['Tab', '$$ t({n_{j}})| $$'],
      ['Tab', '$$ t({n_{j}}) $$|'],
    ], { taboutExitEquationOnlyOnEOL: false })
  })

  it('T1a 正文 dm 建多行块公式再打 t({n_j', () => {
    play('|', [
      ['dm', '$$\n|\n$$'],
      ['t({n_j', '$$\nt({n_{j|}})\n$$', '$$\nt({n_{j}·}·)·\n$$'],
      ['Tab', '$$\nt({n_{j}|})\n$$', '$$\nt({n_{j}·}·)·\n$$'],
      ['Tab', '$$\nt({n_{j}}|)\n$$', '$$\nt({n_{j}·}·)·\n$$'],
      ['Tab', '$$\nt({n_{j}})|\n$$'],
    ], { proseSnippetsEnabled: true })
  })

  it('T2 字面花括号 t(\\{n_j\\}),右括号打穿后再 Tab', () => {
    play('$$ | $$', [
      ['t(\\', '$$ t(\\|) $$', '$$ t(\\)· $$'],
      ['{', '$$ t(\\{|}) $$', '$$ t(\\{}·)· $$'],
      ['n_j', '$$ t(\\{n_{j|}}) $$', '$$ t(\\{n_{j}·}·)· $$'],
      ['\\', '$$ t(\\{n_{j\\|}}) $$', '$$ t(\\{n_{j\\}·}·)· $$'],
      ['}', '$$ t(\\{n_{j\\}|}) $$', '$$ t(\\{n_{j\\}·}·)· $$'],
      [')', '$$ t(\\{n_{j\\})|}) $$', '$$ t(\\{n_{j\\}[)]}·)· $$'],
      ['Tab', '$$ t(\\{n_{j\\})}|) $$', '$$ t(\\{n_{j\\}[)]}·)· $$'],
      ['Tab', '$$ t(\\{n_{j\\})})| $$'],
      ['Tab', '$$ t(\\{n_{j\\})}) $$|'],
      ['Tab', 'pass'],
    ])
  })

  it('T2b / T2c 字面花括号:打穿右括号落到外层格上', () => {
    play('$$ | $$', [
      ['t(\\{n\\', '$$ t(\\{n\\|}) $$', '$$ t(\\{n\\}·)· $$'],
      ['}', '$$ t(\\{n\\}|) $$', '$$ t(\\{n\\}·)· $$'],
      [')', '$$ t(\\{n\\})| $$'],
      ['Tab', '$$ t(\\{n\\}) $$|'],
      ['Tab', 'pass'],
    ])
    play('$$ | $$', [
      ['t(\\{n_j', '$$ t(\\{n_{j|}}) $$', '$$ t(\\{n_{j}·}·)· $$'],
      ['Tab', '$$ t(\\{n_{j}|}) $$', '$$ t(\\{n_{j}·}·)· $$'],
      ['\\', '$$ t(\\{n_{j}\\|}) $$', '$$ t(\\{n_{j}[\\]}·)· $$'],
      ['}', '$$ t(\\{n_{j}\\}|) $$', '$$ t(\\{n_{j}[\\]}·)· $$'],
      [')', '$$ t(\\{n_{j}\\})| $$'],
      ['Tab', '$$ t(\\{n_{j}\\}) $$|'],
    ])
  })

  it('T3b 正文 mk 建行内公式,再 // a Tab b Tab Tab', () => {
    const r = play('Para text|', [
      [' mk', 'Para text $|$'],
      ['/', 'Para text $/|$'],
      ['/', 'Para text $\\frac{|}{}$', 'Para text $\\frac{}{·}·$'],
      ['a', 'Para text $\\frac{a|}{}$', 'Para text $\\frac{a}{·}·$'],
      ['Tab', 'Para text $\\frac{a}{|}$', 'Para text $\\frac{a}{·}·$'],
      ['b', 'Para text $\\frac{a}{b|}$', 'Para text $\\frac{a}{[b]}·$'],
      ['Tab', 'Para text $\\frac{a}{b}|$'],
      ['Tab', 'Para text $\\frac{a}{b}$|'],
      ['Tab', 'pass'],
    ], { proseSnippetsEnabled: true })
    expect(r.hasActive()).toBe(false)
  })

  it('T3c 现成行内公式里 / 自动分式', () => {
    play('Para $x|$ end.', [
      ['/', 'Para $\\frac{x}{|}$ end.', 'Para $\\frac{x}{}·$ end.'],
      ['y', 'Para $\\frac{x}{y|}$ end.', 'Para $\\frac{x}{y}·$ end.'],
      ['Tab', 'Para $\\frac{x}{y}|$ end.'],
      ['Tab', 'Para $\\frac{x}{y}$| end.'],
    ])
  })

  it('T4 / T4-EOLfalse 没有片段时 Tab 一路跳出括号再跳出公式', () => {
    for (const eol of [true, false]) {
      play('$$ \\frac{a|}{b} $$', [
        ['Tab', '$$ \\frac{a}|{b} $$'],
        ['Tab', '$$ \\frac{a}{b}| $$'],
        ['Tab', '$$ \\frac{a}{b} $$|'],
      ], { taboutExitEquationOnlyOnEOL: eol })
    }
  })

  it('T6 / T6-EOLfalse 右边还有内容时', () => {
    play('$$ a| + b $$', [['Tab', 'pass'], ['Tab', 'pass']])
    play('$$ a| + b $$', [['Tab', '$$ a + b $$|'], ['Tab', 'pass']], { taboutExitEquationOnlyOnEOL: false })
  })

  it('T5a-f 单个片段:sr / @a / hat / xhat / lr( / 下标', () => {
    play('$$ x| $$', [['sr', '$$ x^{2}| $$'], ['Tab', '$$ x^{2} $$|'], ['Tab', 'pass']])
    play('$$ x| $$', [['@a', '$$ x\\alpha| $$'], ['Tab', '$$ x\\alpha $$|'], ['Tab', 'pass']])
    play('$$ x| $$', [
      [' hat', '$$ x \\hat{|} $$', '$$ x \\hat{}· $$'],
      ['y', '$$ x \\hat{y|} $$', '$$ x \\hat{y}· $$'],
      ['Tab', '$$ x \\hat{y}| $$'],
      ['Tab', '$$ x \\hat{y} $$|'],
    ])
    play('$$ | $$', [['xhat', '$$ \\hat{x}| $$'], ['Tab', '$$ \\hat{x} $$|'], ['Tab', 'pass']])
    // 与 Obsidian 唯一的差:替换文本里 `( $0 \right` 的两个空格被压成一个(宿主的 markdown 往返会压连续空格,
    // 不压的话整篇重载、占位全丢,见 tabstopParse 的 collapseSpaces)。落点与跳位顺序一致。
    play('$$ | $$', [
      ['lr(', '$$ \\left( |\\right)  $$', '$$ \\left( \\right) · $$'],
      ['x', '$$ \\left( x|\\right)  $$', '$$ \\left( x\\right) · $$'],
      ['Tab', '$$ \\left( x\\right) | $$'],
      ['Tab', '$$ \\left( x\\right)  $$|'],
    ])
    play('$$ | $$', [
      ['x3', '$$ x_{3}| $$'],
      [' y_', '$$ x_{3} y_{|} $$', '$$ x_{3} y_{}· $$'],
      ['k', '$$ x_{3} y_{k|} $$', '$$ x_{3} y_{k}· $$'],
      ['Tab', '$$ x_{3} y_{k}| $$'],
      ['Tab', '$$ x_{3} y_{k} $$|'],
    ])
  })

  it('T7 Shift+Tab 回到已填的格:整格选中,Tab 再整格选中下一格', () => {
    const r = play('$$ | $$', [
      ['//', '$$ \\frac{|}{} $$', '$$ \\frac{}{·}· $$'],
      ['a', '$$ \\frac{a|}{} $$', '$$ \\frac{a}{·}· $$'],
      ['Tab', '$$ \\frac{a}{|} $$', '$$ \\frac{a}{·}· $$'],
      ['b', '$$ \\frac{a}{b|} $$', '$$ \\frac{a}{[b]}· $$'],
      ['S-Tab', '$$ \\frac{«a»}{b} $$', '$$ \\frac{a}{[b]}· $$'],
      ['Tab', '$$ \\frac{a}{«b»} $$', '$$ \\frac{a}{[b]}· $$'],
      ['Tab', '$$ \\frac{a}{b}| $$'],
    ])
    expect(r.hasActive()).toBe(false)
  })

  it('T8 / T8b 带缺省文字的格:落上去整格选中', () => {
    play('$$ | $$', [
      ['sum', '$$ \\sum| $$'],
      ['Tab', '$$ \\sum_{«i»=1}^{N}  $$', '$$ \\sum_{i=[1]}^{[N]} · $$'],
      ['Tab', '$$ \\sum_{i=«1»}^{N}  $$', '$$ \\sum_{i=[1]}^{[N]} · $$'],
      ['Tab', '$$ \\sum_{i=1}^{«N»}  $$', '$$ \\sum_{i=[1]}^{[N]} · $$'],
      ['Tab', '$$ \\sum_{i=1}^{N} | $$'],
      ['Tab', '$$ \\sum_{i=1}^{N}  $$|'],
    ])
    play('$$ | $$', [
      ['lim', '$$ \\lim_{ «n» \\to \\infty }  $$', '$$ \\lim_{ n \\to [\\infty] } · $$'],
      ['Tab', '$$ \\lim_{ n \\to «\\infty» }  $$', '$$ \\lim_{ n \\to [\\infty] } · $$'],
      ['Tab', '$$ \\lim_{ n \\to \\infty } | $$'],
      ['Tab', '$$ \\lim_{ n \\to \\infty }  $$|'],
    ])
  })

  it('B2 行内公式里同一套', () => {
    play('Para $t|$ end.', [
      ['({n_j', 'Para $t({n_{j|}})$ end.', 'Para $t({n_{j}·}·)·$ end.'],
      ['Tab', 'Para $t({n_{j}|})$ end.', 'Para $t({n_{j}·}·)·$ end.'],
      ['Tab', 'Para $t({n_{j}}|)$ end.', 'Para $t({n_{j}·}·)·$ end.'],
      ['Tab', 'Para $t({n_{j}})|$ end.'],
      ['Tab', 'Para $t({n_{j}})$| end.'],
      ['Tab', 'pass'],
    ])
  })
})

describe('复核者补的场景(同样在 Obsidian 里实测)', () => {
  it('L 打完 j 先按 → 越过 },再 Tab:下标跟着光标走', () => {
    play('$$ | $$', [
      ['t({n_j', '$$ t({n_{j|}}) $$', '$$ t({n_{j}·}·)· $$'],
      ['→', '$$ t({n_{j}|}) $$', '$$ t({n_{j}·}·)· $$'],
      ['Tab', '$$ t({n_{j}}|) $$', '$$ t({n_{j}·}·)· $$'],
      ['Tab', '$$ t({n_{j}})| $$'],
      ['Tab', '$$ t({n_{j}}) $$|'],
    ])
  })

  it('M 最内层第一格 Shift+Tab:不接(交还编辑器),占位原样保留', () => {
    play('$$ | $$', [
      ['t({n_j', '$$ t({n_{j|}}) $$', '$$ t({n_{j}·}·)· $$'],
      ['S-Tab', 'pass'],
      ['Tab', '$$ t({n_{j}|}) $$', '$$ t({n_{j}·}·)· $$'],
      ['Tab', '$$ t({n_{j}}|) $$', '$$ t({n_{j}·}·)· $$'],
      ['Tab', '$$ t({n_{j}})| $$'],
    ])
    play('$$ | $$', [
      ['//a', '$$ \\frac{a|}{} $$', '$$ \\frac{a}{·}· $$'],
      ['Tab', '$$ \\frac{a}{|} $$', '$$ \\frac{a}{·}· $$'],
      ['S-Tab', '$$ \\frac{«a»}{} $$', '$$ \\frac{a}{·}· $$'],
      ['S-Tab', 'pass'],
      ['Tab', '$$ \\frac{a}{|} $$', '$$ \\frac{a}{·}· $$'],
      ['Tab', '$$ \\frac{a}{}| $$'],
      ['Tab', '$$ \\frac{a}{} $$|'],
    ])
  })

  it('N 鼠标点进后面的格再嵌套展开:新片段替换那一格,颜色换下一种', () => {
    const r = play('$$ | $$', [
      ['//a', '$$ \\frac{a|}{} $$', '$$ \\frac{a}{·}· $$'],
      ['click:}{', '$$ \\frac{a}{|} $$', '$$ \\frac{a}{·}· $$'],
      ['(', '$$ \\frac{a}{(|)} $$', '$$ \\frac{a}{(·)·}· $$'],
      ['b', '$$ \\frac{a}{(b|)} $$', '$$ \\frac{a}{([b])·}· $$'],
    ])
    expect(r.marks().colors).toEqual([1])
    for (const [inp, want] of [['Tab', '$$ \\frac{a}{(b)|} $$'], ['Tab', '$$ \\frac{a}{(b)}| $$'], ['Tab', '$$ \\frac{a}{(b)} $$|']]) {
      expect(r.input(inp)).toBe(true)
      expect(r.line()).toBe(want)
    }
  })

  it('G 停在最后一层的格里接着打字:格跟着长,再 Tab 落到外层最后一格并清表', () => {
    const r = play('$$ x| $$', [
      ['({a', '$$ x({a|}) $$', '$$ x({a}·)· $$'],
      ['Tab', '$$ x({a}|) $$', '$$ x({a}·)· $$'],
      ['+c', '$$ x({a}+c|) $$', '$$ x({a}[+c])· $$'],
      ['Tab', '$$ x({a}+c)| $$'],
      ['Tab', '$$ x({a}+c) $$|'],
      ['Tab', 'pass'],
    ])
    expect(r.hasActive()).toBe(false)
  })

  it('E 括号里 // 触发自动放大括号:分式后面那一格($2)还在', () => {
    play('$$ x| $$', [
      ['(//', '$$ x\\left( \\frac{|}{} \\right) $$', '$$ x\\left( \\frac{}{·}· \\right)· $$'],
      ['a', '$$ x\\left( \\frac{a|}{} \\right) $$', '$$ x\\left( \\frac{a}{·}· \\right)· $$'],
      ['Tab', '$$ x\\left( \\frac{a}{|} \\right) $$', '$$ x\\left( \\frac{a}{·}· \\right)· $$'],
      ['b', '$$ x\\left( \\frac{a}{b|} \\right) $$', '$$ x\\left( \\frac{a}{[b]}· \\right)· $$'],
      ['Tab', '$$ x\\left( \\frac{a}{b}| \\right) $$', '$$ x\\left( \\frac{a}{[b]}· \\right)· $$'],
      ['Tab', '$$ x\\left( \\frac{a}{b} \\right)| $$'],
      ['Tab', '$$ x\\left( \\frac{a}{b} \\right) $$|'],
      ['Tab', 'pass'],
    ])
  })

  it('J 三层嵌套 ({[a', () => {
    play('$$ x| $$', [
      ['({[a', '$$ x({[a|]}) $$', '$$ x({[a]·}·)· $$'],
      ['Tab', '$$ x({[a]|}) $$', '$$ x({[a]·}·)· $$'],
      ['Tab', '$$ x({[a]}|) $$', '$$ x({[a]·}·)· $$'],
      ['Tab', '$$ x({[a]})| $$'],
      ['Tab', '$$ x({[a]}) $$|'],
      ['Tab', 'pass'],
    ])
  })

  it('K 方向键挪出所有格 = 清表;之后在别处展开是一个新的表', () => {
    play('$$ x| $$', [
      [' //a', '$$ x \\frac{a|}{} $$', '$$ x \\frac{a}{·}· $$'],
      ['→', '$$ x \\frac{a}|{} $$'],
      ['→', '$$ x \\frac{a}{|} $$'],
      ['(b', '$$ x \\frac{a}{(b|)} $$', '$$ x \\frac{a}{(b)·} $$'],
      ['Tab', '$$ x \\frac{a}{(b)|} $$'],
      ['Tab', '$$ x \\frac{a}{(b)}| $$'],
      ['Tab', '$$ x \\frac{a}{(b)} $$|'],
    ])
  })
})

describe('同名占位联动(上游多光标的替代)', () => {
  const mirrored: RawSnippet[] = [
    { trigger: 'qq', replacement: '\\x{$0}{$1}[$1]', options: 'mA' },
    { trigger: 'ww', replacement: '\\y{$0}{$0}', options: 'mA' },
  ]
  it('Tab 落到最后一组且它有两处:清表后两处仍联动,光标离开才停', () => {
    const r = rig('$$ | $$', {}, mirrored)
    r.input('qq')
    expect(r.line()).toBe('$$ \\x{|}{}[] $$')
    expect(r.input('Tab')).toBe(true)
    expect(r.hasActive()).toBe(false)
    r.input('ab')
    expect(r.line()).toBe('$$ \\x{}{ab|}[ab] $$')
    r.input('→')
    r.input('→')
    r.input('c')
    expect(r.line()).toBe('$$ \\x{}{ab}[c|ab] $$')
  })
  it('只有一组(两处)的片段:展开即清表,打字仍两处同步', () => {
    const r = rig('$$ | $$', {}, mirrored)
    r.input('ww')
    expect(r.hasActive()).toBe(false)
    r.input('k')
    expect(r.line()).toBe('$$ \\y{k|}{k} $$')
  })
})
