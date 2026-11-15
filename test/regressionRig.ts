// 回归用的驱动:与 obsidianParity 同一条按键链,另带点击 / 退格 / 粘贴 / 输入法 / 撤销。
import { Schema, Slice, Fragment } from 'prosemirror-model'
import { EditorState, Plugin, PluginKey, TextSelection, Selection, NodeSelection, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { keymap } from 'prosemirror-keymap'
import { InputRule, inputRules } from 'prosemirror-inputrules'
import { createEngine } from '../src/editor/expand'
import { createTabstops } from '../src/editor/tabstops'
import { setTextSelectionCtor } from '../src/editor/text'
import { normalizeSnippets, type RawSnippet } from '../src/snippets/parse'
import { DEFAULT_SNIPPETS } from '../src/snippets/defaults'
import { DEFAULT_SNIPPET_VARIABLES } from '../src/snippets/variables'
import { mergeSettings, splitList, type LatexSuiteSettings } from '../src/settingsUi/model'
import { autoEnlargeBrackets } from '../src/features'
import { createKeyHandlers } from '../src/keys'

export const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' },
  hard_break: { inline: true, group: 'inline' }, text: { group: 'inline' },
} })
const pm = { Plugin, PluginKey, TextSelection, Selection, NodeSelection, Decoration, DecorationSet, Slice, Fragment, keymap, InputRule, inputRules }
setTextSelectionCtor(TextSelection)
if (typeof globalThis.document === 'undefined') {
  ;(globalThis as unknown as { document: unknown }).document = { createElement: () => ({ className: '' }) }
}

export function rig(source: string, overrides: Partial<LatexSuiteSettings> = {}, raw: RawSnippet[] = DEFAULT_SNIPPETS) {
  const pos = source.indexOf('|')
  const text = source.replace('|', '')
  const children = text.split('\n').flatMap((line, i) => [...(i ? [schema.node('hard_break')] : []), ...(line ? [schema.text(line)] : [])])
  const doc = schema.node('doc', null, [schema.node('paragraph', null, children)])
  const settings = mergeSettings({ ...overrides })
  const tabstops = createTabstops(pm as never)
  let state = EditorState.create({ schema, doc, plugins: [tabstops.plugin], selection: TextSelection.create(doc, pos + 1) })
  const hist: Array<{ trs: readonly Transaction[]; before: { from: number; to: number } }> = []
  const view = {
    composing: false,
    editable: true,
    get state() { return state },
    dispatch(tr: Transaction) {
      const before = { from: state.selection.from, to: state.selection.to }
      const res = state.applyTransaction(tr)
      if (res.transactions.some((t) => t.docChanged) && tr.getMeta('undo') !== true) hist.push({ trs: res.transactions, before })
      state = res.state
    },
  } as unknown as EditorView
  const snippets = normalizeSnippets(raw, DEFAULT_SNIPPET_VARIABLES).snippets
  const enlarge = (v: EditorView): void => autoEnlargeBrackets(v, { triggers: splitList(settings.autoEnlargeBracketsTriggers), space: settings.autoEnlargeBracketsSpace })
  const engine = createEngine(pm as never, tabstops, () => snippets, () => ({
    proseSnippetsEnabled: settings.proseSnippetsEnabled,
    wordDelimiters: settings.wordDelimiters,
    removeSnippetWhitespace: settings.removeSnippetWhitespace,
    autoEnlargeBrackets: settings.autoEnlargeBrackets,
    autoEnlargeBracketsTriggers: splitList(settings.autoEnlargeBracketsTriggers),
    maxRecursion: settings.snippetRecursion,
  }), enlarge)
  const keys = createKeyHandlers({ settings: () => settings, ready: () => true, paused: () => false, engine, tabstops, enlarge })

  const blockText = (from: number, to: number): string => state.doc.textBetween(from, to, '\n', '\n')
  const line = (): string => {
    const sel = state.selection
    const $f = sel.$from
    const start = $f.start(), end = $f.end()
    const a = blockText(start, sel.from), b = blockText(sel.to, end)
    return sel.empty ? `${a}|${b}` : `${a}«${blockText(sel.from, sel.to)}»${b}`
  }
  const all = (): string => state.doc.textBetween(0, state.doc.content.size, '\n', '\n')
  const key = (k: string, shift = false) => keys.handleKeyDown(view, { key: k, shiftKey: shift, ctrlKey: false, metaKey: false, altKey: false, isComposing: false })

  const input = (step: string): boolean | null => {
    if (step === 'Tab' || step === 'S-Tab') return key('Tab', step === 'S-Tab')
    if (step === 'Esc') return key('Escape')
    if (step === 'BS') {
      if (key('Backspace')) return true
      const { from, to } = state.selection
      const tr = from === to ? state.tr.delete(from - 1, from) : state.tr.deleteSelection()
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from === to ? from - 1 : from)))
      return null
    }
    if (step === '→' || step === '←') {
      const d = step === '→' ? 1 : -1
      const p = (d > 0 ? state.selection.to : state.selection.from) + d
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, p)))
      return null
    }
    if (step.startsWith('click:')) {
      // click:needle  -> caret right after first occurrence of needle in the block
      // click:needle@n -> after n-th occurrence (1-based)
      let needle = step.slice(6)
      let nth = 1
      const at = /@(\d+)$/.exec(needle)
      if (at) { nth = Number(at[1]); needle = needle.slice(0, at.index) }
      const $f = state.selection.$from
      const t = blockText($f.start(), $f.end())
      let idx = -1
      for (let i = 0; i < nth; i++) idx = t.indexOf(needle, idx + 1)
      if (idx < 0) throw new Error(`needle ${needle} not found in ${t}`)
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, $f.start() + idx + needle.length)))
      return null
    }
    if (step.startsWith('paste:')) {
      const s = step.slice(6)
      const { from, to } = state.selection
      const tr = state.tr.insertText(s, from, to)
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + s.length)))
      return null
    }
    if (step.startsWith('ime:')) {
      // composition-like input: doc changes, selection only mapped (no setSelection)
      for (const ch of step.slice(4)) {
        const { from, to } = state.selection
        view.dispatch(state.tr.insertText(ch, from, to))
      }
      return null
    }
    if (step === 'undo') {
      const h = hist.pop()
      if (!h) throw new Error('nothing to undo')
      const tr = state.tr
      for (const t of [...h.trs].reverse()) {
        for (let i = t.steps.length - 1; i >= 0; i--) tr.step(t.steps[i].invert(t.docs[i]))
      }
      tr.setSelection(TextSelection.create(tr.doc, h.before.from, h.before.to))
      tr.setMeta('undo', true)
      view.dispatch(tr)
      return null
    }
    for (const ch of step) {
      const { from, to } = state.selection
      if (!keys.handleTextInput(view, from, to, ch)) {
        const tr = state.tr.insertText(ch, from, to)
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1)))
      }
    }
    return null
  }
  const run = (...steps: string[]) => { for (const s of steps) input(s); return line() }
  const groups = () => {
    const st = tabstops.key.getState(state) as unknown as { groups?: Array<{ ranges: Array<{ from: number; to: number }> }>; index?: number; mirror?: Array<{ from: number; to: number }> | null }
    return {
      index: st.index,
      groups: (st.groups ?? []).map((g) => g.ranges.map((r) => blockText(r.from, r.to) + `@${r.from}-${r.to}`)),
      mirror: st.mirror ? st.mirror.map((r) => blockText(r.from, r.to) + `@${r.from}-${r.to}`) : null,
    }
  }
  return { input, run, line, all, hasActive: () => tabstops.hasActive(state), groups, view, get state() { return state } }
}
