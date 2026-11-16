// 设置模型的单测。重点只有一个:**默认片段库的字符串形态**必须能原样读回来。
//
// 为什么这条值得钉死:defaults.ts 是带正则字面量和函数的 TS 数组,设置面板里编辑的却是文本,
// 中间靠 serializeRawSnippets 转一道。这一步一旦漂了(比如有人顺手改成 JSON.stringify),
// 用户点「恢复默认」拿到的会是一份 `{}` 满地的废片段库 —— 而且要等到他真去点才发现。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, DEFAULTS_REVISION, DEFAULTS_REVISION_KEY, mergeSettings, migrateDefaultSnippets, migrateDefaultSnippetsWith, releasedDefaultFingerprints, revisionToSave, savedDefaultsRevision, serializeRawSnippets, splitList, textFingerprint } from '../src/settingsUi/model'
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
      { trigger: /a(\d)/, replacement: 'x', options: 'mA', priority: 3, description: '说明', flags: 'i', excludedEnvironments: ['align'], excludedMacros: ['ce', { name: 'pu' }], triggerAfter: /abc/i },
    ])
    const { raw, error } = evalSnippetSource(out)
    expect(error).toBeUndefined()
    expect(raw[0].flags).toBe('i')
    expect(raw[0].priority).toBe(3)
    expect(raw[0].excludedEnvironments).toEqual(['align'])
    expect(raw[0].excludedMacros).toEqual(['ce', { name: 'pu' }])
    expect(String(raw[0].triggerAfter)).toBe('/abc/i')
  })

  it('默认化学宏排除规则在序列化后仍完整保留', () => {
    const { raw } = evalSnippetSource(text)
    expect(raw.filter((s) => s.excludedMacros?.length).map((s) => s.excludedMacros))
      .toEqual(DEFAULT_SNIPPETS.filter((s) => s.excludedMacros?.length).map((s) => s.excludedMacros))
  })

})

