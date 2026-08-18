// features/ 的行为台架 —— 四个编辑器特性 + 编辑器命令的边界条件。
//
// 为什么用假 ProseMirror 而不是真的:插件在宿主里是被 `new Function` 求值的,运行时根本没有
// prosemirror 模块图。这些特性也从不碰节点树 —— 它们只跟「一根字符串 + 一个光标偏移」打交道
// (那正是 editor/text.ts 这层适配的意义)。所以造一个够 blockTextAt / replaceInBlock /
// textSelectionAt 跑起来的替身就够了,而且跑得飞快、不需要浏览器。
//
// 写断言的姿势:`run(文本, 光标, 动作)` 回报 `[返回值, 结果文本]`,结果里用 `|` 标光标、
// `[...]` 标选区 —— 一眼能看出光标落在哪,不用心算偏移。

import { describe, expect, it } from 'vitest'
import { setTextSelectionCtor } from '../src/editor/text'
import {
  autoEnlargeBrackets,
  autoFraction,
  boxCurrentEquation,
  enterBlockMath,
  enterInlineMath,
  matrixShortcut,
  selectCurrentEquation,
  tabout,
  taboutByEnclosedBrackets,
  tokenize,
} from '../src/features'

// 替身对象一律 any:刻意不去实现 ProseMirror 的完整类型,那样台架会比被测代码还长。

setTextSelectionCtor({
  create: (_doc: any, a: number, h?: number) => ({ from: Math.min(a, h ?? a), to: Math.max(a, h ?? a) }),
  near: () => ({}),
} as any)

/** 文档 = 一个 textblock,base 恒为 1(docPos = 1 + textOffset)。 */
class Doc {
  constructor(public text: string) {}
  get content(): { size: number } {
    return { size: this.text.length + 2 }
  }
}

class Tr {
  constructor(public doc: Doc, public selection: any) {}
  replaceWith(a: number, b: number, node: any): this {
    this.doc = new Doc(this.doc.text.slice(0, a - 1) + node.text + this.doc.text.slice(b - 1))
    return this
  }
  delete(a: number, b: number): this {
    this.doc = new Doc(this.doc.text.slice(0, a - 1) + this.doc.text.slice(b - 1))
    return this
  }
  setSelection(s: any): this {
    this.selection = s
    return this
  }
  scrollIntoView(): this {
    return this
  }
}

function makeState(text: string, from: number, to: number, code: boolean): any {
  const node = {
    isTextblock: true,
    type: { spec: { code }, name: code ? 'code_block' : 'paragraph' },
    forEach: (f: any) => f({ isText: true, text }),
  }
  const $ = (o: number) => ({ parent: node, parentOffset: o, start: () => 1, sameParent: () => true })
  return {
    doc: new Doc(text),
    schema: { text: (s: string) => ({ text: s }) },
    selection: { $from: $(from), $to: $(to), from: 1 + from, to: 1 + to },
    get tr(): Tr {
      return new Tr(this.doc, { from: 1 + from, to: 1 + to })
    },
  }
}

function makeView(text: string, from: number, to = from, code = false): any {
  const view: any = { composing: false, state: makeState(text, from, to, code) }
  view.dispatch = (tr: Tr) => {
    view.state = makeState(tr.doc.text, tr.selection.from - 1, tr.selection.to - 1, code)
  }
  return view
}

/** 跑一个动作,回报 [返回值, 结果文本]。`sel` 给定时表示带选区(sel..cur)。 */
function run(text: string, cur: number, act: (v: any) => unknown, sel?: number): [unknown, string] {
  const a0 = sel === undefined ? cur : Math.min(sel, cur)
  const b0 = sel === undefined ? cur : Math.max(sel, cur)
  const view = makeView(text, a0, b0)
  const r = act(view)
  const t: string = view.state.doc.text
  const a: number = view.state.selection.from - 1
  const b: number = view.state.selection.to - 1
  return [r, a === b ? `${t.slice(0, a)}|${t.slice(a)}` : `${t.slice(0, a)}[${t.slice(a, b)}]${t.slice(b)}`]
}

