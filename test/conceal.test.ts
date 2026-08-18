// conceal 扫描器的单测。这一层是纯字符串进、纯数据出,坏了在这里就该红 ——
// 到编辑器里才看见「某个公式少了半截」要贵十倍,而且 conceal 的错法特别隐蔽:
// 位置差一格不会报错,只会把旁边一个字吞掉。
import { describe, expect, it } from 'vitest'
import type { Node as PmNode } from 'prosemirror-model'
// 装饰层的测试拿真 ProseMirror 当宿主 —— 插件自己**不**依赖这些包(它只吃宿主递进来的 pm 工具箱),
// 这里是在扮演宿主。
import { EditorState, Plugin, PluginKey, Selection, TextSelection, NodeSelection } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { Schema, Slice, Fragment } from 'prosemirror-model'
import { keymap } from 'prosemirror-keymap'
import { InputRule, inputRules } from 'prosemirror-inputrules'
import type { PmToolkit } from '../types/forsion'
import { scanConceal, scanEquation, CLS } from '../src/conceal/scan'
import { hostBlockString, concealPlugins } from '../src/conceal/conceal'

/** 扫一整块文本,把结果拍平成 [from, to, text] 三元组,断言起来直观。 */
const flat = (text: string): Array<[number, number, string]> =>
  scanConceal(text).flatMap((sp) => sp.repls.map((r) => [r.from, r.to, r.text] as [number, number, string]))

/** 按替换清单把源码渲染成「用户看到的样子」—— 比逐个位置断言更能暴露位置错位。 */
function render(text: string): string {
  let out = ''
  let at = 0
  for (const sp of scanConceal(text)) {
    for (const r of sp.repls) {
      out += text.slice(at, r.from) + r.text
      at = r.to
    }
  }
  return out + text.slice(at)
}

describe('命令符号', () => {
  it('希腊字母 / 符号表', () => {
    expect(flat('$\\alpha$')).toEqual([[1, 7, 'α']])
    expect(render('$\\alpha + \\beta$')).toBe('$α + β$')
    expect(render('$a \\cdot b$')).toBe('$a ⋅ b$')
  })

  it('\\sum\\limits 把 \\limits 一起吃掉,否则屏幕上挂一串裸字母', () => {
    // ∑ 的替换范围一直吃到 \limits 末尾(12),下标 `_{i}` 再各算各的
    expect(flat('$\\sum\\limits_{i}$')).toEqual([
      [1, 12, '∑'],
      [12, 16, 'ᵢ'],
    ])
  })

  it('认不出的命令原样放行,绝不吞字', () => {
    expect(flat('$\\zzzz x$')).toEqual([])
  })

  it('`\\\\` 是换行不是宏名 `\\`', () => {
    // 认不出 → 无替换;真正要防的是把 `\\` 后面的 alpha 连着读成命令名
    expect(render('$a \\\\ \\alpha$')).toBe('$a \\\\ α$')
  })
})

describe('分数', () => {
  it('预置分数走 fractions 表', () => {
    expect(flat('$\\frac{1}{2}$')).toEqual([[1, 12, '½']])
  })

  it('一般分数拆成 (a)/(b);中间那个 `/` 并进 `}` 的替换里(同位置两枚 widget 顺序未定义)', () => {
    expect(flat('$\\frac{a}{b}$')).toEqual([
      [1, 6, ''],
      [6, 7, '('],
      [8, 9, ')/'],
      [9, 10, '('],
      [11, 12, ')'],
    ])
    expect(render('$\\frac{a}{b}$')).toBe('$(a)/(b)$')
  })

  it('分子分母内部照样 conceal(扫描器会走进花括号)', () => {
    expect(render('$\\frac{\\alpha}{2}$')).toBe('$(α)/(2)$')
  })

  it('没有两个花括号参数就不动它', () => {
    expect(flat('$\\frac12$')).toEqual([])
  })
})

