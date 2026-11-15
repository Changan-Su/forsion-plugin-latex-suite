// Tabstop:片段展开后用 Tab 在占位点之间跳。
//
// 状态机逐条照上游 obsidian-latex-suite(snippets/codemirror/tabstops_state_field.ts 与
// snippets/snippet_management.ts),这是本文件唯一的口径:
//
//  ① **平铺的组表 + 一个下标**(不是栈)。片段里再展开片段时,新片段的组**替换掉当前组**
//     (`splice(index, 1, ...新组)`):当前格被新片段占了,外层其余的格原样排在后面。
//     ⚠️曾经写成「片段栈」:外层帧的当前格会随打字长成整段嵌套内容,里层走完后 Tab 把那一整段
//     选中 —— 用户看到的就是「连按两次 Tab 把一段内容选中了」。别再改回栈。
//  ② **每次选区变化都重算下标** = 第一个包住选区的组(两端都算包住);一个都不包 = 表长。
//     鼠标点进后面的格、方向键挪出格,下标都跟着走。
//  ③ 重算后表里只剩一组,或者下标已经到最后一组(含「哪个都不包」),**整表清空**(颜色计数归零)。
//     所以最后一格永远不会被画出来、也不会随输入无限长大;`mk` / `dm` 这类只有一个 `$0` 的片段
//     展开后表就是空的,不会多吃一次 Tab。
//  ④ Tab = 下一组:目标组包住当前选区就把光标放到它的末端,否则选中整格(空格就是放光标);
//     落点与当前选区相同就再往后找。找不到就返回 false,让这次 Tab 去做矩阵 / 跳出公式。
//     Shift+Tab 对称;第一组再往前 = 返回 false 交还编辑器,表原样保留。
//  ⑤ 位置映射:所有格两端都向外长(上游 mark 的 inclusive),紧贴格边的输入都算进格里。
//     空格只在被一次删除「跨过去」时才淘汰(上游 MapMode.TrackDel)。
//     ⚠️曾经用「两端都落在删除里就淘汰」判空格:自动放大括号把 `)` 换成 ` \right)` 时,
//     紧贴在 `)` 前面的那个空格(`//` 的 `$2`)被误判成删掉了,分式后面那一格凭空消失。
//  ⑥ 画法:只有表里第一组不画(上游 `tabstopGroups[0].hideFromEditor()`),其余有字的格画底色框,
//     空格画一根零宽点线。颜色是**每次展开**取一个计数(0/1/2 轮换),清空时归零 —— 不是嵌套深度。
//
// 与上游唯一的**必要**分歧:CodeMirror 支持多光标,同下标的 tabstop 出现两次(`\begin{$0}…\end{$0}`)
// 就是两个光标同时打字。ProseMirror **没有多选区** —— 这里换成「镜像」:光标所在那一处的文本在
// 每次事务后同步到同组其它位点。镜像只模拟多光标真正存在的时候:
//  ⑦ **只有插件自己把光标放进去时才联动**(展开片段、Tab / Shift+Tab 落位,linked = true)。
//     鼠标点、方向键把光标挪到**另一处**(哪怕是同组的另一份)就停止联动 —— 上游点击会把多光标
//     收成一个,之后只改那一处。⚠️曾经「选区一变就按新下标联动」:点进同组的第二份、打一个字,
//     其余几份(含用户自己填的内容)被整段改写。下标照样跟着选区重算(Tab 从哪接着走),联动不跟。
//  ⑧ 清表时如果最后落到的组有多处,而且是 Tab / 展开落上去的,留一份「镜像余组」(不画、不参与
//     跳位),光标离开那一处之前继续联动。
//  ⑨ 在联动着的多处组里再展开片段(含 `/` 自动分式):上游会在每一处各展开一次。这里只在光标那处
//     展开,外层这组转成镜像余组,把这一处的新内容整段抄到其它各处,新片段的格照常跳。
//     ⚠️曾经直接把外层组替换掉:其余几份停在旧值,之后再也追不上。

import type { EditorState, Plugin, PluginKey, Transaction } from 'prosemirror-state'
import type { DecorationSet, EditorView } from 'prosemirror-view'
import type { PmToolkit } from '../../types/forsion'
import type { TabstopGroup } from '../snippets/tabstopParse'

export interface Range {
  from: number
  to: number
}

/** 展开片段时交给 push 的组(文档坐标)。 */
export interface DocGroup {
  index: number
  /** 文档坐标。 */
  ranges: Range[]
}

