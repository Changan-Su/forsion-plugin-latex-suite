// 对着**真 ProseMirror** 跑 tabstop 状态机。
//
// 为什么必须有这一层:纯逻辑测试(core.test.ts)一条都抓不到位置映射的错。
// tabstop 的全部难点都在「文档改了之后位置怎么跟」——那只有让真的 Transaction 跑过才现形。
// 头一版就栽在这:范围变非空后偏置翻转,第二个字落到范围外,整帧被收尾条件弹掉,
// 表现是「Tab 跳一次就失灵」,而单测全绿。
import { describe, expect, it } from 'vitest'
import { EditorState, Plugin, PluginKey, Selection, TextSelection, NodeSelection, type Transaction } from 'prosemirror-state'
import { Schema, Slice, Fragment } from 'prosemirror-model'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { keymap } from 'prosemirror-keymap'
import { InputRule, inputRules } from 'prosemirror-inputrules'
import { createTabstops, toDocGroups } from '../src/editor/tabstops'
import { parseTabstops } from '../src/snippets/tabstopParse'
import type { PmToolkit } from '../types/forsion'

const pm = {
  Plugin, PluginKey, Selection, TextSelection, NodeSelection,
  Decoration, DecorationSet, Slice, Fragment, keymap, InputRule, inputRules,
} as unknown as PmToolkit

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
})

/** 造一个只挂了 tabstop 插件的编辑器状态,正文 = text。 */
function mk(text: string) {
  const tabstops = createTabstops(pm)
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [schema.node('paragraph', null, text ? [schema.text(text)] : [])]),
    plugins: [tabstops.plugin],
  })
  // 极简 view 替身:cycle() 只用到 state / dispatch;真 EditorView 要 DOM,单测里不值当。
  const view = {
    get state() { return state },
    dispatch(tr: Transaction) { state = state.apply(tr) },
    composing: false,
  } as unknown as EditorView

  return {
    tabstops,
    view,
    get state() { return state },
    /** 在 pos 处敲进 s(模拟逐字输入)。 */
    type(pos: number, s: string) {
      for (const ch of s) {
        const tr = state.tr.insertText(ch, pos)
        tr.setSelection(TextSelection.create(tr.doc, pos + 1))
        state = state.apply(tr)
        pos += 1
      }
    },
    /** 展开一个片段:把 [from,to) 换成 replacement 并压栈,光标落到第一个位点。 */
    expand(from: number, to: number, replacement: string) {
      const parsed = parseTabstops(replacement)
      let tr = state.tr
      if (parsed.text) tr.replaceWith(from, to, schema.text(parsed.text))
      else tr.delete(from, to)
      const groups = toDocGroups(parsed.groups, from)
      tr = tabstops.push(tr, groups)
      const first = groups[0].ranges[0]
      tr.setSelection(TextSelection.create(tr.doc, first.from, first.to))
      state = state.apply(tr)
      return groups
    },
    text() { return state.doc.textBetween(0, state.doc.content.size, '\n') },
    frames() { return tabstops.key.getState(state)?.stack ?? [] },
  }
}

describe('tabstop 位置映射', () => {
  it('连打多个字符,帧不掉(头一版就死在这)', () => {
    const e = mk('')
    e.expand(1, 1, '\\frac{$0}{$1}')
    expect(e.text()).toBe('\\frac{}{}')
    const stop = e.frames()[0].groups[0].ranges[0]

    e.type(stop.from, 'abc')

    expect(e.text()).toBe('\\frac{abc}{}')
    expect(e.frames()).toHaveLength(1) // ← 修之前:打到第二个字就变 0
    const g = e.frames()[0].groups[0].ranges[0]
    expect(e.state.doc.textBetween(g.from, g.to)).toBe('abc')
  })

  it('紧邻的两个空位点:在前一个里打字不会撑开后一个', () => {
    const e = mk('')
    e.expand(1, 1, 'x$0$1y')
    const [g0, g1] = e.frames()[0].groups
    expect(g0.ranges[0].from).toBe(g1.ranges[0].from) // 起点相同 = 真的紧邻

    e.type(g0.ranges[0].from, 'AB')

    const after = e.frames()[0].groups
    expect(e.state.doc.textBetween(after[0].ranges[0].from, after[0].ranges[0].to)).toBe('AB')
    expect(after[1].ranges[0].from).toBe(after[1].ranges[0].to) // 后一个仍是空位点
    expect(after[1].ranges[0].from).toBe(after[0].ranges[0].to) // 且排在打进去的字后面
  })

  it('带默认值的位点:落上去是整段选中,打字即替换', () => {
    const e = mk('')
    e.expand(1, 1, '\\sqrt[${0:2}]{$1}')
    expect(e.text()).toBe('\\sqrt[2]{}')
    const sel = e.state.selection
    expect(e.state.doc.textBetween(sel.from, sel.to)).toBe('2')
  })
})