describe('tokenize', () => {
  it('多字符命令是一个 token', () => {
    expect(tokenize('\\rangle x').map((t) => t.text)).toEqual(['\\rangle', 'x'])
  })
  it('转义符号是一个 token', () => {
    expect(tokenize('\\{a\\}').map((t) => t.text)).toEqual(['\\{', 'a', '\\}'])
  })
  it('末尾孤立反斜杠不越界(上游在这里会读到 undefined 并当成字母)', () => {
    expect(tokenize('a\\').map((t) => t.text)).toEqual(['a', '\\'])
  })
})

describe('tabout', () => {
  it('跳出最近一层花括号', () => {
    expect(run('$\\frac{ab}{c}$', 9, tabout)).toEqual([true, '$\\frac{ab}|{c}$'])
  })
  it('到公式正文末尾时跳出 $', () => {
    expect(run('$\\frac{ab}{c}$', 13, tabout)).toEqual([true, '$\\frac{ab}{c}$|'])
  })
  it('光标后面还有内容就不跳出公式(exitOnlyOnEOL)', () => {
    expect(run('$x y$', 2, tabout)).toEqual([false, '$x| y$'])
  })
  it('\\left| 的 | 是左定界符,不当成可跳的右边', () => {
    expect(run('$\\left|x\\right|+1$', 8, tabout)).toEqual([true, '$\\left|x\\right||+1$'])
  })
  it('\\right 后面缺定界符 → 光标停到错误处让人补', () => {
    expect(run('$(x\\right$', 8, tabout)).toEqual([true, '$(x\\right|$'])
  })
  it('不在公式里 / 公式未闭合 → 放行', () => {
    expect(run('hello', 3, tabout)).toEqual([false, 'hel|lo'])
    expect(run('$x+y', 4, tabout)).toEqual([false, '$x+y|'])
  })
  it('taboutByEnclosedBrackets 只认没配对的右括号', () => {
    expect(taboutByEnclosedBrackets('ab) & c')).toBe(3)
    expect(taboutByEnclosedBrackets('(ab) & c')).toBe(null)
    expect(taboutByEnclosedBrackets('a & b')).toBe(null)
  })
})

describe('autoFraction', () => {
  const AF = (v: any): boolean => autoFraction(v, '\\frac')

  it('取空格之后的那一项', () => {
    expect(run('$x + y$', 6, AF)).toEqual([true, '$x + \\frac{y}{|}$'])
  })
  it('整对括号连内容一起吃进来,外层括号剥掉', () => {
    expect(run('$(a+b)$', 6, AF)).toEqual([true, '$\\frac{a+b}{|}$'])
  })
  it('嵌套括号不剥内层', () => {
    expect(run('$f((a))$', 7, AF)).toEqual([true, '$\\frac{f((a))}{|}$'])
  })
  it('希腊字母后面的空格不算项边界', () => {
    expect(run('$1 + \\alpha x$', 13, AF)).toEqual([true, '$1 + \\frac{\\alpha x}{|}$'])
  })
  it('分子为空时光标进第一对花括号', () => {
    expect(run('$()$', 3, AF)).toEqual([true, '$\\frac{|}{}$'])
  })
  it('选区就是分子', () => {
    expect(run('$abc$', 4, AF, 1)).toEqual([true, '$\\frac{abc}{|}$'])
  })
  it('上标 ^{} 里不触发(除号是真的除号)', () => {
    expect(run('$x^{1}$', 5, AF)).toEqual([false, '$x^{1|}$'])
  })
  it('\\text{} 里不触发', () => {
    expect(run('$\\text{a b}$', 10, AF)).toEqual([false, '$\\text{a b|}$'])
  })
  it('前面没东西可当分子就放行', () => {
    expect(run('$ $', 2, AF)).toEqual([false, '$ |$'])
    expect(run('a/b', 3, AF)).toEqual([false, 'a/b|'])
  })
})

