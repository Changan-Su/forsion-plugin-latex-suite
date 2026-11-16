// 正文片段缺省开以后的两处边界(评审复现过):
//   S1 列表里的 dm 只认真列表项;展开只改 dm 那一段,行里的链接、加粗原样留着;
//   S2 词边界看光标后面真实的字符(在已有单词前面插入 dm 不展开,上游同样)。
// 期望值来自真 Obsidian 1.15.1 + Latex Suite 1.12.8 缺省设置下的实测。
import { describe, expect, it } from 'vitest'
import { Schema, Slice, Fragment, type Mark, type Node as PmNode } from 'prosemirror-model'
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
    table: { group: 'block', content: 'table_row+' },
    table_row: { content: 'table_cell+' },
    table_cell: { content: 'paragraph' },
    image: { inline: true, group: 'inline', atom: true },
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
  return boot(doc, start + (caretAt >= 0 ? caretAt : offset))
}

/** 任意文档:光标放在文本里的 `§` 处(这个字符本身删掉)。 */
function rigDoc(doc: PmNode) {
  let at = -1
  doc.descendants((n, p) => { if (at < 0 && n.isText && n.text!.includes('§')) at = p + n.text!.indexOf('§'); return at < 0 })
  const clean = EditorState.create({ schema, doc }).tr.delete(at, at + 1).doc
  return boot(clean, at)
}