export interface Group {
  ranges: Range[]
  /** 0/1/2:哪一次展开建的(决定画什么颜色)。 */
  color: number
  /** 上游的 hidden:表里第一组在第一次选区变化后不再画。 */
  hidden: boolean
}

export interface TabstopSnapshot {
  groups: Group[]
  index: number
  /** 下一次展开用的颜色计数。 */
  color: number
  /** 镜像余组:清表时留下的同名多处位点,或在多处组里再展开时转出来的外层组。只做镜像。 */
  mirror: Range[] | null
  /** 当前组是否联动(见文件头 ⑦)。 */
  linked: boolean
}

export interface TabstopState extends TabstopSnapshot {
  decos: DecorationSet
}

export interface TabstopApi {
  plugin: Plugin
  key: PluginKey<TabstopState>
  /** 展开完一个片段后把它的组插进表里(替换当前组)。groups 用**文档坐标**;调用方自己设选区。 */
  push(tr: Transaction, groups: DocGroup[]): Transaction
  /** Tab / Shift-Tab。返回 false = 这次按键不归占位跳转管,调用方继续往下交。 */
  cycle(view: EditorView, dir: 1 | -1): boolean
  hasActive(state: EditorState): boolean
  snapshot(state: EditorState): TabstopSnapshot
  restore(tr: Transaction, snap: TabstopSnapshot): Transaction
}

/** 从解析结果 + 插入基址算出文档坐标的 group。 */
export function toDocGroups(groups: TabstopGroup[], base: number): DocGroup[] {
  return groups.map((g) => ({ index: g.index, ranges: g.ranges.map((r) => ({ from: base + r.from, to: base + r.to })) }))
}

/** 与上游类名一致,便于对照两边的 DOM。 */
export const PLACEHOLDER_CLASS = 'latex-suite-snippet-placeholder'
/** 空格的零宽点线(上游 `.cm-snippetFieldPosition`,这里不是 CodeMirror,换个前缀)。 */
export const FIELD_CLASS = 'latex-suite-snippet-field'
const N_COLORS = 3

const EMPTY: TabstopSnapshot = { groups: [], index: 0, color: 0, mirror: null, linked: false }

/** 选区 [from, to] 是否落在某一处位点里(两端都算)—— 上游 containsSelection。 */
function groupContains(g: { ranges: Range[] }, from: number, to: number): boolean {
  return g.ranges.some((r) => r.from <= from && r.to >= to)
}

/** 包住选区的第一处位点的序号;都不包 = -1。 */
function rangeIndexOf(ranges: Range[], from: number, to: number): number {
  return ranges.findIndex((r) => r.from <= from && r.to >= to)
}

/** 第一个包住选区的组;一个都不包 = 表长(上游 getCurrentTabstopGroupIndex)。 */
function currentIndex(groups: Group[], from: number, to: number): number {
  for (let i = 0; i < groups.length; i++) if (groupContains(groups[i], from, to)) return i
  return groups.length
}