describe('matrixShortcut', () => {
  const TAB = (v: any): boolean => matrixShortcut(v, 'Tab')
  const ENT = (v: any): boolean => matrixShortcut(v, 'Enter')

  it('Tab 加单元格', () => {
    expect(run('$\\begin{pmatrix}a\\end{pmatrix}$', 17, TAB)).toEqual([true, '$\\begin{pmatrix}a & |\\end{pmatrix}$'])
  })
  it('Enter 换行用 \\\\(不插真换行,见文件头)', () => {
    expect(run('$\\begin{pmatrix}a\\end{pmatrix}$', 17, ENT)).toEqual([true, '$\\begin{pmatrix}a \\\\ |\\end{pmatrix}$'])
  })
  it('光标被括号包着时 Tab 先跳出括号,不加单元格', () => {
    expect(run('$\\begin{cases}(a)\\end{cases}$', 16, TAB)).toEqual([true, '$\\begin{cases}(a)|\\end{cases}$'])
  })
  it('环境不在名单里 / 不在环境里 → 放行', () => {
    expect(run('$\\begin{foo}a\\end{foo}$', 12, TAB)).toEqual([false, '$\\begin{foo}|a\\end{foo}$'])
    expect(run('$a$', 2, TAB)).toEqual([false, '$a|$'])
  })
})

describe('autoEnlargeBrackets', () => {
  const EN = (v: any): boolean => {
    autoEnlargeBrackets(v)
    return true
  }

  it('含 \\sum 的括号变成 \\left( \\right),光标不被推出括号', () => {
    expect(run('$(\\sum_i x)$', 10, EN)).toEqual([true, '$\\left( \\sum_i x| \\right)$'])
  })
  it('已经放大过就不再动(幂等)', () => {
    expect(run('$\\left( \\sum_i x \\right)$', 16, EN)).toEqual([true, '$\\left( \\sum_i x| \\right)$'])
  })
  it('分组花括号不放大', () => {
    expect(run('$\\frac{\\sum_i x}{2}$', 15, EN)).toEqual([true, '$\\frac{\\sum_i x|}{2}$'])
  })
  it('没有触发词就不动', () => {
    expect(run('$(x+1)$', 5, EN)).toEqual([true, '$(x+1|)$'])
  })
  it('公式还没闭合时也要能配对(片段展开的常态)', () => {
    expect(run('$(\\sum_i x)', 10, EN)).toEqual([true, '$\\left( \\sum_i x| \\right)'])
  })
})

describe('editorCommands', () => {
  it('boxCurrentEquation', () => {
    expect(run('$x+1$', 3, boxCurrentEquation)).toEqual([true, '$\\boxed{x+|1}$'])
    expect(run('$x+1', 3, boxCurrentEquation)).toEqual([false, '$x+|1'])
  })
  it('selectCurrentEquation 不带上首尾空白', () => {
    expect(run('$$ x + 1 $$', 5, selectCurrentEquation)).toEqual([true, '$$ [x + 1] $$'])
  })
  it('enterInlineMath', () => {
    expect(run('ab', 2, enterInlineMath)).toEqual([true, 'ab$|$'])
    expect(run('abc', 3, enterInlineMath, 1)).toEqual([true, 'a$bc|$'])
  })
  it('已经在公式里就不再套一层(否则定界符插花,公式作废)', () => {
    expect(run('$x+1$', 3, enterInlineMath)).toEqual([false, '$x+|1$'])
    expect(run('$x+1$', 3, enterBlockMath)).toEqual([false, '$x+|1$'])
  })
  it('enterBlockMath 插单行 $$  $$(带 \\n 的形态在 Amadeus 里是死公式,见 editorCommands.ts)', () => {
    expect(run('', 0, enterBlockMath)).toEqual([true, '$$ | $$'])
  })
})
