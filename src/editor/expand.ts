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
import { blockTextAt, inlineTextNodes, mathBlockString, protectedRange, isCodeBlock, textSelectionAt } from './text'
import { mathContext } from './mathMode'
import { toDocGroups, type TabstopApi, type TabstopSnapshot } from './tabstops'

export interface EngineSettings {
  proseSnippetsEnabled?: boolean
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
  undoExpansion(view: EditorView): boolean
  rememberExpansion(view: EditorView, literal: EditorState): void
}

interface Attempt {
  /** 要替换掉的文档范围。 */
  from: number
  to: number
  insert: string
  enlarge: boolean
}

/** 正则里有「行首」锚(`^`,不算 `[^…]` 里的、也不算转义的 `\^`)。 */
function anchoredAtLineStart(trigger: RegExp): boolean {
  return /(^|[^[\\])\^/.test(trigger.source)
}

/** Obsidian 里正则匹配的是整行 Markdown 源码,文本前面还有块级标记;宿主的文本块里没有这些标记。
 *  给锚在行首的正则补上它们,行首判断才和上游一致:
 *   - 标题 `## `、引用 `> `:`## 1. Roadm` 不会被当成列表行;
 *   - 列表项 `- `(嵌套的外层补缩进):列表里的片段照常认得出列表;
 *   - 普通段落开头像列表标记的(`1. `、`- `):落盘时会被转义成 `1\. `,上游看到的也是转义后的,
 *     这里补一个 `\` 让它同样认不出。 */
function sourceLinePrefix(state: EditorState, text: string): { prefix: string; inList: boolean } {
  const { $from } = state.selection
  let quotes = ''
  let lists = 0
  for (let d = 1; d <= $from.depth; d++) {
    const name = $from.node(d).type.name
    if (/blockquote/i.test(name)) quotes += '> '
    else if (/^(list_?item|task_?item)$/i.test(name)) lists++
  }
  const block = $from.parent
  if (/heading/i.test(block.type.name)) {
    const level = Number(block.attrs.level) || 1
    return { prefix: quotes + '#'.repeat(level) + ' ', inList: false }
  }
  if (lists) return { prefix: quotes + '  '.repeat(lists - 1) + '- ', inList: true }
  if (/^[ \t]*(\d+[.)]|[-*+])[ \t]/.test(text)) return { prefix: quotes + '\\', inList: false }
  return { prefix: quotes, inList: false }
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
  if (codeBlock || protectedRange(bt)) return null
  const cursor = bt.to
  const line = bt.text.slice(0, bt.from) + typed
  const sel = bt.from === bt.to ? '' : bt.text.slice(bt.from, bt.to)
  const after = bt.text.slice(bt.to)
  let source: { prefix: string; inList: boolean } | null = null

  const contextText = mathBlockString(bt.node)
  const candidate = contextText.slice(0, bt.from) + typed + contextText.slice(bt.to)
  const ctx = mathContext(candidate, bt.from + typed.length, { inCodeBlock: false })
  // Visual replacements are judged against the entire original selection.
  const original = mathContext(contextText, bt.from, { inCodeBlock: false })
  if (sel && original.span && bt.to > original.span.innerTo) return null
  if (automaticOnly && (ctx.mode.text || ctx.mode.textEnv) && !settings.proseSnippetsEnabled) return null

  for (const snippet of snippets) {
    if (automaticOnly !== snippet.options.automatic) continue
    const mode = sel ? original.mode : ctx.mode
    if (!shouldRunInMode(snippet.options.mode, mode)) continue
    if (snippet.excludedEnvironments.length && ctx.envNames.some((e) => snippet.excludedEnvironments.includes(e))) continue
    // 宏作用域排除:默认表用它挡化学式(`\ce{H2}` 里的 H2 不该变成 H_{2})。
    if (snippet.excludedMacros.length && ctx.macroNames.some((m) => snippet.excludedMacros.includes(m))) continue

    // 锚在行首的正则按 Obsidian 的源码行去匹配(见 sourceLinePrefix)。
    const anchored = snippet.type === 'regex' && snippet.trigger instanceof RegExp && anchoredAtLineStart(snippet.trigger)
    if (anchored && !source) source = sourceLinePrefix(state, bt.text)
    const shift = anchored && source ? source.prefix.length : 0
    const hit = matchSnippet(snippet, shift ? source!.prefix + line : line, sel, after)
    if (!hit) continue
    let triggerPos = hit.triggerPos - shift
    let insert = hit.insert
    if (shift && triggerPos < 0) {
      // 匹配从补上去的块级标记里开始:那一段只能原样吐回来(上游就是这样),去掉它只留文本里的部分。
      const context = source!.prefix.slice(source!.prefix.length + triggerPos)
      if (!insert.startsWith(context)) continue
      insert = insert.slice(context.length)
      triggerPos = 0
      // 宿主的列表项本身就是一层,不需要 Markdown 那样靠缩进把后面几行留在列表里;
      // 留着缩进会落盘成 `&#x20;` 一类的转义空格。
      if (source!.inList) insert = insert.replace(/\n[ \t]+/g, '\n')
    }
    let start = snippet.type === 'visual' ? bt.from : triggerPos
    const end = bt.to + (hit.afterLength ?? 0)
    const span = sel ? original.span : ctx.span
    // Imported snippets often capture the character before a command and put it
    // back unchanged: ([^\\])(${GREEK}) -> [[0]]\\[[1]]. At the start of math
    // that character is the opening dollar. Keep the unchanged prefix outside
    // the edit instead of rejecting the whole match (or rewriting a delimiter).
    if (span && start < span.innerFrom && snippet.type !== 'visual') {
      const prefix = line.slice(start, span.innerFrom)
      if (!insert.startsWith(prefix)) continue
      start = span.innerFrom
      insert = insert.slice(prefix.length)
    }
    // A captured line break is also unchanged context, not part of the edit.
    // Keep its host node (and attrs) intact so a row-start Greek trigger does
    // not get rejected by the inline-atom protection below.
    if (snippet.type !== 'visual') {
      while (start < end && bt.text[start] === '\n' && insert.startsWith('\n')) {
        start++
        insert = insert.slice(1)
      }
    }
    // The actual replacement must remain entirely within the mathematical body.
    if (span && (start < span.innerFrom || end + typed.length - (bt.to - bt.from) > span.innerTo)) continue
    if (protectedRange(bt, start, end)) continue

    if (snippet.type === 'visual') {
      // visual:替换掉**选区**,并把刚打的触发字符一并吃掉(它还没进文档,所以只要删选区)。
      return { from: bt.base + bt.from, to: bt.base + bt.to, insert: hit.insert, enlarge: false }
    }

    // 词边界看光标**后面**真实的那个字符(上游 isOnWordBoundary 取 sliceDoc(to, to + 1))。
    // ⚠️曾经把行尾当光标:后一个字符恒为空格,`hello |world` 里打 dm 也会展开。
    if (snippet.options.onWordBoundary && !onWordBoundary(line + after, triggerPos, line.length + (hit.afterLength ?? 0), settings.wordDelimiters)) {
      continue
    }

    if (ctx.mode.inlineMath && settings.removeSnippetWhitespace) insert = trimReplacementWhitespace(insert)

    // 触发串起点在**行坐标**里;文档坐标 = base + triggerPos。终点是光标(刚打的字还没进文档)。
    return {
      from: bt.base + start,
      to: bt.base + cursor + (hit.afterLength ?? 0),
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
    // 只换掉真正变了的那一段:替换文本开头和原文相同的部分留在文档里,连同它的行内标记
    // (链接、加粗)。⚠️曾经整段重写:列表行里的 dm 把行首到光标重写成纯文本,链接地址和加粗没了;
    // 同号格里打希腊字母时,正则带上的格外那个 `{` 也被算进格里、再被联动抄到别处。
    // 至少留一个原字符参与替换:纯插入和替换在光标处的位置映射不一样,别让贴着光标的空格把展开吞进去。
    const old = view.state.doc.textBetween(a.from, a.to, '\n', '\ufffc')
    let keep = 0
    const most = Math.min(old.length - 1, parsed.text.length)
    while (keep < most && old[keep] === parsed.text[keep]) keep++
    const rest = parsed.text.slice(keep)
    if (rest) tr.replaceWith(a.from + keep, a.to, inlineTextNodes(view.state.schema, rest))
    else tr.delete(a.from + keep, a.to)

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
    const limit = Math.min(32, Math.max(0, getSettings().maxRecursion))
    for (let i = 0; i < limit; i++) {
      const next = findExpansion(view.state, getSnippets(), getSettings(), '', true)
      if (!next) return
      apply(view, next)
    }
  }

  let restore: { doc: EditorState['doc']; literal: EditorState; tabstops: TabstopSnapshot; from: number; to: number } | null = null
  return {
    rememberExpansion: (view, literal) => { restore = { doc: view.state.doc, literal, tabstops: tabstops.snapshot(literal), from: view.state.selection.from, to: view.state.selection.to } },
    undoExpansion: (view) => {
      if (!restore || view.composing || !view.state.doc.eq(restore.doc) || view.state.selection.from !== restore.from || view.state.selection.to !== restore.to) { restore = null; return false }
      const r = restore
      restore = null
      const tr = tabstops.restore(view.state.tr.replace(0, view.state.doc.content.size, r.literal.doc.slice(0)), r.tabstops)
      tr.setSelection(textSelectionAt(tr.doc, r.literal.selection.from, r.literal.selection.to))
      view.dispatch(tr.scrollIntoView())
      return true
    },
    onTextInput: (view, _from, _to, typed) => {
      // 输入法组合中途绝不介入:中文输入每敲一个拼音字母都会走到这里,
      // 半截拼音命中触发串 → 用户的候选窗当场炸掉。
      if (view.composing) return false
      restore = null
      if (_from !== view.state.selection.from || _to !== view.state.selection.to) return false
      if (typed.length !== 1) return false // 粘贴/多字符输入不触发(上游同款)
      const a = findExpansion(view.state, getSnippets(), getSettings(), typed, true)
      if (!a) return false
      // Preserve the literal trigger for immediate Backspace recovery, independently of host Undo grouping.
      const literal = view.state.applyTransaction(view.state.tr.insertText(typed, _from, _to)).state
      apply(view, a)
      cascade(view)
      restore = { doc: view.state.doc, literal, tabstops: tabstops.snapshot(literal), from: view.state.selection.from, to: view.state.selection.to }
      return true
    },
    expandManual: (view) => {
      if (view.composing) return false
      restore = null
      const a = findExpansion(view.state, getSnippets(), getSettings(), '', false)
      if (!a) return false
      apply(view, a)
      cascade(view)
      return true
    },
  }
}