describe('上下标', () => {
  it('整段都能映射才 conceal', () => {
    expect(render('$x^{2}$')).toBe('$x²$')
    expect(render('$x^2$')).toBe('$x²$')
    expect(render('$x_{ij}$')).toBe('$xᵢⱼ$')
    expect(render('$x^{-1}$')).toBe('$x⁻¹$')
  })

  it('有一个字符映不了就整段原样(上标里套构造不递归,见 scan.ts 文件头的取舍)', () => {
    // map_super 没有 q
    expect(flat('$x^{q}$')).toEqual([])
    // 内容是命令 → 上下标本身不 conceal,但里面的 \alpha 照旧
    expect(render('$x^{\\alpha}$')).toBe('$x^{α}$')
  })
})

describe('字体宏', () => {
  it('mathbb / mathcal / mathfrak', () => {
    expect(flat('$\\mathbb{R}$')).toEqual([[1, 11, 'ℝ']])
    expect(render('$\\mathcal{L}$')).toBe('$𝓛$')
    expect(render('$\\mathfrak{g}$')).toBe('$𝔤$')
  })

  it('有一个字映不了就整个放弃(半个花体比源码更难认)', () => {
    expect(flat('$\\mathcal{1}$')).toEqual([])
  })

  it('mathbf / underline 保留原文,只挂类名', () => {
    const [sp] = scanConceal('$\\mathbf{v}$')
    expect(sp.repls).toEqual([{ from: 1, to: 11, text: 'v', cls: CLS.bold }])
  })
})

describe('重音', () => {
  it('表里有预组合字符就用预组合', () => {
    expect(render('$\\dot{x}$')).toBe('$ẋ$')
    expect(render('$\\bar{a}$')).toBe('$ā$')
  })

  it('表里没有的字母退回组合字符', () => {
    expect(render('$\\hat{q}$')).toBe('$q̂$')
  })

  it('内容不是单个字符就不动(重音只能加在一个字符上)', () => {
    expect(flat('$\\hat{ab}$')).toEqual([])
  })

  it('希腊字母也能戴重音', () => {
    expect(render('$\\vec{\\alpha}$')).toBe('$α⃗$')
  })
})

describe('括号', () => {
  it('\\left\\langle → ⟨(定界符本身能映射时整条换掉)', () => {
    expect(render('$\\left\\langle x\\right\\rangle$')).toBe('$⟨ x⟩$')
  })

  it('\\left( → 只藏 \\left,裸露的 ( 原样显示(cmd_symbols["left"] = "" 这条路径)', () => {
    expect(flat('$\\left(x\\right)$')).toEqual([
      [1, 6, ''],
      [8, 14, ''],
    ])
    expect(render('$\\left(x\\right)$')).toBe('$(x)$')
  })

  it('\\left. 整条藏掉(leftrightBrackets["."] = "")', () => {
    expect(render('$\\left.x$')).toBe('$x$')
  })

  it('裸 \\langle 走 brackets 表', () => {
    expect(render('$\\langle v\\rangle$')).toBe('$⟨ v⟩$')
  })
})

describe('\\not', () => {
  it('整条 \\not\\in 一起换成 ∉(上游只换 \\not、把 \\in 留在屏幕上)', () => {
    expect(flat('$a \\not\\in B$')).toEqual([[3, 10, '∉']])
  })

  it('\\not 后面不是可取反的命令就原样', () => {
    expect(flat('$\\not\\alpha$')).toEqual([[5, 11, 'α']])
  })
})

describe('文本环境', () => {
  it('\\text{...} 内容够干净就显示成正文', () => {
    expect(render('$\\text{hello}$')).toBe('$hello$')
  })

  it('\\text{} 里的 \\alpha **不**变成 α —— 里面是文字不是公式', () => {
    expect(flat('$\\text{\\alpha}$')).toEqual([])
  })

  it('\\begin{align} 的环境名不动,正文照扫', () => {
    expect(render('$$\\begin{align}\\alpha\\end{align}$$')).toBe('$$\\begin{align}α\\end{align}$$')
  })
})