export function createTabstops(pm: PmToolkit): TabstopApi {
  const key = new pm.PluginKey<TabstopState>('LATEX_SUITE_TABSTOPS')

  const build = (doc: Parameters<typeof pm.DecorationSet.create>[0], snap: TabstopSnapshot): DecorationSet => {
    const decos = []
    for (const g of snap.groups) {
      if (g.hidden) continue
      for (const r of g.ranges) {
        if (r.from === r.to) {
          decos.push(pm.Decoration.widget(r.from, () => {
            const el = document.createElement('span')
            el.className = FIELD_CLASS
            return el
          }, { side: -1, ignoreSelection: true, key: `ls-field-${r.from}` }))
        } else {
          decos.push(pm.Decoration.inline(r.from, r.to, { class: `${PLACEHOLDER_CLASS} ${PLACEHOLDER_CLASS}-${g.color}` }))
        }
      }
    }
    return pm.DecorationSet.create(doc, decos)
  }

  /** 一处位点跟着事务走。返回 null = 这处没了。
   *  `exclusive`:贴着边界插进来的字不算进这一格(只影响纯插入;整段被替换时两端照样落在替换内容外沿)。
   *  给「不是当前组、又有好几处要联动」的组用:上游靠多光标,这类格贴着别的格时会一起长;
   *  这里是把主位点的文本抄过去,吞进来的别人的字会在下一次联动时被盖掉(评审复现过)。 */
  const mapRange = (r: Range, tr: Transaction, exclusive = false): Range | null => {
    if (exclusive) {
      if (r.from === r.to) {
        const p = tr.mapping.mapResult(r.from, 1)
        return p.deletedAcross ? null : { from: p.pos, to: p.pos }
      }
      const a = tr.mapping.mapResult(r.from, 1)
      const b = tr.mapping.mapResult(r.to, -1)
      if (a.deleted && b.deleted) return null
      if (b.pos < a.pos || b.pos > tr.doc.content.size) return null
      return { from: a.pos, to: b.pos }
    }
    if (r.from === r.to) {
      const a = tr.mapping.mapResult(r.from, -1)
      const b = tr.mapping.mapResult(r.from, 1)
      if (a.deletedAcross || b.deletedAcross) return null
      return { from: a.pos, to: b.pos }
    }
    const a = tr.mapping.mapResult(r.from, -1)
    const b = tr.mapping.mapResult(r.to, 1)
    // 两端都落在被删掉的内容里 = 这一格连同上下文一起没了(全选删光、外部回灌换掉整段)。
    if (a.deleted && b.deleted) return null
    if (b.pos < a.pos || b.pos > tr.doc.content.size) return null
    return { from: a.pos, to: b.pos }
  }

  const mapRanges = (ranges: Range[], tr: Transaction, exclusive = false): Range[] => {
    const out: Range[] = []
    for (const r of ranges) {
      const m = mapRange(r, tr, exclusive)
      if (m) out.push(m)
    }
    return out
  }

  const plugin = new pm.Plugin<TabstopState>({
    key,
    state: {
      init: (_c, state) => ({ ...EMPTY, decos: build(state.doc, EMPTY) }),
      apply: (tr, prev, oldState) => {
        let { groups, index, color, mirror, linked } = prev as TabstopSnapshot
        // ⚠️下面的映射循环会就地改 index,判断「是不是当前组 / 在不在当前组前面」必须用事务前的下标。
        // 曾经边比较边减:一笔事务吞掉当前组前面两组时只减了一次,新片段被插到错的位置,
        // 旧的当前格留在表里,Tab 在两处之间来回跳出不去。
        const cur = index
        if (tr.docChanged) {
          const kept: Group[] = []
          for (const [i, g] of groups.entries()) {
            const ranges = mapRanges(g.ranges, tr, i !== cur && g.ranges.length > 1)
            if (ranges.length) kept.push({ ...g, ranges })
            else if (i < cur) index-- // 当前组前面少了一组,下标跟着挪
          }
          groups = kept
          if (index >= groups.length) index = Math.max(0, groups.length - 1)
          if (mirror) {
            const m = mapRanges(mirror, tr)
            mirror = m.length > 1 ? m : null
          }
        }

        const meta = tr.getMeta(key) as
          | { add?: DocGroup[]; clear?: true; restore?: TabstopSnapshot; nav?: true }
          | 'mirror'
          | undefined
        /** 这笔事务的选区是插件自己放的(展开、Tab 落位)。 */
        let placed = false
        if (meta && meta !== 'mirror') {
          if (meta.clear) ({ groups, index, color, mirror, linked } = EMPTY)
          if (meta.restore) ({ groups, index, color, mirror, linked } = meta.restore)
          if (meta.add?.length) {
            // 见文件头 ⑨:在联动着的多处组里展开,外层组转成镜像余组。
            const outer = groups[index]
            if (linked && outer && outer.ranges.length > 1) mirror = outer.ranges
            const c = color % N_COLORS
            color++
            const added: Group[] = meta.add.map((g) => ({ ranges: g.ranges, color: c, hidden: false }))
            groups = [...groups]
            groups.splice(index, 1, ...added)
            placed = true
            linked = true
          }
          if (meta.nav) {
            placed = true
            linked = true
          }
        }

        // 选区变了 → 重算下标;到最后一组 / 只剩一组 → 清表。
        if (tr.selectionSet && (groups.length || mirror)) {
          const { from, to } = tr.selection
          // 见文件头 ⑦:光标只是被挪动(鼠标、方向键,文档没变)而且离开了原来那一处 → 停止联动。
          if (!placed && !tr.docChanged) {
            const old = oldState.selection
            const stayed = (ranges: Range[]): boolean => {
              const a = rangeIndexOf(ranges, old.from, old.to)
              return a >= 0 && a === rangeIndexOf(ranges, from, to)
            }
            const prevGroup = prev.groups[prev.index]
            if (linked && !(prevGroup && stayed(prevGroup.ranges))) linked = false
            if (mirror && !stayed(mirror)) mirror = null
          }
          if (groups.length) {
            index = currentIndex(groups, from, to)
            if (groups.length <= 1 || index >= groups.length - 1) {
              const last = groups[index]
              // 见文件头 ⑧:只有 Tab / 展开落到的多处组才留镜像余组。
              if (placed && last && last.ranges.length > 1) mirror = last.ranges
              groups = []
              index = 0
              color = 0
              linked = false
            } else if (!groups[0].hidden) {
              groups = [{ ...groups[0], hidden: true }, ...groups.slice(1)]
            }
          }
          if (mirror && !groupContains({ ranges: mirror }, from, to)) mirror = null
        }

        const next: TabstopSnapshot = { groups, index, color, mirror, linked }
        if (!tr.docChanged && groups === prev.groups && index === prev.index && color === prev.color && mirror === prev.mirror && linked === prev.linked) return prev
        return { ...next, decos: build(tr.doc, next) }
      },
    },
    // 镜像:主位点的内容同步到同组其它位点。放在 appendTransaction 里,用户的那一笔先落定再补。
    // 先同步当前组(在里层),再同步镜像余组(外层,整段包着里层),外层抄过去的就是同步好的内容。
    appendTransaction: (trs, _old, state) => {
      if (!trs.some((t) => t.docChanged)) return null
      if (trs.some((t) => t.getMeta(key) === 'mirror')) return null // 自己补的那一笔不再触发
      const st = key.getState(state)
      if (!st) return null
      const sets: Range[][] = []
      const g = st.linked ? st.groups[st.index] : undefined
      if (g && g.ranges.length > 1) sets.push(g.ranges)
      if (st.mirror) sets.push(st.mirror)
      let tr: Transaction | null = null
      for (const set of sets) {
        const doc = tr ? tr.doc : state.doc
        const sel = tr ? tr.selection : state.selection
        const ranges = set.map((r) => (tr ? { from: tr.mapping.map(r.from, -1), to: tr.mapping.map(r.to, 1) } : r))
        const primary = ranges.find((r) => r.from <= sel.from && r.to >= sel.to)
        // 光标不在这组任何一处里 = 这笔改动不是在这组里打的字,别拿别处的内容去覆盖。
        if (!primary) continue
        // 抄切片不抄纯文本:换行(hard break)和行内标记原样过去。
        const src = doc.slice(primary.from, primary.to)
        // 从后往前改,前面的位置才不会被自己的改动挪走。
        for (const r of [...ranges].sort((a, b) => b.from - a.from)) {
          if (r === primary) continue
          if (doc.slice(r.from, r.to).eq(src)) continue
          tr = tr ?? state.tr
          tr.replace(r.from, r.to, src)
        }
      }
      if (tr) tr.setMeta(key, 'mirror')
      return tr
    },
    props: {
      decorations: (state) => key.getState(state)?.decos ?? null,
    },
  })

  return {
    plugin,
    key,
    push: (tr, groups) => tr.setMeta(key, { add: groups }),
    snapshot: (state) => {
      const st = key.getState(state)
      return st ? { groups: st.groups, index: st.index, color: st.color, mirror: st.mirror, linked: st.linked } : EMPTY
    },
    restore: (tr, snap) => tr.setMeta(key, { restore: snap }),
    hasActive: (state) => (key.getState(state)?.groups.length ?? 0) > 0,
    cycle: (view, dir) => {
      const st = key.getState(view.state)
      if (!st?.groups.length) return false
      const cur = view.state.selection
      for (let i = st.index + dir; i >= 0 && i < st.groups.length; i += dir) {
        const g = st.groups[i]
        const r = g.ranges[0]
        if (!r) continue
        // 目标组已经包住当前选区 → 光标放到它末端(上游 toEditorSelection(true))。
        const [from, to] = groupContains(g, cur.from, cur.to) ? [r.to, r.to] : [r.from, r.to]
        if (from === cur.from && to === cur.to) continue
        view.dispatch(view.state.tr.setSelection(pm.TextSelection.create(view.state.doc, from, to)).setMeta(key, { nav: true }).scrollIntoView())
        return true
      }
      return false
    },
  }
}
