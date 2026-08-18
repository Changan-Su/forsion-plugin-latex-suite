// Tabstop:片段展开后用 Tab 在占位点之间跳。
//
// 与上游最大的一处**必要**分歧:CodeMirror 支持多光标,同下标的 tabstop 出现两次(`\begin{$0}…\end{$0}`)
// 就是两个光标同时打字。ProseMirror **没有多选区** —— 这里换成「镜像」:主位点(光标所在那个)
// 的文本在每次事务后同步到同组其它位点。用户看到的效果一样(改环境名两头一起变),而且比多光标更稳
// (光标只有一个,不会出现「另一个光标飘到别处」的诡异态)。
//
// 位置存活靠 tr.mapping —— 与仓里 headingFold.ts 同一条路子:锚随事务映射,失效即淘汰。

import type { EditorState, Plugin, PluginKey, Transaction } from 'prosemirror-state'
import type { DecorationSet, EditorView } from 'prosemirror-view'
import type { PmToolkit } from '../../types/forsion'
import type { TabstopGroup } from '../snippets/tabstopParse'

export interface DocGroup {
  index: number
  /** 文档坐标。 */
  ranges: Array<{ from: number; to: number }>
}

export interface Frame {
  groups: DocGroup[]
  /** 当前停在第几组(groups 的数组下标)。 */
  active: number
}

export interface TabstopState {
  /** 片段栈:片段里再展开片段时压栈,收尾时弹出(上游同款嵌套语义)。 */
  stack: Frame[]
  decos: DecorationSet
}

export interface TabstopApi {
  plugin: Plugin
  key: PluginKey
  /** 展开完一个片段后压栈并选中第一个 tabstop。groups 用**文档坐标**。 */
  push(tr: Transaction, groups: DocGroup[]): Transaction
  /** Tab / Shift-Tab。返回 false 表示没有活动片段,调用方应放行给宿主(列表缩进等)。 */
  cycle(view: EditorView, dir: 1 | -1): boolean
  hasActive(state: EditorState): boolean
}

/** 从解析结果 + 插入基址算出文档坐标的 group。 */
export function toDocGroups(groups: TabstopGroup[], base: number): DocGroup[] {
  return groups.map((g) => ({ index: g.index, ranges: g.ranges.map((r) => ({ from: base + r.from, to: base + r.to })) }))
}

const CLASS = 'latex-suite-tabstop'

