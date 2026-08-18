// tabout / 自动分式 / 矩阵 对着**真 ProseMirror 状态**跑。
//
// 为什么单独一份:这几个特性的入口都是 `(view) => boolean`,只有拿真的 EditorState 喂进去
// 才知道它到底返回了 true 还是 false。真机台架里「Tab 什么都没发生」有两种可能 ——
// 我的处理器没接(返回 false,宿主随后吞掉了 Tab),或者接了但算错了位置。
// 隔着浏览器分不出这两种;在这里一眼就能分出来。
import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state'
import { Schema } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { setTextSelectionCtor } from '../src/editor/text'
import { tabout, autoFraction, matrixShortcut } from '../src/features'

setTextSelectionCtor(TextSelection)

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
})

/** 造一个「文本 + 光标在 | 处」的编辑器状态。 */
function mk(withCaret: string) {
  const caret = withCaret.indexOf('|')
  const text = withCaret.replace('|', '')
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [schema.node('paragraph', null, text ? [schema.text(text)] : [])]),
  })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + caret)))
  const view = {
    get state() { return state },
    dispatch(tr: Transaction) { state = state.apply(tr) },
    composing: false,
  } as unknown as EditorView
  return {
    view,
    /** 结果串,光标位置用 | 标出来 —— 断言「光标跑哪去了」比断言纯文本有用得多。 */
    out() {
      const t = state.doc.textBetween(1, state.doc.content.size - 1, '\n')
      const c = state.selection.from - 1
      return t.slice(0, c) + '|' + t.slice(c)
    },
  }
}

describe('tabout', () => {
  it('从花括号里跳到 } 外面', () => {
    const e = mk('$\\frac{a}{xyz|}$')
    expect(tabout(e.view)).toBe(true)
    expect(e.out()).toBe('$\\frac{a}{xyz}|$')
  })
  it('已在最外层 → 跳出整条公式', () => {
    const e = mk('$\\frac{a}{b}|$')
    expect(tabout(e.view)).toBe(true)
    expect(e.out()).toBe('$\\frac{a}{b}$|')
  })
  it('未闭合公式不接管 Tab(放行给宿主)', () => {
    const e = mk('$\\frac{a}{xyz|}')
    expect(tabout(e.view)).toBe(false)
  })
  it('不在公式里不接管', () => {
    expect(tabout(mk('普通一段话|').view)).toBe(false)
  })
  it('光标后面还有内容时不跳出整条公式(默认 exitOnlyOnEOL)', () => {
    const e = mk('$a|+b$')
    expect(tabout(e.view)).toBe(false)
  })
  it('exitOnlyOnEOL 关掉后就肯跳', () => {
    const e = mk('$a|+b$')
    expect(tabout(e.view, { exitOnlyOnEOL: false })).toBe(true)
    expect(e.out()).toBe('$a+b$|')
  })
  it('\\right) 也算右定界符', () => {
    const e = mk('$\\left(x|\\right)$')
    expect(tabout(e.view)).toBe(true)
    expect(e.out()).toBe('$\\left(x\\right)|$')
  })
})

describe('自动分式', () => {
  it('把前一项变成分式,光标进分母', () => {
    const e = mk('$a|$')
    expect(autoFraction(e.view, '\\frac')).toBe(true)
    expect(e.out()).toBe('$\\frac{a}{|}$')
  })
  it('括号整段进分子,外层括号被剥掉', () => {
    const e = mk('$(a+b)|$')
    expect(autoFraction(e.view, '\\frac')).toBe(true)
    expect(e.out()).toBe('$\\frac{a+b}{|}$')
  })
  it('遇到运算符就断开,只吃最后一项', () => {
    const e = mk('$x+ab|$')
    expect(autoFraction(e.view, '\\frac')).toBe(true)
    expect(e.out()).toBe('$x+\\frac{ab}{|}$')
  })
  it('前面没东西时不接管', () => {
    expect(autoFraction(mk('$|$').view, '\\frac')).toBe(false)
  })
  it('\\text{} 里的 / 是普通斜杠', () => {
    expect(autoFraction(mk('$\\text{和/或 a|}$').view, '\\frac')).toBe(false)
  })
  it('正文里不接管', () => {
    expect(autoFraction(mk('日期 2026|').view, '\\frac')).toBe(false)
  })
})

describe('矩阵快捷', () => {
  it('环境里 Tab 插入 &', () => {
    const e = mk('$$\\begin{pmatrix}a|\\end{pmatrix}$$')
    expect(matrixShortcut(e.view, 'Tab')).toBe(true)
    expect(e.out()).toContain('a & |') // 插的是 ` & `,两边带空格(读起来舒服,LaTeX 无所谓)
  })
  it('环境里回车插入换行符', () => {
    const e = mk('$$\\begin{pmatrix}a|\\end{pmatrix}$$')
    expect(matrixShortcut(e.view, 'Enter')).toBe(true)
    expect(e.out()).toContain('\\\\')
  })
  it('不在这些环境里就不接管', () => {
    expect(matrixShortcut(mk('$a|$').view, 'Tab')).toBe(false)
  })
})