describe('算子', () => {
  it('\\sin → sin(直立体)', () => {
    const [sp] = scanConceal('$\\sin x$')
    expect(sp.repls).toEqual([{ from: 1, to: 5, text: 'sin', cls: CLS.mathrm }])
  })

  it('\\operatorname{foo} → foo', () => {
    expect(render('$\\operatorname{tr} A$')).toBe('$tr A$')
  })
})

describe('公式跨度', () => {
  it('公式外的文字一个都不碰', () => {
    expect(flat('\\alpha 不在公式里')).toEqual([])
    expect(flat('价格 $5 到 $10')).toEqual([])
  })

  it('一块里多段公式各算各的,跨度坐标含定界符', () => {
    const spans = scanConceal('$\\alpha$ 与 $\\beta$')
    expect(spans.length).toBe(2)
    expect([spans[0].from, spans[0].to, spans[0].innerFrom, spans[0].innerTo]).toEqual([0, 8, 1, 7])
    expect(spans[1].repls[0].text).toBe('β')
  })

  it('没有可 conceal 的东西就不产出跨度(省得下游白遍历)', () => {
    expect(scanConceal('$x + y$')).toEqual([])
  })

  it('替换清单按位置升序、互不重叠', () => {
    const repls = scanEquation('\\frac{\\alpha}{\\beta} + \\gamma', 0, 28)
    for (let i = 1; i < repls.length; i++) expect(repls[i].from).toBeGreaterThanOrEqual(repls[i - 1].to)
  })
})

// ── 与宿主 mathLivePreview.buildBlockString 的对齐契约 ────────────────────────────
// 差一个字符就会「宿主渲染了 KaTeX、我们又画一份 conceal」,是本功能最贵的一类 bug。
describe('hostBlockString', () => {
  const node = (children: Array<Record<string, unknown>>): PmNode =>
    ({ forEach: (f: (c: unknown) => void) => children.forEach(f) }) as unknown as PmNode

  const text = (t: string, code = false): Record<string, unknown> => ({
    isText: true,
    text: t,
    nodeSize: t.length,
    marks: code ? [{ type: { name: 'code' } }] : [],
  })
  const br = (): Record<string, unknown> => ({ isText: false, nodeSize: 1, type: { name: 'hardbreak' }, marks: [] })

  it('硬换行 → \\n(blockString 给的是 ￼,行内公式就不认跨行了,「当前行」也切不出来)', () => {
    const s = hostBlockString(node([text('a'), br(), text('b')]))
    expect(s).toBe('a\nb')
    expect(s.length).toBe(3) // 等长覆写:偏移必须与 blockString 严格一致
  })

  it('行内代码的文本 → 等长空格(代码里的 `$` 不是公式)', () => {
    const s = hostBlockString(node([text('x '), text('$a$', true), text(' y')]))
    expect(s).toBe('x     y') // 'x ' + 3 个空格(替掉 `$a$`)+ ' y'
    expect(scanConceal(s)).toEqual([])
  })

  it('普通文本原样,偏移对得上', () => {
    expect(hostBlockString(node([text('$\\alpha$')]))).toBe('$\\alpha$')
  })
})