export function createTabstops(pm: PmToolkit): TabstopApi {
  const key = new pm.PluginKey<TabstopState>('LATEX_SUITE_TABSTOPS')

  const build = (doc: Parameters<typeof pm.DecorationSet.create>[0], stack: Frame[]): DecorationSet => {
    const decos = []
    // 只画**栈顶**那一帧:嵌套片段时下层位点还在,但视觉上标出来会让人以为能跳过去。
    const top = stack[stack.length - 1]
    if (top) {
      for (const [gi, g] of top.groups.entries()) {
        for (const r of g.ranges) {
          if (r.from === r.to) continue // 空位点不画底色(否则是一条看不见的零宽装饰)
          decos.push(
            pm.Decoration.inline(r.from, r.to, {
              class: gi === top.active ? `${CLASS} ${CLASS}-active` : CLASS,
            }),
          )
        }
      }
    }
    return pm.DecorationSet.create(doc, decos)
  }

  /** 位置映射的偏置 —— 这里错一位,整套 tabstop 就只能活一个字符。三种情形各不相同:
   *
   *  ① **当前正在输入的那一组**(栈顶帧的 active 组):`from` 用 -1、`to` 用 +1,范围**两端都长大**。
   *     用户在位点里连打时,每个字都落在范围内。⚠️曾经写成「空范围才这样,变非空就换成内偏 (1,-1)」——
   *     那样第二个字插在 `to` 处、而 `to` 用 -1 原地不动,字就掉到范围外面,光标随即被收尾条件判成
   *     「跑出片段了」→ 整帧弹掉,Tab 悄悄退化成列表缩进。别再改回去。
   *  ② **其余组里的空位点**:两端都用 +1,**整体右移**。用 (1,-1) 的话 from 越过 to,范围会被判非法丢掉;
   *     而 (-1,+1) 会让紧挨着的 `$0$1`(同一位置两个空位点)在 $0 里打字时把 $1 也撑开。
   *  ③ **其余组里的非空位点**:(1,-1) 内偏,紧贴着它前后插入的字不会被吞进来。 */
  const mapFrame = (f: Frame, tr: Transaction, isTop: boolean): Frame | null => {
    const groups: DocGroup[] = []
    for (const [gi, g] of f.groups.entries()) {
      const grow = isTop && gi === f.active
      const ranges = []
      for (const r of g.ranges) {
        const empty = r.from === r.to
        const fromBias = grow ? -1 : 1
        const toBias = grow || empty ? 1 : -1
        const a = tr.mapping.mapResult(r.from, fromBias)
        const b = tr.mapping.mapResult(r.to, toBias)
        // 两端都落在被删掉的内容里 = 这个位点连同它的上下文一起没了(用户全选删光、
        // 或外部回灌换掉了整段)。不淘汰的话会留下一串挤在同一个位置的幽灵位点,
        // 用户按 Tab 只看到"什么都没发生"两次(Tab 被吞了却无事可做)。
        if (a.deleted && b.deleted) continue
        if (b.pos >= a.pos && b.pos <= tr.doc.content.size) ranges.push({ from: a.pos, to: b.pos })
      }
      if (ranges.length) groups.push({ index: g.index, ranges })
    }
    if (!groups.length) return null
    return { groups, active: Math.min(f.active, groups.length - 1) }
  }

  /** 光标是否还在这一帧的某个位点里(含边界)。跑出去就算片段结束。 */
  const cursorInside = (f: Frame, pos: number): boolean =>
    f.groups.some((g) => g.ranges.some((r) => pos >= r.from && pos <= r.to))

  const plugin = new pm.Plugin<TabstopState>({
    key,
    state: {
      init: () => ({ stack: [], decos: pm.DecorationSet.empty }),
      apply: (tr, prev) => {
        let stack = prev.stack
        if (tr.docChanged) {
          const top = stack.length - 1
          stack = stack.map((f, i) => mapFrame(f, tr, i === top)).filter((f): f is Frame => f !== null)
        }
        const meta = tr.getMeta(key) as { push?: DocGroup[]; go?: 1 | -1; clear?: true } | undefined
        if (meta?.clear) stack = []
        if (meta?.push) stack = [...stack, { groups: meta.push, active: 0 }]
        if (meta?.go && stack.length) {
          const top = stack[stack.length - 1]
          const next = top.active + meta.go
          if (next < 0) {
            stack = stack.slice(0, -1) // 从第一个位点往回 → 退出本层片段
          } else if (next >= top.groups.length) {
            stack = stack.slice(0, -1) // 跳过最后一个 → 片段收尾
          } else {
            stack = [...stack.slice(0, -1), { ...top, active: next }]
          }
        }
        // 光标离开全部位点 = 用户不在这个片段里了,整栈作废(上游同款收尾条件)。
        // ⚠️只在**选区真的动过**时判:docChanged 的中途态里光标可能瞬时在外面。
        if (stack.length && (tr.selectionSet || tr.docChanged)) {
          const pos = tr.selection.from
          while (stack.length && !cursorInside(stack[stack.length - 1], pos)) stack = stack.slice(0, -1)
        }
        if (stack === prev.stack && !tr.docChanged) return prev
        return { stack, decos: build(tr.doc, stack) }
      },
    },
    // 镜像:主位点的文本同步到同组其它位点。放在 appendTransaction 里,用户的那一笔先落定再补。
    appendTransaction: (trs, _old, state) => {
      if (!trs.some((t) => t.docChanged)) return null
      if (trs.some((t) => t.getMeta(key) === 'mirror')) return null // 自己补的那一笔不再触发
      const st = key.getState(state)
      const top = st?.stack[st.stack.length - 1]
      if (!top) return null
      const g = top.groups[top.active]
      if (!g || g.ranges.length < 2) return null
      const pos = state.selection.from
      const primary = g.ranges.find((r) => pos >= r.from && pos <= r.to) ?? g.ranges[0]
      const src = state.doc.textBetween(primary.from, primary.to, '\n', '\n')
      let tr: Transaction | null = null
      // 从后往前改,前面的位置才不会被自己的改动挪走。
      for (const r of [...g.ranges].sort((a, b) => b.from - a.from)) {
        if (r === primary) continue
        const cur = state.doc.textBetween(r.from, r.to, '\n', '\n')
        if (cur === src) continue
        tr = tr ?? state.tr
        if (src) tr.replaceWith(r.from, r.to, state.schema.text(src))
        else tr.delete(r.from, r.to)
      }
      if (tr) tr.setMeta(key, 'mirror')
      return tr
    },
    props: {
      decorations: (state) => key.getState(state)?.decos ?? null,
    },
  })

  const selectGroup = (view: EditorView, f: Frame): void => {
    const g = f.groups[f.active]
    if (!g?.ranges.length) return
    const r = g.ranges[0]
    const tr = view.state.tr.setSelection(pm.TextSelection.create(view.state.doc, r.from, r.to))
    view.dispatch(tr.scrollIntoView())
  }

  return {
    plugin,
    key,
    push: (tr, groups) => tr.setMeta(key, { push: groups }),
    hasActive: (state) => (key.getState(state)?.stack.length ?? 0) > 0,
    cycle: (view, dir) => {
      const st = key.getState(view.state)
      if (!st?.stack.length) return false
      view.dispatch(view.state.tr.setMeta(key, { go: dir }))
      const after = key.getState(view.state)
      const top = after?.stack[after.stack.length - 1]
      if (top) selectGroup(view, top)
      return true
    },
  }
}
