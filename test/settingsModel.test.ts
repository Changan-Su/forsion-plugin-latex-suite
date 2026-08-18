// 设置模型的单测。重点只有一个:**默认片段库的字符串形态**必须能原样读回来。
//
// 为什么这条值得钉死:defaults.ts 是带正则字面量和函数的 TS 数组,设置面板里编辑的却是文本,
// 中间靠 serializeRawSnippets 转一道。这一步一旦漂了(比如有人顺手改成 JSON.stringify),
// 用户点「恢复默认」拿到的会是一份 `{}` 满地的废片段库 —— 而且要等到他真去点才发现。
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, serializeRawSnippets, splitList } from '../src/settingsUi/model'
import { DEFAULT_SNIPPETS } from '../src/snippets/defaults'
import { evalSnippetSource, parseSnippets } from '../src/snippets/parse'
import { DEFAULT_SNIPPET_VARIABLES } from '../src/snippets/variables'

describe('默认片段库的文本形态', () => {
  const text = DEFAULT_SETTINGS.snippetsSourceText

  it('能被片段解析器原样读回', () => {
    const { raw, error } = evalSnippetSource(text)
    expect(error).toBeUndefined()
    expect(raw.length).toBe(DEFAULT_SNIPPETS.length)
  })

  it('正则触发串仍是正则、函数替换仍是函数', () => {
    const { raw } = evalSnippetSource(text)
    const regexes = (list: typeof raw): number => list.filter((s) => s.trigger instanceof RegExp).length
    const fns = (list: typeof raw): number => list.filter((s) => typeof s.replacement === 'function').length
    expect(regexes(raw)).toBe(regexes(DEFAULT_SNIPPETS))
    expect(fns(raw)).toBe(fns(DEFAULT_SNIPPETS))
    expect(regexes(raw)).toBeGreaterThan(0)
    expect(fns(raw)).toBeGreaterThan(0)
  })

  it('逐条对得上(触发串、选项、优先级、描述)', () => {
    const { raw } = evalSnippetSource(text)
    const key = (s: { trigger: unknown; replacement: unknown; options?: string; priority?: number; description?: string }): string =>
      [String(s.trigger), typeof s.replacement === 'function' ? 'fn' : String(s.replacement), s.options ?? '', s.priority ?? '', s.description ?? ''].join('|')
    expect(raw.map(key)).toEqual(DEFAULT_SNIPPETS.map(key))
  })

  it('完整解析成 Snippet[] 时零错误', () => {
    const parsed = parseSnippets(text, DEFAULT_SNIPPET_VARIABLES)
    expect(parsed.errors).toEqual([])
    expect(parsed.snippets.length).toBeGreaterThan(100)
  })

  it('序列化不吃掉附加字段', () => {
    const out = serializeRawSnippets([
      { trigger: /a(\d)/, replacement: 'x', options: 'mA', priority: 3, description: '说明', flags: 'i', excludedEnvironments: ['align'] },
    ])
    const { raw, error } = evalSnippetSource(out)
    expect(error).toBeUndefined()
    expect(raw[0].flags).toBe('i')
    expect(raw[0].priority).toBe(3)
    expect(raw[0].excludedEnvironments).toEqual(['align'])
  })
})

describe('默认设置里的两段 JSON 文本', () => {
  it('片段变量是合法 JSON', () => {
    expect(JSON.parse(DEFAULT_SETTINGS.snippetVariablesSourceText)).toEqual(DEFAULT_SNIPPET_VARIABLES)
  })
  it('自动分式排除环境是合法 JSON,且反斜杠没被吃掉', () => {
    expect(JSON.parse(DEFAULT_SETTINGS.autofractionExcludedEnvs)).toEqual([['^{', '}'], ['\\pu{', '}']])
  })
  it('词分隔符里的 \\n 是两个字符的字面量,不是换行', () => {
    expect(DEFAULT_SETTINGS.wordDelimiters).toContain('\\n')
    expect(DEFAULT_SETTINGS.wordDelimiters).not.toContain('\n')
  })
})

describe('mergeSettings 的防御', () => {
  it('空 / 坏输入一律给默认', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings('nope')).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings([])).toEqual(DEFAULT_SETTINGS)
  })
  it('认识的键照收', () => {
    expect(mergeSettings({ snippetsEnabled: false, concealRevealTimeout: 300 }).concealRevealTimeout).toBe(300)
    expect(mergeSettings({ snippetsEnabled: false }).snippetsEnabled).toBe(false)
  })
  it('类型不对 / 负数 / 非法枚举一律丢弃', () => {
    expect(mergeSettings({ snippetsEnabled: 'yes' }).snippetsEnabled).toBe(true)
    expect(mergeSettings({ concealRevealTimeout: -5 }).concealRevealTimeout).toBe(0)
    expect(mergeSettings({ concealRevealTimeout: Number.NaN }).concealRevealTimeout).toBe(0)
    expect(mergeSettings({ snippetsTrigger: 'Enter' }).snippetsTrigger).toBe('Tab')
    expect(mergeSettings({ snippetsSource: 'vault' }).snippetsSource).toBe('user')
  })
  it('不认识的键不会混进来(旧版残留不复活)', () => {
    expect(Object.keys(mergeSettings({ vimEnabled: true }))).toEqual(Object.keys(DEFAULT_SETTINGS))
  })
})

describe('splitList', () => {
  it('去空白后按逗号切,空项丢掉', () => {
    expect(splitList('sum, int, frac')).toEqual(['sum', 'int', 'frac'])
    expect(splitList(' a ,, b ')).toEqual(['a', 'b'])
    expect(splitList('')).toEqual([])
  })
})
