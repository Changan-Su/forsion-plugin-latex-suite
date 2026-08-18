// 片段展开引擎:敲一个字 → 看看行尾是不是某个触发串 → 就地换成替换文本 + 建 tabstop。
//
// 对应上游 features/run_snippets.ts。入口是 ProseMirror 的 `handleTextInput`(**字符还没进文档**,
// 所以判定用的「当前行」= 文档里的前半段 + 这次要插入的字)。

import type { EditorState, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { PmToolkit } from '../../types/forsion'
import type { Snippet } from '../snippets/model'
import { matchSnippet, onWordBoundary, shouldRunInMode, trimReplacementWhitespace } from '../snippets/model'
import { parseTabstops } from '../snippets/tabstopParse'
import { blockTextAt, inInlineCode, isCodeBlock } from './text'
import { mathContext } from './mathMode'
import { toDocGroups, type TabstopApi } from './tabstops'

export interface EngineSettings {
  wordDelimiters: string
  removeSnippetWhitespace: boolean
  autoEnlargeBrackets: boolean
  autoEnlargeBracketsTriggers: string[]
  /** 展开一次后再看看新文本是否又触发了别的片段;上限防打转。 */
  maxRecursion: number
}

export interface Engine {
  /** 自动片段(`A`):打字即展开。 */
  onTextInput(view: EditorView, from: number, to: number, typed: string): boolean
  /** 手动片段(无 `A`):按触发键(默认 Tab)展开。 */
  expandManual(view: EditorView): boolean
}

interface Attempt {
  /** 要替换掉的文档范围。 */
  from: number
  to: number
  insert: string
  enlarge: boolean
}

/** 找出在光标处该展开的那一个片段。`typed` 为空 = 手动触发(行就是文档现状)。 */
function findExpansion(
  state: EditorState,
  snippets: Snippet[],
  settings: EngineSettings,
  typed: string,
  automaticOnly: boolean,
): Attempt | null {
  const bt = blockTextAt(state)
  if (!bt) return null
  const codeBlock = isCodeBlock(bt.node)
  const cursor = bt.to
  const line = bt.text.slice(0, bt.from) + typed
  const sel = bt.from === bt.to ? '' : bt.text.slice(bt.from, bt.to)

  // 行内代码里不展开:用户在写字面量(`\alpha` 就是要那六个字)。
  if (!codeBlock && inInlineCode(bt.text, bt.from)) return null

  const ctx = mathContext(line, line.length, { inCodeBlock: codeBlock })

  for (const snippet of snippets) {
    if (automaticOnly !== snippet.options.automatic) continue
    if (!shouldRunInMode(snippet.options.mode, ctx.mode)) continue
    if (snippet.excludedEnvironments.length && ctx.envNames.some((e) => snippet.excludedEnvironments.includes(e))) continue
    // 宏作用域排除:默认表用它挡化学式(`\ce{H2}` 里的 H2 不该变成 H_{2})。
    if (snippet.excludedMacros.length && ctx.macroNames.some((m) => snippet.excludedMacros.includes(m))) continue

    const hit = matchSnippet(snippet, line, sel)
    if (!hit) continue

    if (snippet.type === 'visual') {
      // visual:替换掉**选区**,并把刚打的触发字符一并吃掉(它还没进文档,所以只要删选区)。
      return { from: bt.base + bt.from, to: bt.base + bt.to, insert: hit.insert, enlarge: false }
    }

    if (snippet.options.onWordBoundary && !onWordBoundary(line, hit.triggerPos, line.length, settings.wordDelimiters)) {
      continue
    }

    let insert = hit.insert
    if (ctx.mode.inlineMath && settings.removeSnippetWhitespace) insert = trimReplacementWhitespace(insert)

    // 触发串起点在**行坐标**里;文档坐标 = base + triggerPos。终点是光标(刚打的字还没进文档)。
    return {
      from: bt.base + hit.triggerPos,
      to: bt.base + cursor,
      insert,
      enlarge: settings.autoEnlargeBrackets && settings.autoEnlargeBracketsTriggers.some((w) => insert.includes(w)),
    }
  }
  return null
}

export function createEngine(
  pm: PmToolkit,
  tabstops: TabstopApi,
  getSnippets: () => Snippet[],
  getSettings: () => EngineSettings,
  onEnlarge?: (view: EditorView) => void,
): Engine {
  const apply = (view: EditorView, a: Attempt): void => {
    const parsed = parseTabstops(a.insert)
    let tr: Transaction = view.state.tr
    if (parsed.text) tr.replaceWith(a.from, a.to, view.state.schema.text(parsed.text))
    else tr.delete(a.from, a.to)

    if (parsed.groups.length) {
      const groups = toDocGroups(parsed.groups, a.from)
      tr = tabstops.push(tr, groups)
      const first = groups[0].ranges[0]
      tr.setSelection(pm.TextSelection.create(tr.doc, first.from, first.to))
    } else {
      const end = a.from + parsed.text.length
      tr.setSelection(pm.TextSelection.create(tr.doc, end))
    }
    view.dispatch(tr.scrollIntoView())
    if (a.enlarge) onEnlarge?.(view)
  }

  /** 展开一次后新文本可能又触发别的片段(`\frac{}{}` 里接着打 `//`)。上限来自设置,防打转。 */
  const cascade = (view: EditorView): void => {
    const limit = Math.max(0, getSettings().maxRecursion)
    for (let i = 0; i < limit; i++) {
      const next = findExpansion(view.state, getSnippets(), getSettings(), '', true)
      if (!next) return
      apply(view, next)
    }
  }

  return {
    onTextInput: (view, _from, _to, typed) => {
      // 输入法组合中途绝不介入:中文输入每敲一个拼音字母都会走到这里,
      // 半截拼音命中触发串 → 用户的候选窗当场炸掉。
      if (view.composing) return false
      if (typed.length !== 1) return false // 粘贴/多字符输入不触发(上游同款)
      const a = findExpansion(view.state, getSnippets(), getSettings(), typed, true)
      if (!a) return false
      apply(view, a)
      cascade(view)
      return true
    },
    expandManual: (view) => {
      if (view.composing) return false
      const a = findExpansion(view.state, getSnippets(), getSettings(), '', false)
      if (!a) return false
      apply(view, a)
      cascade(view)
      return true
    },
  }
}
