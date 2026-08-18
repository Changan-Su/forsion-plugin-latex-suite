// 纯逻辑的单测:片段匹配、模式判定、tabstop 解析、数学模式扫描。
// 这一层不碰 ProseMirror,坏了在这里就该红 —— 到编辑器里才发现要贵十倍。
import { describe, expect, it } from 'vitest'
import { matchSnippet, onWordBoundary, parseOptions, shouldRunInMode, sortSnippets, trimReplacementWhitespace, type Snippet } from '../src/snippets/model'
import { parseTabstops } from '../src/snippets/tabstopParse'
import { parseSnippets } from '../src/snippets/parse'
import { mathContext, scanMath, inTextEnv, envNamesAt, openMathAt } from '../src/editor/mathMode'
import { DEFAULT_SNIPPETS } from '../src/snippets/defaults'
import { DEFAULT_SNIPPET_VARIABLES } from '../src/snippets/variables'
import { normalizeSnippets } from '../src/snippets/parse'

describe('options 标志', () => {
  it('m = 行内+块级数学', () => {
    const o = parseOptions('mA')
    expect(o.mode.inlineMath).toBe(true)
    expect(o.mode.blockMath).toBe(true)
    expect(o.automatic).toBe(true)
  })
  it('n 只行内、M 只块级', () => {
    expect(parseOptions('n').mode.blockMath).toBe(false)
    expect(parseOptions('M').mode.inlineMath).toBe(false)
  })
  it('不写模式标志 = 全模式(向后兼容)', () => {
    const o = parseOptions('A')
    expect(o.mode.text && o.mode.inlineMath && o.mode.blockMath).toBe(true)
  })
  it('U 关掉 undoKey,默认开', () => {
    expect(parseOptions('').undoKey).toBe(true)
    expect(parseOptions('U').undoKey).toBe(false)
  })
})

describe('模式匹配', () => {
  const cur = (p: Partial<ReturnType<typeof parseOptions>['mode']>) =>
    ({ text: false, inlineMath: false, blockMath: false, codeBlock: false, textEnv: false, ...p })

  it('数学片段在数学里跑', () => {
    expect(shouldRunInMode(parseOptions('m').mode, cur({ inlineMath: true }))).toBe(true)
  })
  it('数学片段在 \\text{} 里不跑', () => {
    expect(shouldRunInMode(parseOptions('m').mode, cur({ inlineMath: true, textEnv: true }))).toBe(false)
  })
  it('文本片段在公式的 \\text{} 里照跑', () => {
    expect(shouldRunInMode(parseOptions('t').mode, cur({ inlineMath: true, textEnv: true }))).toBe(true)
  })
  it('数学片段在正文里不跑', () => {
    expect(shouldRunInMode(parseOptions('m').mode, cur({ text: true }))).toBe(false)
  })
})

describe('片段匹配', () => {
  const mk = (over: Partial<Snippet>): Snippet => ({
    type: 'string',
    trigger: '@a',
    replacement: '\\alpha',
    options: parseOptions('mA'),
    priority: 0,
    description: '',
    excludedEnvironments: [],
    excludedMacros: [],
    triggerSource: '@a',
    ...over,
  })

  it('字符串触发:行尾命中', () => {
    const r = matchSnippet(mk({}), 'x + @a', '')
    expect(r).toEqual({ triggerPos: 4, insert: '\\alpha' })
  })
  it('字符串触发:不在行尾不命中', () => {
    expect(matchSnippet(mk({}), '@a + x', '')).toBeNull()
  })
  it('有选区时非 visual 片段不跑', () => {
    expect(matchSnippet(mk({}), 'x@a', 'sel')).toBeNull()
  })
  it('正则触发 + [[n]] 捕获组', () => {
    const s = mk({ type: 'regex', trigger: /(?:([A-Za-z])(\d))$/, replacement: '[[0]]_{[[1]]}' })
    const r = matchSnippet(s, 'x2', '')
    expect(r?.insert).toBe('x_{2}')
  })
  it('visual 片段:${VISUAL} 换成选区', () => {
    const s = mk({ type: 'visual', trigger: 'U', replacement: '\\underbrace{${VISUAL}}', options: parseOptions('mAv') })
    expect(matchSnippet(s, 'U', 'abc')?.insert).toBe('\\underbrace{abc}')
  })
  it('visual 片段没有选区就不跑', () => {
    const s = mk({ type: 'visual', trigger: 'U', replacement: 'x${VISUAL}', options: parseOptions('mAv') })
    expect(matchSnippet(s, 'U', '')).toBeNull()
  })
  it('替换函数返回 false = 本次不展开', () => {
    const s = mk({ replacement: () => false })
    expect(matchSnippet(s, '@a', '')).toBeNull()
  })
})

