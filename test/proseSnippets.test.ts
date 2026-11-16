// 正文片段缺省开以后的两处边界(评审复现过):
//   S1 列表里的 dm 只认真列表项;展开只改 dm 那一段,行里的链接、加粗原样留着;
//   S2 词边界看光标后面真实的字符(在已有单词前面插入 dm 不展开,上游同样)。
// 期望值来自真 Obsidian 1.15.1 + Latex Suite 1.12.8 缺省设置下的实测。
import { describe, expect, it } from 'vitest'
import { Schema, Slice, Fragment, type Mark } from 'prosemirror-model'
import { EditorState, Plugin, PluginKey, TextSelection, Selection, NodeSelection } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { createEngine } from '../src/editor/expand'
import { createTabstops } from '../src/editor/tabstops'
import { setTextSelectionCtor } from '../src/editor/text'
import { normalizeSnippets } from '../src/snippets/parse'
import { DEFAULT_SNIPPETS } from '../src/snippets/defaults'
import { DEFAULT_SNIPPET_VARIABLES } from '../src/snippets/variables'
import { mergeSettings, splitList } from '../src/settingsUi/model'

// 与宿主同形:标题带 level、列表项的段落文本里没有列表标记、hard break、行内标记。
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 2 } } },
    blockquote: { group: 'block', content: 'block+' },
    bullet_list: { group: 'block', content: 'list_item+' },
    ordered_list: { group: 'block', content: 'list_item+' },
    list_item: { content: 'paragraph block*' },
    hard_break: { inline: true, group: 'inline' },
    text: { group: 'inline' },
  },
  marks: { code: {}, amadeusEscaped: {}, strong: {}, link: { attrs: { href: {} }, inclusive: false } },
})
const pm = { Plugin, PluginKey, TextSelection, Selection, NodeSelection, Decoration, DecorationSet, Slice, Fragment } as never
setTextSelectionCtor(TextSelection)

type Part = string | { text: string; marks: Mark[] }
type Block = 'heading' | 'paragraph' | 'olist' | 'blist' | 'quote'

/** 光标在唯一一个文本块里 `|` 处(没写就在末尾);缺省设置 = 新装用户。 */
function rig(block: Block, parts: Part[]) {
  let caretAt = -1
  let offset = 0
  const kids = parts.flatMap((p) => {
    const text = typeof p === 'string' ? p : p.text
    const i = text.indexOf('|')
    const clean = text.replace('|', '')
    if (i >= 0) caretAt = offset + i
    offset += clean.length
    if (!clean) return []
    return [typeof p === 'string' ? schema.text(clean) : schema.text(clean, p.marks)]
  })
  const para = schema.node('paragraph', null, kids)
  const top = block === 'heading' ? schema.node('heading', { level: 2 }, kids)
    : block === 'paragraph' ? para
    : block === 'quote' ? schema.node('blockquote', null, [para])
    : schema.node(block === 'olist' ? 'ordered_list' : 'bullet_list', null, [schema.node('list_item', null, [para])])
  const doc = schema.node('doc', null, [top])
  let start = 0
  doc.descendants((n, p) => { if (n.isTextblock) start = p + 1; return true })
  const caret = start + (caretAt >= 0 ? caretAt : offset)
  const settings = mergeSettings(null)
  const tabs = createTabstops(pm)
  let state = EditorState.create({ schema, doc, plugins: [tabs.plugin], selection: TextSelection.create(doc, caret) })
  const view = { composing: false, get state() { return state }, dispatch(tr: Parameters<EditorState['apply']>[0]) { state = state.apply(tr) } } as unknown as EditorView
  const engine = createEngine(pm, tabs, () => normalizeSnippets(DEFAULT_SNIPPETS, DEFAULT_SNIPPET_VARIABLES).snippets, () => ({
    proseSnippetsEnabled: settings.proseSnippetsEnabled, wordDelimiters: settings.wordDelimiters, removeSnippetWhitespace: settings.removeSnippetWhitespace,
    autoEnlargeBrackets: settings.autoEnlargeBrackets, autoEnlargeBracketsTriggers: splitList(settings.autoEnlargeBracketsTriggers), maxRecursion: settings.snippetRecursion,
  }))
  const type = (s: string): void => {
    for (const ch of s) {
      const { from, to } = view.state.selection
      if (!engine.onTextInput(view, from, to, ch)) view.dispatch(view.state.tr.insertText(ch, from, to))
    }
  }
  const text = () => {
    let out = ''
    view.state.doc.descendants((n) => { if (n.isTextblock) out = n.textBetween(0, n.content.size, '\n', (l) => (l.type.name === 'hard_break' ? '\n' : '')); return true })
    return out
  }
  const marked = (name: string) => { let s = ''; view.state.doc.descendants((n) => { if (n.isText && n.marks.some((m) => m.type.name === name)) s += n.text; return true }); return s }
  const hrefs = () => { const out: string[] = []; view.state.doc.descendants((n) => { if (n.isText) for (const m of n.marks) if (m.type.name === 'link') out.push(m.attrs.href); return true }); return out }
  return { type, text, marked, hrefs, settings }
}

