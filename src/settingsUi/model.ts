// 设置模型 —— 插件的**唯一**设置真源(主入口 import 这里,不要另建一份形状)。
//
// 与上游 settings.ts 的差异(**刻意**):
//  1. 上游把「片段从哪来」拆成 `loadSnippetsFromFile: boolean` + 一个既可填文件也可填文件夹的路径框,
//     用户永远搞不清那个框现在被当文件还是文件夹解释。这里改成三态 `snippetsSource: user|file|folder`
//     + 两个各自独立的路径字段 —— 语义直接摆在选项里,少一次猜。
//  2. 砍掉上游的 vim 系列(vimEnabled/vimSelectMode/…):Amadeus 没有 vim 层,留着就是画一排死开关。
//     同样砍掉 suppressSnippetTriggerOnIME —— 本移植的输入法纪律是硬约束(所有 handleTextInput/
//     handleKeyDown 开头 `if (view.composing) return false`),没有「可以关掉」这个档位。
//  3. 上游 `snippets` 字段既是「正文」又暗含「来源」,这里正文单独叫 snippetsSourceText,和 source 解耦。
//
// 保留的字段名尽量与上游同名 —— 用户从 Obsidian 那边搬 data.json 时能对上号。

import type { RawSnippet } from '../snippets/parse'
import { DEFAULT_SNIPPETS } from '../snippets/defaults'
import { DEFAULT_SNIPPET_VARIABLES } from '../snippets/variables'

export interface LatexSuiteSettings {
  // ── 片段
  snippetsEnabled: boolean
  /** 正文中的自动片段须显式开启；手动触发不受此开关影响。 */
  proseSnippetsEnabled: boolean
  /** 手动片段(无 `A` 标志)的触发键。上游是自由文本的 CodeMirror keymap 串,这里收成两档:
   *  Amadeus 的按键拦截走宿主 keymap,允许任意组合等于允许用户把自己锁死。 */
  snippetsTrigger: 'Tab' | 'Space'
  /** 片段库从哪来:插件内正文 / 单个文件 / 整个文件夹。 */
  snippetsSource: 'user' | 'file' | 'folder'
  snippetsFile: string
  snippetsFolder: string
  /** 片段库正文(source === 'user' 时生效)。 */
  snippetsSourceText: string

  // ── 自动分式
  autofractionEnabled: boolean
  autofractionSymbol: string
  autofractionBreakingChars: string
  /** JSON 文本:`[["^{", "}"], …]`。存字符串而非数组 —— 用户写坏了要能原样留在框里改,
   *  解析成结构体会把「非法但正在编辑」的中间态吃掉。 */
  autofractionExcludedEnvs: string

  // ── Tabout
  taboutEnabled: boolean
  taboutExitEquationOnlyOnEOL: boolean
  taboutClosingSymbols: string

  // ── 矩阵
  matrixShortcutsEnabled: boolean
  matrixShortcutsEnvNames: string
  matrixShortcutsMacroNames: string

  // ── 括号
  autoEnlargeBrackets: boolean
  autoEnlargeBracketsTriggers: string
  autoEnlargeBracketsSpace: boolean

  // ── 显示
  concealEnabled: boolean
  concealRevealTimeout: number
  mathPreviewEnabled: boolean
  /** 光标旁的配对括号高亮。 */
  highlightBracketsEnabled: boolean
  /** 配对括号按层级着色。 */
  colorPairedBracketsEnabled: boolean
  /** 公式定界符 `$` / `$$` 着色:配上的标绿,没配上的标红(上游同名设置)。 */
  highlightDollarEnabled: boolean

  // ── 高级
  wordDelimiters: string
  removeSnippetWhitespace: boolean
  /** 片段变量正文(JSON 对象文本)。上游叫 snippetVariables;这里与 snippetsSourceText 对称命名。 */
  snippetVariablesSourceText: string
  loadSnippetVariablesFromFile: boolean
  snippetVariablesFileLocation: string
  /** 展开一次后再看看新文本是否又触发了别的片段;0 = 不递归。 */
  snippetRecursion: number
}