function boot(doc: PmNode, caret: number) {
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
  /** 每个文本块一项;原子节点记成 <名字>,hard break 记成 ⏎。 */
  const blocks = () => {
    const out: string[] = []
    view.state.doc.descendants((n) => { if (n.isTextblock) out.push(n.textBetween(0, n.content.size, '⏎', (l) => (l.type.name === 'hard_break' ? '⏎' : `<${l.type.name}>`))); return true })
    return out
  }
  return { type, text, blocks, marked, hrefs, settings }
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
  it('真列表项里独立的 dm 照常展开,行里的标记保留、不带缩进', () => {
    const r = rig('olist', ['see ', { text: 'docs', marks: [link] }, ' and ', { text: 'bold', marks: [strong] }, ' '])
    r.type('dm')
    expect(r.text()).toBe('see docs and bold \n$$\n\n$$')
    expect(r.hrefs()).toEqual(['https://example.com/x'])
    expect(r.marked('strong')).toBe('bold')
    const b = rig('blist', [''])
    b.type('dm')
    expect(b.text()).toBe('\n$$\n\n$$')
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

describe('dm 只在独立成词时展开(与 Obsidian 不同,有意为之)', () => {
  // 真 Obsidian 1.15.1 + Latex Suite 1.12.8 缺省设置下,段末或空格前打 admin 会在打出 m 时变成块级公式
  // (`(\S\s*)dm`),列表项里含 dm 的词(roadmap、landmark)也会。Forsion 的缺省片段改成 dm 前面必须是
  // 行首或空白:含 dm 的单词一律不展开,独立的 dm 照旧。以 dm 开头的词(dmesg)打到 m 时仍会展开。
  const words = ['admin', 'admit', 'Admiral', 'landmark', 'headmaster']
  it.each(words)('段落末尾打 %s 不展开', (w) => {
    const r = rig('paragraph', ['Para text'])
    r.type(` ${w}`)
    expect(r.text()).toBe(`Para text ${w}`)
  })
  it.each(words)('行中间(后面是空格)打 %s 不展开', (w) => {
    const r = rig('paragraph', ['Para text| here.'])
    r.type(` ${w}`)
    expect(r.text()).toBe(`Para text ${w} here.`)
  })
  it('列表项里打 roadmap、landmark 不展开,行里的标记原样', () => {
    const a = rig('blist', ['Roa'])
    a.type('dmap')
    expect(a.text()).toBe('Roadmap')
    const b = rig('blist', ['Para text'])
    b.type(' landmark')
    expect(b.text()).toBe('Para text landmark')
    const c = rig('olist', ['see ', { text: 'docs', marks: [link] }, ' and ', { text: 'bold', marks: [strong] }, ' roa'])
    c.type('dmap')
    expect(c.text()).toBe('see docs and bold roadmap')
    expect(c.hrefs()).toEqual(['https://example.com/x'])
    expect(c.marked('strong')).toBe('bold')
  })
  it.each([
    ['paragraph', 'hello ', 'dm', 'hello $$\n\n$$'],
    ['paragraph', 'text', ' dm', 'text $$\n\n$$'],
    ['paragraph', 'send a', ' dm', 'send a \n$$\n\n$$'],
    ['paragraph', 'Para text| here.', ' dm', 'Para text $$\n\n$$ here.'],
    ['blist', '文字', ' dm', '文字 \n$$\n\n$$'],
    ['blist', '', 'dm', '\n$$\n\n$$'],
    ['paragraph', 'hello ', 'mk', 'hello $$'],
  ] as [Block, string, string, string][])('独立的 dm / mk 照常展开:%s %j + %j', (block, seed, typed, want) => {
    const r = rig(block, seed ? [seed] : [])
    r.type(typed)
    expect(r.text()).toBe(want)
  })
  it.each([
    ['paragraph', 'Forsion', '.dmg'], ['paragraph', 'installer', '.dmg'], ['paragraph', 'see report', '.dmg'],
    ['paragraph', 'a non', '-dm'], ['paragraph', 'path', '/dm'], ['paragraph', 'call', '(dm'], ['paragraph', 'x', ':dm'],
    ['blist', 'see report', '.dmg'], ['blist', 'a non', '-dm'], ['blist', 'path', '/dm'],
  ] as [Block, string, string][])('紧跟在标点后的 dm 不展开(文件名、连字符、路径):%s %j + %j', (block, seed, typed) => {
    const r = rig(block, [seed])
    r.type(typed)
    expect(r.text()).toBe(seed + typed)
  })
  it('残留:以 dm 开头的词在打到 m 时仍会展开(dmesg、dmg)', () => {
    const r = rig('paragraph', ['Para text'])
    r.type(' dmesg')
    expect(r.text()).toBe('Para text $$\nesg\n$$')
    const g = rig('paragraph', ['open'])
    g.type(' dmg')
    expect(g.text()).toBe('open $$\ng\n$$')
  })
})


// 下面两条的期望来自上游列表正则在 Obsidian 源码行上的实际结果(续段 `  second roadm`、
// 表格行 `  | roadm |` 都不触发),以及上游词边界看的是落盘文本(图片 `![[…]]` 的 `!` 是分隔符)。
const nd = (t: string, ...c: PmNode[]) => schema.node(t, null, c)
const tx = (s: string) => schema.text(s)

describe('F3 列表里的 dm 只认列表项的第一个段落', () => {
  // 用独立的 dm:列表片段出的是「前文⏎$$」,普通 dm 出的是「前文 $$」,两者分得开。
  it('同一项的第二段里打 dm 走普通 dm,不出列表块公式', () => {
    const r = rigDoc(nd('doc', nd('bullet_list', nd('list_item', nd('paragraph', tx('first')), nd('paragraph', tx('second §'))))))
    r.type('dm')
    expect(r.blocks()).toEqual(['first', 'second $$⏎⏎$$'])
  })
  it('列表项里的表格单元格里打 dm 走普通 dm', () => {
    const r = rigDoc(nd('doc', nd('bullet_list', nd('list_item', nd('paragraph', tx('first')),
      nd('table', nd('table_row', nd('table_cell', nd('paragraph', tx('xy §'))), nd('table_cell', nd('paragraph', tx('y')))))))))
    r.type('dm')
    expect(r.blocks()).toEqual(['first', 'xy $$⏎⏎$$', 'y'])
  })
  it('嵌套列表项的第一个段落出列表块公式', () => {
    const r = rigDoc(nd('doc', nd('bullet_list', nd('list_item', nd('paragraph', tx('outer')), nd('bullet_list', nd('list_item', nd('paragraph', tx('inner §'))))))))
    r.type('dm')
    expect(r.blocks()).toEqual(['outer', 'inner ⏎$$⏎⏎$$'])
  })
})

describe('F4 紧贴行内原子节点(图片、芯片)打 dm 照常展开', () => {
  it('图片前面打 dm', () => {
    const r = rigDoc(nd('doc', nd('paragraph', tx('hello §'), schema.node('image'))))
    r.type('dm')
    expect(r.blocks()).toEqual(['hello $$⏎⏎$$<image>'])
  })
})