const link = schema.marks.link.create({ href: 'https://example.com/x' })
const strong = schema.marks.strong.create()

describe('S1 列表里的 dm 只认真列表项', () => {
  it('编号开头的标题里打 roadmap 不展开,链接与加粗原样(Obsidian:`## 1. Roadmap` 不展开)', () => {
    const r = rig('heading', ['1. See ', { text: 'bold', marks: [strong] }, ' and ', { text: 'docs', marks: [link] }, ' roa'])
    r.type('dmap')
    expect(r.text()).toBe('1. See bold and docs roadmap')
    expect(r.hrefs()).toEqual(['https://example.com/x'])
    expect(r.marked('strong')).toBe('bold')
  })
  it('`2) ` 开头的标题、引用里同样不展开', () => {
    const h = rig('heading', ['2) Goo'])
    h.type('dman')
    expect(h.text()).toBe('2) Goodman')
    const q = rig('quote', ['1. Roa'])
    q.type('dmap')
    expect(q.text()).toBe('1. Roadmap')
  })
  it('普通段落开头像列表标记的文字(落盘是转义的)不当列表', () => {
    const r = rig('paragraph', ['1. Roa'])
    r.type('dmap')
    expect(r.text()).toBe('1. Roadmap')
  })
  it('真列表项里照上游展开(词中也展开,上游此片段不看词边界),行里的标记保留、不带缩进', () => {
    const r = rig('olist', ['see ', { text: 'docs', marks: [link] }, ' and ', { text: 'bold', marks: [strong] }, ' roa'])
    r.type('dm')
    expect(r.text()).toBe('see docs and bold roa\n$$\n\n$$')
    expect(r.hrefs()).toEqual(['https://example.com/x'])
    expect(r.marked('strong')).toBe('bold')
    const b = rig('blist', ['Roa'])
    b.type('dm')
    expect(b.text()).toBe('Roa\n$$\n\n$$')
  })
})

describe('S2 dm 的词边界看光标后面的字符', () => {
  it('在已有单词前面插入 dm / admin 不展开(Obsidian 同样不展开)', () => {
    const a = rig('paragraph', ['hello |world'])
    a.type('dm')
    expect(a.text()).toBe('hello dmworld')
    const b = rig('paragraph', ['the |panel'])
    b.type('admin ')
    expect(b.text()).toBe('the admin panel')
    const c = rig('paragraph', ['hello w|orld'])
    c.type('dm')
    expect(c.text()).toBe('hello wdmorld')
  })
  it('行尾、后面是空格时照常展开', () => {
    const a = rig('paragraph', ['hello '])
    a.type('dm')
    expect(a.text()).toBe('hello $$\n\n$$')
    const b = rig('paragraph', ['hello | there'])
    b.type('dm')
    expect(b.text()).toBe('hello $$\n\n$$ there')
  })
})

describe('含 dm 的常见单词(与真 Obsidian 逐条对过)', () => {
  // Obsidian 1.15.1 + Latex Suite 1.12.8 缺省设置:段末或后面是空格时,`admin` 在打出 m 时展开成块级公式
  // (`(\S\s*)dm` 片段,a 前面是空格);`landmark`、`headmaster` 不展开;紧贴下一个词前面打 admin 不展开。
  it.each([
    ['Para text', ' admin', 'Para text a\n$$\nin\n$$'],
    ['Para text', ' landmark', 'Para text landmark'],
    ['Para text', ' headmaster', 'Para text headmaster'],
    ['Para text| here.', ' admin', 'Para text a\n$$\nin\n$$ here.'],
    ['Para text| here.', ' landmark', 'Para text landmark here.'],
    ['Para text| here.', ' headmaster', 'Para text headmaster here.'],
    ['Para text |here.', 'admin', 'Para text adminhere.'],
  ])('%s + %j', (seed, typed, want) => {
    const r = rig('paragraph', [seed])
    r.type(typed)
    expect(r.text()).toBe(want)
  })
})

