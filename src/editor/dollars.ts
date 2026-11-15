// 公式定界符 `$` / `$$` 着色(上游 editor_extensions/highlight_dollar.ts 的对位,设置项同名 highlightDollarEnabled)。
//
//  ① 配上的定界符(行内 `$…$` 与块级 `$$…$$` 两端)标绿 —— 上游块级本有一档深绿,但它判断块级的
//     条件恒为假,实际所有成对定界符都是同一种绿,这里照实测效果来;
//  ② 没收口的 `$$`(段首开了块级公式、整段找不到收口)与块级公式里夹着的单个 `$` 标红;
//  ③ 正文里散落的单个 `$`(「花了 $5」)不算公式,不着色。
//
// 上游只在文档或可视区变化之后才算(刚打开的笔记,不动它就没有颜色);这里一打开就算好。

import type { EditorState, Plugin } from 'prosemirror-state'
import type { DecorationSet, Decoration } from 'prosemirror-view'
import type { PmToolkit } from '../../types/forsion'
import { mathBlockString, isCodeBlock } from './text'
import { scanMath } from './mathMode'
import { MATH_TOKEN_CLASS } from './brackets'

export const DOLLAR_PAIRED_CLASS = 'latex-suite-highlighted-dollar-inline'
export const DOLLAR_ERROR_CLASS = 'latex-suite-error-dollar'

export interface DollarMark {
  /** textblock 文本坐标。 */
  from: number
  to: number
  error: boolean
}

function isEscaped(s: string, at: number): boolean {
  let n = 0
  while (at > 0 && s[--at] === '\\') n++
  return n % 2 === 1
}

/** 一个 textblock(mathBlockString 之后的文本)里要着色的定界符。 */
export function dollarMarks(text: string): DollarMark[] {
  const out: DollarMark[] = []
  const spans = scanMath(text, true)
  for (const span of spans) {
    const w = span.display ? 2 : 1
    out.push({ from: span.from, to: span.from + w, error: false }, { from: span.to - w, to: span.to, error: false })
    if (!span.display) continue
    for (let i = span.innerFrom; i < span.innerTo; i++) {
      if (text[i] === '\\') { i++; continue }
      if (text[i] === '$') out.push({ from: i, to: i + 1, error: true })
    }
  }
  // 段首开了 `$$`、后面有内容,整段却没有收口 → 这条块级公式没写完。
  // 只有 `$$` 两个字符时不算:那是刚打出一个 `$`、自动配成 `$|$` 的过渡状态,一闪一闪的红很吵。
  const lead = text.length - text.trimStart().length
  const opensDisplay = text.startsWith('$$', lead) && text[lead + 2] !== '$' && !isEscaped(text, lead)
  if (opensDisplay && text.slice(lead + 2).trim() !== '' && !spans.some((s) => s.from === lead)) {
    out.push({ from: lead, to: lead + 2, error: true })
  }
  return out.sort((a, b) => a.from - b.from)
}

export function dollarPlugins(pm: PmToolkit, opts: { enabled: () => boolean }): Plugin[] {
  const key = new pm.PluginKey<DecorationSet>('LATEX_SUITE_DOLLARS')
  const build = (state: EditorState): DecorationSet => {
    if (!opts.enabled()) return pm.DecorationSet.empty
    const decos: Decoration[] = []
    state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true
      if (isCodeBlock(node)) return false
      for (const m of dollarMarks(mathBlockString(node))) {
        decos.push(pm.Decoration.inline(pos + 1 + m.from, pos + 1 + m.to, {
          class: `${MATH_TOKEN_CLASS} ${m.error ? DOLLAR_ERROR_CLASS : DOLLAR_PAIRED_CLASS}`,
        }))
      }
      return false
    })
    return pm.DecorationSet.create(state.doc, decos)
  }
  return [
    new pm.Plugin<DecorationSet>({
      key,
      state: {
        init: (_c, state) => build(state),
        apply: (tr, prev, _old, state) => (tr.docChanged || tr.getMeta('latex-suite-settings') ? build(state) : prev),
      },
      props: { decorations: (state) => key.getState(state) ?? null },
    }),
  ]
}
