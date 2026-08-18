// features 自审回归:逐条钉住一轮对着上游复核时揪出来的缺陷,防止改回去。
//
// 与 features.test.ts / tabout.test.ts 的分工:那两份覆盖「正常路径长什么样」,这份只覆盖
// **曾经错过的那些分支** —— 每个 it 对应一处具体缺陷,标题就是判据:
//   · 矩阵最内层作用域(只看环境栈会把 ` & ` 插进 \frac 的分子)
//   · 放大触发词补反斜杠(裸 `int` 会命中散文里的 point)
//   · 未闭合公式的扫描边界(一路扫到块尾会放大公式后面散文里的括号)
//   · 行内原子防线(读旧文本再插回去 = 把图片换成占位符字符,不可逆)
//   · 括号打穿 / 默认断词字符 / `\begin{x}` 形式的排除项
// 这里的 schema 特意带了一个 atom 节点(img):没有它,原子那条防线在测试里根本触发不到。
import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { Schema } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { setTextSelectionCtor } from '../src/editor/text'
import { matrixShortcut, autoEnlargeBrackets, taboutByCloseBracket, autoFraction } from '../src/features'
import { boxCurrentEquation, enterInlineMath } from '../src/features/editorCommands'

setTextSelectionCtor(TextSelection)

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    img: { inline: true, group: 'inline', atom: true, toDOM: () => ['img'] },
    text: { group: 'inline' },
  },
})

function mk(withCaret: string, anchorAt?: number) {
  const caret = withCaret.indexOf('|')
  const text = withCaret.replace('|', '')
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [schema.node('paragraph', null, text ? [schema.text(text)] : [])]),
  })
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, anchorAt != null ? 1 + anchorAt : 1 + caret, 1 + caret)),
  )
  const view = {
    get state() { return state },
    dispatch(tr: any) { state = state.apply(tr) },
    composing: false,
  } as unknown as EditorView
  return {
    view,
    out() {
      const t = state.doc.textBetween(1, state.doc.content.size - 1, '\n')
      const c = state.selection.from - 1
      return t.slice(0, c) + '|' + t.slice(c)
    },
    raw() { return state.doc.textBetween(1, state.doc.content.size - 1, '\n', '@') },
  }
}

/** 带一个行内原子(图片)的段落:text + img + text,光标/选区用文本偏移给。 */
function mkAtom(pre: string, post: string, from: number, to: number) {
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(pre), schema.node('img'), schema.text(post)]),
    ]),
  })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + from, 1 + to)))
  const view = {
    get state() { return state },
    dispatch(tr: any) { state = state.apply(tr) },
    composing: false,
  } as unknown as EditorView
  return { view, size: () => state.doc.nodeAt(0)!.childCount }
}

describe('矩阵:最内层作用域', () => {
  it('最里层是 \\frac 宏 → 放行(不该把 & 插进分子)', () => {
    const e = mk('$$\\begin{pmatrix}\\frac{a|}{b}\\end{pmatrix}$$')
    expect(matrixShortcut(e.view, 'Tab')).toBe(false)
  })
  it('最里层是环境 → 接管', () => {
    const e = mk('$$\\begin{pmatrix}a & b|\\end{pmatrix}$$')
    expect(matrixShortcut(e.view, 'Tab')).toBe(true)
  })
  it('裸 {} 分组透明', () => {
    const e = mk('$$\\begin{pmatrix}x^{a|}\\end{pmatrix}$$')
    expect(matrixShortcut(e.view, 'Tab')).toBe(true)
  })
  it('嵌套环境取最内层', () => {
    const e = mk('$$\\begin{align}\\begin{pmatrix}a|\\end{pmatrix}\\end{align}$$')
    expect(matrixShortcut(e.view, 'Tab')).toBe(true)
  })
  it('\\end 之后栈空 → 放行', () => {
    const e = mk('$$\\begin{pmatrix}a\\end{pmatrix}b|$$')
    expect(matrixShortcut(e.view, 'Tab')).toBe(false)
  })
  it('多参数宏:分母也算 \\frac 的地盘(Enter 不该把 \\\\ 插进分母)', () => {
    const e = mk('$$\\begin{pmatrix}\\frac{a}{b|}\\end{pmatrix}$$')
    expect(matrixShortcut(e.view, 'Enter')).toBe(false)
  })
  it('多参数宏:光标停在 }|{ 之间 → 人在参数之外', () => {
    const e = mk('$$\\begin{pmatrix}\\frac{a}|{b}\\end{pmatrix}$$')
    expect(matrixShortcut(e.view, 'Enter')).toBe(true)
  })
  it('多参数宏:两参数之间有空格就不续链(裸组保持透明)', () => {
    const e = mk('$$\\begin{pmatrix}\\text{x} {y|}\\end{pmatrix}$$')
    expect(matrixShortcut(e.view, 'Enter')).toBe(true)
  })
  it('宏名单默认含 eqalign', () => {
    const e = mk('$$\\eqalign{a|}$$')
    expect(matrixShortcut(e.view, 'Tab')).toBe(true)
  })
  it('宏名单可自定义,不在名单里放行', () => {
    const e = mk('$$\\eqalign{a|}$$')
    expect(matrixShortcut(e.view, 'Tab', undefined, { macros: [] })).toBe(false)
  })
})