describe('排序', () => {
  it('优先级高的在前;平手时触发串长的在前', () => {
    const mk = (trigger: string, priority: number): Snippet => ({
      type: 'string', trigger, replacement: 'x', options: parseOptions(''),
      priority, description: '', excludedEnvironments: [], excludedMacros: [], triggerSource: trigger,
    })
    const out = sortSnippets([mk('a', 0), mk('abc', 0), mk('z', 5)])
    expect(out.map((s) => s.trigger)).toEqual(['z', 'abc', 'a'])
  })
})

describe('词边界', () => {
  it('前后都是分隔符才算', () => {
    expect(onWordBoundary('a bar ', 2, 5, ' \n\t')).toBe(true)
    expect(onWordBoundary('abar ', 1, 4, ' \n\t')).toBe(false)
  })
  it('行首行尾视作边界', () => {
    expect(onWordBoundary('bar', 0, 3, ' \n\t')).toBe(true)
  })
})

describe('tabstop 解析', () => {
  it('$0 是第一个占位点(不是 LSP 那套"最终光标")', () => {
    const r = parseTabstops('\\frac{$0}{$1}')
    expect(r.text).toBe('\\frac{}{}')
    expect(r.groups.map((g) => g.index)).toEqual([0, 1])
    expect(r.groups[0].ranges[0]).toEqual({ from: 6, to: 6 })
  })
  it('${n:默认值} 就地展开并覆盖该段', () => {
    const r = parseTabstops('\\sqrt[${0:2}]{$1}')
    expect(r.text).toBe('\\sqrt[2]{}')
    expect(r.groups[0].ranges[0]).toEqual({ from: 6, to: 7 })
  })
  it('同下标出现两次 = 一组联动位点', () => {
    const r = parseTabstops('\\begin{$0}\n$1\n\\end{$0}')
    expect(r.groups[0].ranges).toHaveLength(2)
  })
  it('字面 $ 不被误吃($$ 定界符要原样留下)', () => {
    const r = parseTabstops('$$\n$0\n$$')
    expect(r.text).toBe('$$\n\n$$')
    expect(r.groups).toHaveLength(1)
  })
  it('连续空格被压掉、位点跟着搬(宿主的 md 往返会压空格,不压就会重载文档抹掉位点)', () => {
    const r = parseTabstops('\\sqrt{ $0 }$1')
    expect(r.text).toBe('\\sqrt{ }')
    expect(r.groups[0].ranges[0]).toEqual({ from: 7, to: 7 }) // 空格之后、`}` 之前
    expect(r.groups[1].ranges[0]).toEqual({ from: 8, to: 8 })
  })
  it('单个空格不动', () => {
    expect(parseTabstops('\\sum $0').text).toBe('\\sum $0'.replace('$0', ''))
  })
  it('换行与行首缩进不动', () => {
    expect(parseTabstops('a\n    b$0').text).toBe('a\n    b')
  })
  it('mk 片段:$$0$ → $|$', () => {
    const r = parseTabstops('$$0$')
    expect(r.text).toBe('$$')
    expect(r.groups[0].ranges[0]).toEqual({ from: 1, to: 1 })
  })
})

