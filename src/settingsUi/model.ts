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
  mathPreviewEnabled: true,
  highlightBracketsEnabled: true,
  colorPairedBracketsEnabled: true,

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

/** `"sum, int, frac"` → `['sum', 'int', 'frac']`(上游 strToArray:先去掉**全部**空白再切)。 */
export function splitList(value: string): string[] {
  return String(value ?? '')
    .replace(/\s/g, '')
    .split(',')
    .filter((s) => s.length > 0)
}