describe('括号放大:触发词补反斜杠', () => {
  it('\\sum 触发', () => {
    const e = mk('$(\\sum_i x_i)|$')
    autoEnlargeBrackets(e.view)
    expect(e.out()).toBe('$\\left( \\sum_i x_i \\right)|$')
  })
  it('散文里的 point 不该命中 int', () => {
    const e = mk('$(point)|$')
    autoEnlargeBrackets(e.view)
    expect(e.out()).toBe('$(point)|$')
  })
  it('已经放大过 → 幂等', () => {
    const e = mk('$\\left( \\sum x \\right)|$')
    autoEnlargeBrackets(e.view)
    expect(e.out()).toBe('$\\left( \\sum x \\right)|$')
  })
  it('未闭合公式:扫描不越过杂散 $', () => {
    const e = mk('$(\\sum a|) more $ (\\int b)')
    autoEnlargeBrackets(e.view)
    expect(e.out()).toBe('$\\left( \\sum a| \\right) more $ (\\int b)')
  })
})

describe('括号打穿', () => {
  it('光标右边是 ) 时再打 ) → 跳过去', () => {
    const e = mk('$(a|)$')
    expect(taboutByCloseBracket(e.view, ')')).toBe(true)
    expect(e.out()).toBe('$(a)|$')
  })
  it('右边不是该键 → 放行', () => {
    const e = mk('$(a|)$')
    expect(taboutByCloseBracket(e.view, ']')).toBe(false)
  })
  it('正文里放行', () => {
    const e = mk('话(a|)')
    expect(taboutByCloseBracket(e.view, ')')).toBe(false)
  })
})

describe('行内原子防线', () => {
  it('插入行内公式:选区含图片 → 放弃', () => {
    // pre='ab'(0..2) img(2..3) post='cd'(3..5);选 1..4 跨过图片
    const e = mkAtom('ab', 'cd', 1, 4)
    expect(enterInlineMath(e.view)).toBe(false)
    expect(e.size()).toBe(3)
  })
  it('选区不含图片 → 照常插入', () => {
    const e = mkAtom('ab', 'cd', 0, 2)
    expect(enterInlineMath(e.view)).toBe(true)
  })
  it('加框:公式正文含图片 → 放弃', () => {
    // '$a' + img + 'b$',光标放在图片后
    const e = mkAtom('$a', 'b$', 3, 3)
    expect(boxCurrentEquation(e.view)).toBe(false)
    expect(e.size()).toBe(3)
  })
  it('自动分式:分子含图片 → 放弃', () => {
    const e = mkAtom('$a', 'b', 4, 4)
    expect(autoFraction(e.view, '\\frac')).toBe(false)
    expect(e.size()).toBe(3)
  })
})

describe('自动分式:排除项', () => {
  it('^{} 里的 / 不变分数', () => {
    const e = mk('$x^{a|}$')
    expect(autoFraction(e.view, '\\frac')).toBe(false)
  })
  it('\\begin{align} 形式的排除项也认', () => {
    const e = mk('$$\\begin{align}a|\\end{align}$$')
    expect(autoFraction(e.view, '\\frac', { excludedEnvs: ['\\begin{align}'] })).toBe(false)
    const e2 = mk('$$\\begin{align}a|\\end{align}$$')
    expect(autoFraction(e2.view, '\\frac', { excludedEnvs: [] })).toBe(true)
  })
  it('默认断词字符只有 +-=\\t', () => {
    const e = mk('$a<b|$')
    expect(autoFraction(e.view, '\\frac')).toBe(true)
    expect(e.out()).toBe('$\\frac{a<b}{|}$')
  })
})
