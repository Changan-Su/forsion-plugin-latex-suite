// 公式里的括号配对高亮(上游 editor_extensions/highlight_brackets.ts 的对位)。
//
// 两件事:
//  ① **配对高亮**:光标紧邻某个括号时,把它和它的配对括号一起描出来 —— 长公式里数括号的活省掉了。
//  ② **按深度着色**(colorPairedBrackets):同一层的括号同色,嵌套换色。上游默认开,很好用。
//
// 只在公式跨度内工作:正文里的括号是散文的一部分,染色会很吵。

import type { EditorState, Plugin } from 'prosemirror-state'
import type { DecorationSet } from 'prosemirror-view'
import type { Node as PmNode } from 'prosemirror-model'
import type { PmToolkit } from '../../types/forsion'
import { blockString } from './text'
import { scanMath } from './mathMode'

/** 成对符号:LaTeX 里 `\left(`/`\right)` 这类命令形态由 tabout 处理,这里只管裸括号。 */
const OPEN = '([{'
const CLOSE = ')]}'
const MATCH: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

interface Pair {
  open: number
  close: number
  depth: number
}

/** 在一段公式正文里做括号配对。返回全部成对括号(未配对的丢弃 —— 高亮一个孤零零的括号没有意义)。 */
export function pairBrackets(text: string, from: number, to: number): Pair[] {
  const out: Pair[] = []
  const stack: Array<{ ch: string; at: number }> = []
  for (let i = from; i < to; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue } // `\{` `\}` 是字面花括号,不参与配对
    if (OPEN.includes(c)) {
      stack.push({ ch: c, at: i })
    } else if (CLOSE.includes(c)) {
      const top = stack[stack.length - 1]
      if (top && top.ch === MATCH[c]) {
        stack.pop()
        out.push({ open: top.at, close: i, depth: stack.length })
      }
      // 配不上就丢掉这个右括号(不弹栈):`)]` 这种交错写法不该把外层也带崩
    }
  }
  return out
}

export interface BracketOptions {
  /** 光标旁的那一对是否描边。 */
  highlight: () => boolean
  /** 是否按嵌套深度着色。 */
  colorize: () => boolean
}

const DEPTH_CLASSES = 4 // 与 css.ts 里的 --ls-bracket-N 一一对应,超过就回绕

export function bracketPlugins(pm: PmToolkit, opts: BracketOptions): Plugin[] {
  const key = new pm.PluginKey<DecorationSet>('LATEX_SUITE_BRACKETS')

  const build = (state: EditorState): DecorationSet => {
    const wantHl = opts.highlight()
    const wantColor = opts.colorize()
    if (!wantHl && !wantColor) return pm.DecorationSet.empty
    const cursor = state.selection.from
    const decos: ReturnType<typeof pm.Decoration.inline>[] = []

    state.doc.descendants((node: PmNode, pos: number) => {
      if (!node.isTextblock) return true
      const text = blockString(node)
      const base = pos + 1
      for (const span of scanMath(text)) {
        for (const p of pairBrackets(text, span.innerFrom, span.innerTo)) {
          const o = base + p.open
          const c = base + p.close
          // 光标「紧邻」= 贴着括号的任一侧(和大多数编辑器的手感一致)。
          const near = wantHl && (cursor === o || cursor === o + 1 || cursor === c || cursor === c + 1)
          const cls: string[] = []
          if (wantColor) cls.push(`ls-bracket ls-bracket-${p.depth % DEPTH_CLASSES}`)
          if (near) cls.push('ls-bracket-active')
          if (!cls.length) continue
          decos.push(pm.Decoration.inline(o, o + 1, { class: cls.join(' ') }))
          decos.push(pm.Decoration.inline(c, c + 1, { class: cls.join(' ') }))
        }
      }
      return false // textblock 内部不再往下走
    })
    return pm.DecorationSet.create(state.doc, decos)
  }

  return [
    new pm.Plugin<DecorationSet>({
      key,
      state: {
        init: (_c, state) => build(state),
        // 只在文档或选区变了时重算 —— decorations() 每次都全量重扫会在长笔记上卡顿。
        apply: (tr, prev, _old, state) => (tr.docChanged || tr.selectionSet ? build(state) : prev),
      },
      props: {
        decorations: (state) => key.getState(state) ?? null,
      },
    }),
  ]
}