describe('tabstop 跳位', () => {
  it('Tab 依次走到下一组', () => {
    const e = mk('')
    e.expand(1, 1, '\\frac{$0}{$1}')
    expect(e.frames()[0].active).toBe(0)
    expect(e.tabstops.cycle(e.view, 1)).toBe(true)
    expect(e.frames()[0].active).toBe(1)
  })

  it('跳过最后一组 = 片段收尾,栈清空', () => {
    const e = mk('')
    e.expand(1, 1, '\\frac{$0}{$1}')
    e.tabstops.cycle(e.view, 1)
    e.tabstops.cycle(e.view, 1)
    expect(e.frames()).toHaveLength(0)
  })

  it('没有活动片段时 cycle 返回 false(Tab 要还给宿主做列表缩进)', () => {
    const e = mk('普通段落')
    expect(e.tabstops.cycle(e.view, 1)).toBe(false)
  })

  it('Shift-Tab 从第一组往回 = 退出', () => {
    const e = mk('')
    e.expand(1, 1, '\\frac{$0}{$1}')
    expect(e.tabstops.cycle(e.view, -1)).toBe(true)
    expect(e.frames()).toHaveLength(0)
  })
})

describe('tabstop 收尾条件', () => {
  it('光标离开全部位点 → 整栈作废', () => {
    const e = mk('尾巴')
    e.expand(1, 1, '\\frac{$0}{$1}')
    expect(e.frames()).toHaveLength(1)
    const tr = e.state.tr.setSelection(TextSelection.create(e.state.doc, e.state.doc.content.size - 1))
    e.view.dispatch(tr)
    expect(e.frames()).toHaveLength(0)
  })

  it('位点所在文本被整段删掉 → 帧自己消失', () => {
    const e = mk('')
    e.expand(1, 1, '\\frac{$0}{$1}')
    e.view.dispatch(e.state.tr.delete(1, e.state.doc.content.size - 1))
    expect(e.frames()).toHaveLength(0)
  })

  it('clear meta 立刻退出(Esc)', () => {
    const e = mk('')
    e.expand(1, 1, '\\frac{$0}{$1}')
    e.view.dispatch(e.state.tr.setMeta(e.tabstops.key, { clear: true }))
    expect(e.frames()).toHaveLength(0)
  })
})

describe('同名位点镜像(ProseMirror 没有多光标,这是替代方案)', () => {
  /** 镜像走 appendTransaction,要跑真的 state.apply 链才会触发。 */
  it('在主位点打字,同组另一个位点跟着变', () => {
    const e = mk('')
    e.expand(1, 1, '\\begin{$0}\n$1\n\\end{$0}')
    const g0 = e.frames()[0].groups[0]
    expect(g0.ranges).toHaveLength(2)

    e.type(g0.ranges[0].from, 'align')

    // 两处都成了 align
    expect(e.text()).toContain('\\begin{align}')
    expect(e.text()).toContain('\\end{align}')
  })

  it('镜像不会无限递归(自己补的那一笔带 meta,不再触发)', () => {
    const e = mk('')
    e.expand(1, 1, 'A$0B$0C')
    const g = e.frames()[0].groups[0]
    e.type(g.ranges[0].from, 'x')
    expect(e.text()).toBe('AxBxC')
  })
})