// ── 装饰这一层:拿**真的** ProseMirror 当宿主跑一遍 ──────────────────────────────
// 扫描器再对,装饰画错地方也是白搭;更要命的是「宿主已经把公式渲染成 KaTeX、我们又画一份」
// 这类双重显示 —— 它只在特定的聚焦/行位组合下出现,靠肉眼在编辑器里撞是撞不全的。
// 这里用真 EditorState + 一枚**冒充宿主 mathLivePreview 的插件**(PluginKey 同名)把闸门钉死。
describe('装饰闸门(与宿主实况预览的分工)', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] as const },
      code_block: { group: 'block', content: 'text*', code: true, toDOM: () => ['pre', 0] as const },
      hard_break: { group: 'inline', inline: true, selectable: false, toDOM: () => ['br'] as const },
      text: { group: 'inline' },
    },
    marks: { code: { toDOM: () => ['code', 0] as const } },
  })

  const pm = {
    Plugin, PluginKey, Selection, TextSelection, NodeSelection,
    Decoration, DecorationSet, Slice, Fragment, keymap, InputRule, inputRules,
  } as unknown as PmToolkit

  /** 冒充宿主的实况预览插件:conceal 只认 PluginKey 名字前缀,认出来就读它的 focus。 */
  const mkHost = (focus: boolean): Plugin =>
    new Plugin({
      key: new PluginKey('amadeus-math-live-preview'),
      state: { init: () => ({ focus }), apply: (_tr, v) => v },
    })

  type Host = 'focused' | 'blurred' | 'absent'

  interface Probe { hidden: Array<[number, number]>; widgets: string[] }

  function probe(
    body: PmNode[],
    cursor: number,
    host: Host,
    opts?: { reveal?: boolean; enabled?: boolean },
  ): Probe {
    const doc = schema.node('doc', null, body)
    const plugins = [
      ...(host === 'absent' ? [] : [mkHost(host === 'focused')]),
      ...concealPlugins(pm, { enabled: () => opts?.enabled ?? true, revealOnCursor: () => opts?.reveal ?? true }),
    ]
    const state = EditorState.create({ doc, plugins, selection: TextSelection.create(doc, cursor) })
    const plugin = plugins[plugins.length - 1]
    const set = plugin.props.decorations?.call(plugin, state) as DecorationSet | null | undefined
    const all = set ? set.find() : []
    return {
      hidden: all.filter((d) => d.from < d.to).map((d) => [d.from, d.to] as [number, number]),
      widgets: all.filter((d) => d.from === d.to).map((d) => String(d.spec.key)),
    }
  }

  const para = (text: string): PmNode => schema.node('paragraph', null, text ? [schema.text(text)] : [])

  // 段落文本 `$\alpha$ x`:块内 `\alpha` 在 [1,7),文档坐标 = +1 → [2,8)
  const ALPHA = '$\\alpha$ x'

  it('聚焦 + 光标不在这段公式里 → conceal', () => {
    expect(probe([para(ALPHA)], 10, 'focused')).toEqual({ hidden: [[2, 8]], widgets: ['ls|α|'] })
  })

  it('光标进了这段公式 → 整段露源码', () => {
    expect(probe([para(ALPHA)], 4, 'focused').hidden).toEqual([])
  })

  it('光标贴在定界符内侧也算「在公式里」(与 mathSpanAt 同口径)', () => {
    expect(probe([para(ALPHA)], 2, 'focused').hidden).toEqual([]) // `$|\alpha$`
    expect(probe([para(ALPHA)], 8, 'focused').hidden).toEqual([]) // `$\alpha|$`
  })

  it('⚠️编辑器失焦 → 宿主把全部公式渲染成 KaTeX,一枚都不能画(否则双重显示)', () => {
    expect(probe([para(ALPHA)], 10, 'blurred')).toEqual({ hidden: [], widgets: [] })
  })

  it('宿主没有实况预览(老版本)→ 源码始终在屏,照常 conceal', () => {
    expect(probe([para(ALPHA)], 10, 'absent').hidden).toEqual([[2, 8]])
  })

  it('⚠️只 conceal 光标所在那一行 —— 别的行宿主已经渲染成 KaTeX 了', () => {
    const multi = schema.node('paragraph', null, [
      schema.text('$\\alpha$'),
      schema.node('hard_break'),
      schema.text('$\\beta$'),
    ])
    // 光标在第一行行尾(块内偏移 8 = 硬换行处),第一行露源码、第二行是 KaTeX
    const got = probe([multi], 9, 'focused')
    expect(got.hidden).toEqual([[2, 8]]) // 只有第一行的 \alpha
    expect(got.widgets).toEqual(['ls|α|'])
  })

  it('代码块里的 $x$ 是字面量,不碰', () => {
    expect(probe([schema.node('code_block', null, [schema.text(ALPHA)])], 3, 'focused').hidden).toEqual([])
  })

  it('行内代码里的 $x$ 同样不碰(宿主也不把它当公式)', () => {
    const p = schema.node('paragraph', null, [schema.text(ALPHA, [schema.marks.code.create()])])
    expect(probe([p], 11, 'focused').hidden).toEqual([])
  })

  it('设置关掉 → 一枚不画', () => {
    expect(probe([para(ALPHA)], 10, 'focused', { enabled: false })).toEqual({ hidden: [], widgets: [] })
  })

  it('revealOnCursor = false → 光标在公式里也照 conceal(此时插入符会藏进 display:none,是该设置的字面含义)', () => {
    expect(probe([para(ALPHA)], 4, 'focused', { reveal: false }).hidden).toEqual([[2, 8]])
  })

  it('多段公式各判各的:光标在前一段,后一段照 conceal', () => {
    const got = probe([para('$\\alpha$ $\\beta$')], 4, 'focused')
    expect(got.hidden).toEqual([[11, 16]]) // 只藏 \beta
    expect(got.widgets).toEqual(['ls|β|'])
  })

  it('\\frac 的五段替换:空替换只藏不画 widget', () => {
    const got = probe([para('$\\frac{a}{b}$')], 14, 'focused')
    expect(got.hidden).toEqual([[2, 7], [7, 8], [9, 10], [10, 11], [12, 13]])
    expect(got.widgets).toEqual(['ls|(|latex-suite-conceal-bracket', 'ls|)/|latex-suite-conceal-bracket', 'ls|(|latex-suite-conceal-bracket', 'ls|)|latex-suite-conceal-bracket'])
  })

  // ── 下面两条钉的是自审补的两处硬化,不是锦上添花:少了它们,回归时没有任何红灯 ────────
  /** 与 probe 同款,但把 plugin / state 交回来 —— 这两条要**重复调** decorations()。 */
  function rig(text: string, cursor: number, flags: { enabled: boolean }) {
    const doc = schema.node('doc', null, [para(text)])
    const plugins = [mkHost(true), ...concealPlugins(pm, { enabled: () => flags.enabled, revealOnCursor: () => true })]
    const state = EditorState.create({ doc, plugins, selection: TextSelection.create(doc, cursor) })
    const plugin = plugins[plugins.length - 1]
    const decosAt = (s: EditorState): DecorationSet | null =>
      (plugin.props.decorations?.call(plugin, s) as DecorationSet | null | undefined) ?? null
    return { plugin, state, decosAt }
  }

  it('设置关掉**立刻**不画 —— 不必等下一个事务把 blocks 清空', () => {
    const flags = { enabled: true }
    const { state, decosAt } = rig(ALPHA, 10, flags)
    expect(decosAt(state)?.find().length).toBe(2) // 一枚 display:none + 一枚 widget
    flags.enabled = false
    expect(decosAt(state)).toBeNull() // state 一个字没变,只是设置翻了
  })

  it('⚠️输入法合成期 doc 没变 → 原样交回上一份装饰(选区变化不许改「哪些段该藏」)', () => {
    const { plugin, state, decosAt } = rig(ALPHA, 10, { enabled: true })
    const before = decosAt(state)
    expect(before?.find().length).toBe(2)

    // 挂一个「正在合成」的 view(这里只用得着 composing 这一个字段)
    const pv = plugin.spec.view?.({ composing: true } as unknown as EditorView)
    // 把光标挪进公式里:平时这一步会整段露源码,合成期必须冻结成同一个对象
    const moved = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 4)))
    expect(decosAt(moved)).toBe(before)

    // 反证:没有合成态时,同一次移动确实会露源码 —— 否则上面那条断言等于什么都没测
    const plain = rig(ALPHA, 4, { enabled: true })
    expect(plain.decosAt(plain.state)?.find().filter((d) => d.from < d.to).length ?? 0).toBe(0)

    pv?.destroy?.()
  })
})