/** 把一个值写回「用户能改的 JS 源码」形态。 */
function jsValue(v: unknown): string {
  if (v instanceof RegExp) return v.toString()
  if (typeof v === 'function') return jsFunction(v)
  const s = JSON.stringify(v)
  return typeof s === 'string' ? s : 'undefined'
}

/** 函数字面量回写。
 *  ⚠️构建是 minify 的,`fn.toString()` 拿到的是压缩后的源码 —— 内容能跑,但**形态**要当心:
 *  压缩器可能把 `{ replacement: function (m) {…} }` 收成方法简写 `{ replacement(m) {…} }`,
 *  那样 `.toString()` 出来的 `replacement(m){…}` 单独放在 `key: 值` 的值位上是语法错误。
 *  实测 esbuild 当前不做这个变换,但补一个 `function ` 前缀是零成本的保险。 */
function jsFunction(fn: unknown): string {
  const src = String(fn)
  const isArrow = /^\s*(async\s+)?(\(|[A-Za-z_$][\w$]*\s*=>)/.test(src)
  const isFunction = /^\s*(async\s+)?function[\s(*]/.test(src)
  return isArrow || isFunction ? src : `function ${src}`
}

/** 片段对象里键的输出顺序 —— 固定顺序,重置出来的文本才是稳定的(diff 友好)。 */
const SNIPPET_KEYS: (keyof RawSnippet)[] = [
  'trigger',
  'replacement',
  'options',
  'priority',
  'description',
  'flags',
  'triggerAfter',
  'excludedEnvironments',
  'excludedMacros',
]

/**
 * `RawSnippet[]` → 用户可编辑的源码文本。
 *
 * 为什么需要它:defaults.ts 是**带正则字面量和函数**的 TS 数组,不存在字符串形态,而设置面板里
 * 那个编辑器编辑的是文本。`JSON.stringify` 在这里是错的 —— 它把 RegExp 变成 `{}`、把函数整个丢掉。
 * 所以自己写:正则/函数走 `toString()`,其余走 JSON。
 *
 * 代价(接受):defaults.ts 里的分节注释与手写换行会丢,重置后是一行一条的规整形态。
 * 主入口的 `resetSnippets()` 必须复用这里的产物(即 `DEFAULT_SETTINGS.snippetsSourceText`),
 * 别在别处再拼一份 —— 两份会漂。
 */
export function serializeRawSnippets(snippets: RawSnippet[]): string {
  const lines = snippets.map((snip) => {
    const parts: string[] = []
    for (const key of SNIPPET_KEYS) {
      const v = snip[key]
      if (v === undefined) continue
      parts.push(`${key}: ${jsValue(v)}`)
    }
    return `  {${parts.join(', ')}},`
  })
  return `[\n${lines.join('\n')}\n]`
}

export const DEFAULT_SETTINGS: LatexSuiteSettings = {
  snippetsEnabled: true,
  // 与 Obsidian 的 Latex Suite 一致:正文里 mk / dm 直接展开。存过 false 的用户照旧(mergeSettings 只补缺的键)。
  proseSnippetsEnabled: true,
  snippetsTrigger: 'Tab',
  snippetsSource: 'user',
  snippetsFile: '',
  snippetsFolder: '',
  snippetsSourceText: serializeRawSnippets(DEFAULT_SNIPPETS),

  autofractionEnabled: true,
  autofractionSymbol: '\\frac',
  // 制表符在列表里看不见,但它确实是一个断字符(上游同款,别顺手删掉)。
  autofractionBreakingChars: '+-=\t',
  autofractionExcludedEnvs: `[
  ["^{", "}"],
  ["\\\\pu{", "}"]
]`,

  taboutEnabled: true,
  taboutExitEquationOnlyOnEOL: true,
  taboutClosingSymbols: '), ], \\rbrack, \\}, \\rbrace, \\rangle, \\rvert, \\rVert, \\rfloor, \\rceil, \\urcorner, }',

  matrixShortcutsEnabled: true,
  matrixShortcutsEnvNames: 'pmatrix, cases, align, gather, bmatrix, Bmatrix, vmatrix, Vmatrix, array, matrix',
  matrixShortcutsMacroNames: 'eqalign',

  autoEnlargeBrackets: true,
  autoEnlargeBracketsTriggers: 'sum, int, frac, prod, bigcup, bigcap',
  autoEnlargeBracketsSpace: true,

  concealEnabled: false,
  concealRevealTimeout: 0,
  mathPreviewEnabled: false,
  highlightBracketsEnabled: true,
  colorPairedBracketsEnabled: true,
  highlightDollarEnabled: true,

  // `\n` 是**两个字符**的字面量,不是换行 —— onWordBoundary 会把它还原成换行符。别写成真换行。
  wordDelimiters: '., +-\\n\t:;!?\\/{}[]()=~$\'"|`<>*^%#@&',
  removeSnippetWhitespace: true,
  snippetVariablesSourceText: JSON.stringify(DEFAULT_SNIPPET_VARIABLES, null, 2),
  loadSnippetVariablesFromFile: false,
  snippetVariablesFileLocation: '',
  snippetRecursion: 0,
}

const SNIPPETS_TRIGGERS: readonly string[] = ['Tab', 'Space']
const SNIPPETS_SOURCES: readonly string[] = ['user', 'file', 'folder']

/**
 * 落盘数据 → 完整设置。缺字段补默认、类型不对丢弃、枚举值不认丢弃。
 *
 * 为什么要这么保守:`ctx.loadData()` 读的是用户家目录里的一个 JSON 文件,用户手改改坏、
 * 老版本插件写下的旧形状、跨版本删掉的字段 —— 全都会到这里。任何一条都不该让插件起不来。
 */
export function mergeSettings(raw: unknown): LatexSuiteSettings {
  const out: LatexSuiteSettings = { ...DEFAULT_SETTINGS }
  if (!raw || typeof raw !== 'object') return out
  const src = raw as Record<string, unknown>
  // 键集合以 DEFAULT_SETTINGS 为准 —— 落盘文件里多出来的键一律不认(旧版残留不复活)。
  for (const key of Object.keys(out) as (keyof LatexSuiteSettings)[]) {
    const value = src[key]
    if (value === undefined) continue
    const fallback = out[key]
    if (typeof value !== typeof fallback) continue
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) continue
    if (key === 'snippetsTrigger' && !SNIPPETS_TRIGGERS.includes(value as string)) continue
    if (key === 'snippetsSource' && !SNIPPETS_SOURCES.includes(value as string)) continue
    // 上面逐条校验过类型;这里的宽松赋值是为了绕开「联合键 → 联合值」的类型体操。
    ;(out as unknown as Record<string, unknown>)[key] = value
  }
  return out
}

/** 53 位字符串指纹(cyrb53)。只用来认「是不是某个已发布版本的缺省库原文」,不做安全用途。 */
export function textFingerprint(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${text.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`
}

/**
 * 缺省片段库的修订号,存在设置外层的旁路键 DEFAULTS_REVISION_KEY 里(和 latexSuiteLastGood 一样不进
 * DEFAULT_SETTINGS:mergeSettings 会把「没有」补成当前值,就认不出还没迁移过的老设置了)。
 * 只在成功读盘之后的保存里写,写什么见 revisionToSave。
 */
export const DEFAULTS_REVISION = 1
export const DEFAULTS_REVISION_KEY = 'latexSuiteDefaultsRevision'

type FingerprintTables = Readonly<Record<number, Readonly<Record<string, string>>>>

/**
 * 修订号 r → 修订号还是 r 的那些版本发布时写进用户设置的缺省片段库(长度:指纹 → 版本)。
 * 0 = 设置里没有修订号(1.0.0 – 1.1.2 写的)。原文取自各版 main.js 运行时序列化出来的文本(函数体是
 * 压缩后的),存在 test/fixtures/default-snippets,单测核对这里的指纹。
 * 插件每次保存都写整份设置,没动过片段库的用户,设置里存的就是当时那一版的缺省原文;只改 defaults.ts
 * 对他们不起作用,所以要在读盘时迁移一次。
 * 修订号为 r 的设置对照第 r 张到第 DEFAULTS_REVISION − 1 张表(没有修订号 = 0,对照全部旧表):
 * 修订号可能被不认识它的旧版(1.1.2 及更早)存盘时丢掉,片段库却已经是更新的缺省原文,只对照第 r 张就
 * 永远升不上去。
 * ⚠️下次改 defaults.ts 并发布时:① 把**这一修订号**已发布的缺省原文存进 fixtures,指纹登记到
 * `[DEFAULTS_REVISION]` 这一项(新开一项,别并进旧的);② DEFAULTS_REVISION 加 1。没发布过的中间构建不登记。
 */
const RELEASED_DEFAULTS_BY_REVISION: FingerprintTables = {
  0: {
    '16070:dt9o15zarg': '1.0.0',
    '16070:27f1a4kcj2g': '1.0.0 reset',
    '16123:1tpdwu6y71w': '1.1.0 - 1.1.2',
  },
}

/** 一版插件的缺省片段库历史:当前修订号、各修订号的已发布缺省指纹、当前缺省原文。 */
export interface DefaultsHistory { revision: number; tables: FingerprintTables; current: string }
const HISTORY: DefaultsHistory = {
  revision: DEFAULTS_REVISION,
  tables: RELEASED_DEFAULTS_BY_REVISION,
  current: DEFAULT_SETTINGS.snippetsSourceText,
}

/** 读到的修订号是不是读得懂的值(非负整数)。 */
const readableRevision = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

/** 读到的设置里的修订号:没有 = 0;有但不是非负整数 = null(认不出,当作不知道,不迁移)。 */
export function savedDefaultsRevision(saved: unknown): number | null {
  if (!saved || typeof saved !== 'object') return 0
  const value = (saved as Record<string, unknown>)[DEFAULTS_REVISION_KEY]
  if (value === undefined) return 0
  return readableRevision(value) ? value : null
}

/**
 * 成功读盘之后保存时写回的修订号。没有就写当前修订号;读得懂的写 max(读到的, 当前),别把将来某版写下
 * 的更大修订号降回来(否则那版里有意设成本版缺省原文的片段库,回退到本版随便存一次盘、再升级就被换掉);
 * 读不懂的原样写回,不认识的东西不覆盖。
 * 代价(接受):回退到本版以后点「恢复默认」,写下的是本版缺省、修订号却还是更大的那个,再升级时停在本版
 * 缺省、不会自动换。这只是缺省没跟上,用户的东西没丢。
 */
export function revisionToSave(saved: unknown, current = DEFAULTS_REVISION): unknown {
  const value = saved && typeof saved === 'object' ? (saved as Record<string, unknown>)[DEFAULTS_REVISION_KEY] : undefined
  if (value === undefined) return current
  return readableRevision(value) ? Math.max(value, current) : value
}

/**
 * 迁移只发生一次:存的修订号已经是当前(或更新)的,或者认不出,原样返回;否则逐字等于第 revision 张到
 * 第 history.revision − 1 张表里某份已发布缺省原文的,换成当前缺省。改过一个字的、以及升级以后自己改回
 * 旧缺省原文并保存过的(那次保存带上了当前修订号),一律原样。
 */
export function migrateDefaultSnippetsWith(source: string, revision: number | null, history: DefaultsHistory): string {
  if (typeof source !== 'string' || revision === null || revision >= history.revision) return source
  if (source === history.current) return source
  const fingerprint = textFingerprint(source)
  for (let r = revision; r < history.revision; r++) {
    if (history.tables[r]?.[fingerprint]) return history.current
  }
  return source
}

/** 按本版的缺省历史迁移(见 migrateDefaultSnippetsWith)。 */
export function migrateDefaultSnippets(source: string, revision: number | null): string {
  return migrateDefaultSnippetsWith(source, revision, HISTORY)
}

/** 登记过的所有指纹(给单测核对 fixtures 用)。 */
export function releasedDefaultFingerprints(): Record<number, string[]> {
  return Object.fromEntries(Object.entries(RELEASED_DEFAULTS_BY_REVISION).map(([rev, table]) => [rev, Object.keys(table)]))
}

/** `"sum, int, frac"` → `['sum', 'int', 'frac']`(上游 strToArray:先去掉**全部**空白再切)。 */
export function splitList(value: string): string[] {
  return String(value ?? '')
    .replace(/\s/g, '')
    .split(',')
    .filter((s) => s.length > 0)
}