// 已发布版本写进用户设置的缺省片段库(各版 main.js 运行时序列化出来的原文,函数体是压缩后的)。
// 只有设置里还没有修订号、而且逐字等于其中之一才换成新缺省;改过一个字的一律原样。
describe('旧版缺省片段库升级到新缺省', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/default-snippets')
  const released = ['1.0.0.txt', '1.0.0-reset.txt', '1.1.0-1.1.2.txt']
  const read = (name: string) => readFileSync(path.join(dir, name), 'utf8')
  it.each(released)('%s 逐字相同 → 换成新缺省', (name) => {
    expect(migrateDefaultSnippets(read(name), 0)).toBe(DEFAULT_SETTINGS.snippetsSourceText)
  })
  it.each(released)('%s 改过一个字、多一个换行、删一条 → 原样不动', (name) => {
    const text = read(name)
    const i = text.indexOf('mk')
    const edited = [text.slice(0, i) + 'mK' + text.slice(i + 2), `${text}\n`, text.replace(/\n[^\n]*\n/, '\n')]
    for (const e of edited) expect(migrateDefaultSnippets(e, 0)).toBe(e)
  })
  // 登记新一版时同步改这条(released 列表和按修订号的期望),步骤见 fixtures/default-snippets/README.md。
  it('源码里登记的指纹就是这几份原文的指纹(都登记在修订号 0 下)', () => {
    expect(released.map((n) => textFingerprint(read(n)))).toEqual(['16070:dt9o15zarg', '16070:27f1a4kcj2g', '16123:1tpdwu6y71w'])
    expect(releasedDefaultFingerprints()).toEqual({ 0: released.map((n) => textFingerprint(read(n))) })
  })
  it.each(released)('%s 存过修订号(当前或更新)或修订号认不出 → 原样不动', (name) => {
    const text = read(name)
    for (const rev of [DEFAULTS_REVISION, DEFAULTS_REVISION + 1, null]) expect(migrateDefaultSnippets(text, rev)).toBe(text)
  })
  it('修订号:没有 = 0,非负整数照读,其余认不出', () => {
    expect(DEFAULTS_REVISION_KEY).toBe('latexSuiteDefaultsRevision')
    expect(DEFAULTS_REVISION_KEY in DEFAULT_SETTINGS).toBe(false)
    expect(mergeSettings({ [DEFAULTS_REVISION_KEY]: 1 })).not.toHaveProperty(DEFAULTS_REVISION_KEY)
    for (const [saved, rev] of [[null, 0], [{}, 0], [{ snippetsSourceText: 'x' }, 0], [{ [DEFAULTS_REVISION_KEY]: 0 }, 0], [{ [DEFAULTS_REVISION_KEY]: 3 }, 3],
      [{ [DEFAULTS_REVISION_KEY]: '1' }, null], [{ [DEFAULTS_REVISION_KEY]: -1 }, null], [{ [DEFAULTS_REVISION_KEY]: 1.5 }, null], [{ [DEFAULTS_REVISION_KEY]: null }, null]] as const) {
      expect(savedDefaultsRevision(saved)).toBe(rev)
    }
  })
  it('scripts/dump-default-snippets.mjs 取的是打包产物运行时的原文,指纹和源码算法一致', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'latex-suite-dump-'))
    try {
      const file = path.join(tmp, 'default.txt')
      const printed = execFileSync(process.execPath, ['scripts/dump-default-snippets.mjs', 'main.js', '--out', file], { cwd: root, encoding: 'utf8' })
      const runtime = readFileSync(file, 'utf8')
      expect(printed.trim()).toBe(`default  ${textFingerprint(runtime)}`)
      // 打包产物里的函数体是压缩过的:和 vitest 里的原文不同,登记时只能用这份。
      expect(runtime).not.toBe(DEFAULT_SETTINGS.snippetsSourceText)
      const count = (t: string) => parseSnippets(t, DEFAULT_SNIPPET_VARIABLES).snippets.length
      expect(count(runtime)).toBe(count(DEFAULT_SETTINGS.snippetsSourceText))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
  it('保存时的修订号:没有写当前;读得懂的取较大的;读不懂的原样写回', () => {
    expect(revisionToSave(null)).toBe(DEFAULTS_REVISION)
    expect(revisionToSave({})).toBe(DEFAULTS_REVISION)
    expect(revisionToSave({ [DEFAULTS_REVISION_KEY]: 0 })).toBe(DEFAULTS_REVISION)
    expect(revisionToSave({ [DEFAULTS_REVISION_KEY]: DEFAULTS_REVISION + 1 })).toBe(DEFAULTS_REVISION + 1)
    for (const odd of ['1', 1.5, -1, null, true, {}, []]) expect(revisionToSave({ [DEFAULTS_REVISION_KEY]: odd })).toBe(odd)
  })
  // 模拟下一版:修订号升到 2,本版缺省(修订号 1 时发布)登记在第 1 张表。
  describe('下一版的迁移对照从存的修订号起的每一张旧表', () => {
    const tables = { 0: { [textFingerprint(read('1.1.0-1.1.2.txt'))]: '1.1.0 - 1.1.2' }, 1: { [textFingerprint(DEFAULT_SETTINGS.snippetsSourceText)]: 'this release' } }
    const next = { revision: 2, tables, current: 'NEXT' }
    it('没有修订号(被 1.1.2 存盘丢掉了)、片段库是本版缺省 → 下一版照样升级', () => {
      expect(migrateDefaultSnippetsWith(DEFAULT_SETTINGS.snippetsSourceText, 0, next)).toBe('NEXT')
      expect(migrateDefaultSnippetsWith(read('1.1.0-1.1.2.txt'), 0, next)).toBe('NEXT')
    })
    it('修订号 1:本版缺省升级;1.1.x 原文是在本版里有意设的,不动', () => {
      expect(migrateDefaultSnippetsWith(DEFAULT_SETTINGS.snippetsSourceText, 1, next)).toBe('NEXT')
      expect(migrateDefaultSnippetsWith(read('1.1.0-1.1.2.txt'), 1, next)).toBe(read('1.1.0-1.1.2.txt'))
    })
    it('修订号 2 或读不懂:一律不动', () => {
      for (const rev of [2, 3, null]) expect(migrateDefaultSnippetsWith(DEFAULT_SETTINGS.snippetsSourceText, rev, next)).toBe(DEFAULT_SETTINGS.snippetsSourceText)
    })
  })
  it('当前缺省、空库、自定义库原样不动', () => {
    for (const t of [DEFAULT_SETTINGS.snippetsSourceText, '[]', '', '[{trigger: "mk", replacement: "$$0$", options: "tA"}]']) {
      expect(migrateDefaultSnippets(t, 0)).toBe(t)
    }
  })
  it('新缺省里 dm 三条要求前面是行首或空白', () => {
    const t = DEFAULT_SETTINGS.snippetsSourceText
    expect(t).toContain('/(\\S\\s+)dm/')
    expect(t).not.toContain('/(\\S\\s*)dm/')
    expect(t).toContain('(?<text>(?:.*\\s)?)dm/')
    expect(t).toContain('/(?<!\\S)dm/')
    expect(t).not.toContain('{trigger: "dm"')
    for (const name of released) expect(read(name)).toContain('/(\\S\\s*)dm/')
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
    expect(mergeSettings({ mathPreviewEnabled: true, proseSnippetsEnabled: true }))
      .toMatchObject({ mathPreviewEnabled: true, proseSnippetsEnabled: true })
  })
  it('正文自动片段:没存过的按新缺省(开),存过 false 的照旧', () => {
    expect(DEFAULT_SETTINGS.proseSnippetsEnabled).toBe(true)
    // 1.1.x 存下的整份设置里没有这个键(或者用户的设置只存了部分键)→ 跟新缺省走。
    expect(mergeSettings({ snippetsEnabled: true, taboutExitEquationOnlyOnEOL: false }).proseSnippetsEnabled).toBe(true)
    // 用户自己关过(或旧版整份落盘时写下的 false)→ 原样保留,不被新缺省翻回去。
    expect(mergeSettings({ proseSnippetsEnabled: false }).proseSnippetsEnabled).toBe(false)
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