describe('数学模式扫描', () => {
  it('行内公式', () => {
    const s = scanMath('前 $x+1$ 后')
    expect(s).toHaveLength(1)
    expect(s[0].display).toBe(false)
  })
  it('货币不误伤', () => {
    expect(scanMath('花了 $5 和 $10 块')).toHaveLength(0)
  })
  it('块级公式优先', () => {
    const s = scanMath('$$ e^{i\\pi} $$')
    expect(s[0].display).toBe(true)
  })
  it('光标在公式里 = 数学模式', () => {
    const line = '$x+'
    const c = mathContext(line, line.length, { inCodeBlock: false })
    expect(c.mode.inlineMath).toBe(true)
  })
  it('光标在正文里 = 文本模式', () => {
    const c = mathContext('普通一句话', 3, { inCodeBlock: false })
    expect(c.mode.text).toBe(true)
  })
  it('代码块里既不是数学也不是正文', () => {
    const c = mathContext('$x$', 2, { inCodeBlock: true })
    expect(c.mode.codeBlock).toBe(true)
    expect(c.mode.inlineMath).toBe(false)
  })
  it('未闭合的 $ 也算进了公式(边打边判)', () => {
    const text = '$\\alp'
    expect(openMathAt(text, text.length, scanMath(text))?.at).toBe(1)
  })
  it('\\text{} 里算文本环境', () => {
    const t = '$a + \\text{里面 '
    expect(inTextEnv(t, 1, t.length)).toBe(true)
  })
  it('出了 \\text{} 就不算', () => {
    const t = '$a + \\text{x} + '
    expect(inTextEnv(t, 1, t.length)).toBe(false)
  })
  it('环境栈', () => {
    const t = '$$\\begin{align}\\begin{cases}x'
    expect(envNamesAt(t, 2, t.length)).toEqual(['align', 'cases'])
  })
})

describe('替换文本尾空格', () => {
  it('尾随空格去掉', () => {
    expect(trimReplacementWhitespace('\\alpha ')).toBe('\\alpha')
  })
  it('" $0" 保住占位点、只吃掉那个空格', () => {
    expect(trimReplacementWhitespace('\\sum $0')).toBe('\\sum$0')
  })
})

describe('片段库解析', () => {
  it('JS 数组(含正则字面量)可解析', () => {
    const r = parseSnippets('[{trigger: /x(\\d)/, replacement: "y[[0]]", options: "mAr"}]', {})
    expect(r.errors).toEqual([])
    expect(r.snippets).toHaveLength(1)
    expect(r.snippets[0].type).toBe('regex')
  })
  it('正则被锚到行尾', () => {
    const r = parseSnippets('[{trigger: "ab", replacement: "x", options: "mAr"}]', {})
    expect((r.snippets[0].trigger as RegExp).source).toBe('(?:ab)$')
  })
  it('片段变量代入 trigger', () => {
    const r = parseSnippets('[{trigger: "@${GREEK}", replacement: "x", options: "mAr"}]', { '${GREEK}': '(?:alpha|beta)' })
    expect((r.snippets[0].trigger as RegExp).source).toContain('alpha')
  })
  it('坏正则报错但不炸整份库', () => {
    const r = parseSnippets('[{trigger: "([", replacement: "x", options: "mAr"}, {trigger: "ok", replacement: "y", options: "mA"}]', {})
    expect(r.errors).toHaveLength(1)
    expect(r.snippets).toHaveLength(1)
  })
  it('不是数组 → 一条人话错误,不抛', () => {
    expect(parseSnippets('{}', {}).errors[0]).toContain('数组')
  })
  it('语法错 → 一条人话错误,不抛', () => {
    expect(parseSnippets('[{trigger:', {}).errors[0]).toContain('解析失败')
  })
})

describe('默认片段表', () => {
  it('全部能规范化,一条不丢、零错误', () => {
    const r = normalizeSnippets(DEFAULT_SNIPPETS, DEFAULT_SNIPPET_VARIABLES)
    expect(r.errors).toEqual([])
    // 与源表逐条对齐:少一条就说明规范化把某种写法悄悄吃掉了(上游 200 条出头)。
    expect(r.snippets).toHaveLength(DEFAULT_SNIPPETS.length)
    expect(DEFAULT_SNIPPETS.length).toBeGreaterThan(150)
  })
  it('`mk` 在正文里展开成行内公式', () => {
    const r = normalizeSnippets(DEFAULT_SNIPPETS, DEFAULT_SNIPPET_VARIABLES)
    const mk = r.snippets.find((s) => s.trigger === 'mk')
    expect(mk).toBeTruthy()
    expect(parseTabstops(mk!.replacement as string).text).toBe('$$')
  })
  it('`@a` 只在数学模式里跑', () => {
    const r = normalizeSnippets(DEFAULT_SNIPPETS, DEFAULT_SNIPPET_VARIABLES)
    const a = r.snippets.find((s) => s.trigger === '@a')!
    expect(a.options.mode.inlineMath).toBe(true)
    expect(a.options.mode.text).toBe(false)
  })
})
