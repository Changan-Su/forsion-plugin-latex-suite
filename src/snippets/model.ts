// 片段模型:选项标志、模式匹配、触发判定。语义逐条对齐上游 options.ts / snippets.ts。
//
// 与上游的结构差异(**刻意**):上游 1.12 引入了一套 luasnip 风格的节点树(ArrayNode/TextNode/
// TabstopNode)做替换文本的中间表示。那是实现细节,不是用户看得见的功能 —— 这里替换文本一路是字符串,
// tabstop 在展开那一步统一解析(见 tabstopParse.ts)。用户写的片段格式与上游完全一致。

import type { Mode } from '../editor/mathMode'
import { inMath } from '../editor/mathMode'

export interface Options {
  /** 片段声明它想在哪些模式下跑。 */
  mode: Mode
  automatic: boolean
  regex: boolean
  onWordBoundary: boolean
  visual: boolean
  /** 'U' 关掉 —— 关掉后触发键不作为独立的撤销点。 */
  undoKey: boolean
}

export const defaultOptions = (): Options => ({
  mode: { text: false, inlineMath: false, blockMath: false, codeBlock: false, textEnv: false },
  automatic: false,
  regex: false,
  onWordBoundary: false,
  visual: false,
  undoKey: true,
})

/** 解析 options 串(如 "mA"、"tAw")。⚠️标志字母的含义是用户契约,只增不改。 */
export function parseOptions(source: string): Options {
  const o = defaultOptions()
  for (const ch of String(source ?? '')) {
    switch (ch) {
      case 'm': o.mode.blockMath = true; o.mode.inlineMath = true; break
      case 'n': o.mode.inlineMath = true; break
      case 'M': o.mode.blockMath = true; break
      case 't': o.mode.text = true; break
      case 'c': o.mode.codeBlock = true; break
      case 'C': o.mode.codeBlock = true; break
      case 'A': o.automatic = true; break
      case 'r': o.regex = true; break
      case 'w': o.onWordBoundary = true; break
      case 'v': o.visual = true; break
      case 'U': o.undoKey = false; break
      default: break
    }
  }
  // 一个模式标志都没写 → 上游按「全模式」处理(向后兼容早期片段库),这里照做。
  if (!o.mode.text && !o.mode.inlineMath && !o.mode.blockMath && !o.mode.codeBlock) {
    o.mode.text = true
    o.mode.inlineMath = true
    o.mode.blockMath = true
    o.mode.codeBlock = true
  }
  return o
}

/** 片段声明的模式 vs 光标当前模式。逐条对齐上游 snippetShouldRunInMode。 */
export function shouldRunInMode(snip: Mode, cur: Mode): boolean {
  if ((snip.inlineMath && cur.inlineMath) || (snip.blockMath && cur.blockMath)) {
    // 在 \text{} 里的数学片段要让路 —— 那儿用户在写散文,不是公式。
    if (!cur.textEnv) return true
  }
  // 反过来:公式里的文本环境(\text{…})中,声明为 text 的片段照常跑。
  if (inMath(cur) && cur.textEnv && snip.text) return true
  if (snip.text && cur.text) return true
  if (snip.codeBlock && cur.codeBlock) return true
  return false
}

export type SnippetType = 'string' | 'regex' | 'visual'

export interface Snippet {
  type: SnippetType
  /** string/visual 用字符串;regex 用已编译好的、锚在行尾的正则。 */
  trigger: string | RegExp
  /** 字符串替换(可含 `[[n]]` 捕获组占位与 `$n` tabstop),或用户函数。
   *  ⚠️入参故意是 any:上游默认表里的函数会用 `match.groups`,也会用 `this.trigger.source`
   *  (所以下面调用一律 `.call(snippet, …)`)。见 parse.ts RawSnippet 的说明。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  replacement: string | ((m: any) => unknown)
  options: Options
  priority: number
  description: string
  excludedEnvironments: string[]
  /** 不在这些宏的花括号参数里触发(`\ce{}` 化学式等,上游 excludedMacros)。 */
  excludedMacros: string[]
  /** 展示用的原始 trigger 文本(设置页/报错用)。 */
  triggerSource: string
}

export interface MatchResult {
  /** 触发串在**当前行**里的起点(text 偏移)。 */
  triggerPos: number
  /** 替换文本(已代入捕获组,尚未解析 tabstop)。 */
  insert: string
}

/** 按优先级排序:priority 高的先,平手时 trigger 长的先(长的更具体)。 */
export function sortSnippets(snippets: Snippet[]): Snippet[] {
  const len = (s: Snippet): number => (typeof s.trigger === 'string' ? s.trigger.length : s.trigger.source.length)
  return snippets
    .map((s, i) => [s.priority, len(s), i] as const)
    .sort((a, b) => b[0] - a[0] || b[1] - a[1])
    .map(([, , i]) => snippets[i])
}

/** `[[0]]` `[[1]]` … = 捕获组占位。**不是** `$n` —— 那是 tabstop,两者刻意用不同语法。 */
function applyCaptures(insert: string, captures: string[]): string {
  return insert.replace(/\[\[(\d+)\]\]/g, (_m, d: string) => captures[Number(d)] ?? '')
}

/** 用户函数的返回值消毒:字符串放行,false = 本次不展开,其余当错误。 */
function fromUserFn(out: unknown, trigger: string): string | null {
  if (out === false) return null
  if (typeof out === 'string') return out
  console.error(`[latex-suite] 片段 "${trigger}" 的替换函数返回了 ${typeof out},只接受字符串或 false`)
  return null
}

/**
 * 判断这个片段是否在光标处触发。
 * @param line   行首到光标(含刚敲进去的那个字符)的文本
 * @param sel    当前选中的文本(visual 片段用;非 visual 片段有选区时一律不跑)
 */
export function matchSnippet(snippet: Snippet, line: string, sel: string): MatchResult | null {
  const hasSel = sel.length > 0
  if (snippet.type === 'visual') {
    if (!hasSel) return null
    if (typeof snippet.trigger !== 'string' || !line.endsWith(snippet.trigger)) return null
    const insert =
      typeof snippet.replacement === 'function'
        ? fromUserFn(snippet.replacement.call(snippet, sel), snippet.triggerSource)
        : snippet.replacement.split('${VISUAL}').join(sel)
    if (insert === null) return null
    // visual 片段替换掉的是**选区**,触发串由调用方另行删除。
    return { triggerPos: -1, insert }
  }

  if (hasSel) return null // 非 visual 片段有选区时不跑(会吃掉用户的选择)

  if (snippet.type === 'regex') {
    const re = snippet.trigger as RegExp
    re.lastIndex = 0
    const m = re.exec(line)
    if (!m) return null
    const insert =
      typeof snippet.replacement === 'function'
        ? fromUserFn(snippet.replacement.call(snippet, m), snippet.triggerSource)
        : applyCaptures(snippet.replacement, m.slice(1))
    if (insert === null) return null
    return { triggerPos: m.index, insert }
  }

  const trig = snippet.trigger as string
  if (!trig || !line.endsWith(trig)) return null
  const insert =
    typeof snippet.replacement === 'function'
      ? fromUserFn(snippet.replacement.call(snippet, trig), snippet.triggerSource)
      : snippet.replacement
  if (insert === null) return null
  return { triggerPos: line.length - trig.length, insert }
}

/** 词边界校验(`w` 标志):触发串前后都必须是分隔符。 */
export function onWordBoundary(text: string, triggerPos: number, cursor: number, delimiters: string): boolean {
  const d = delimiters.replace(/\\n/g, '\n')
  const prev = triggerPos > 0 ? text[triggerPos - 1] : ' ' // 行首视作边界
  const next = cursor < text.length ? text[cursor] : ' ' // 行尾同理
  return d.includes(prev) && d.includes(next)
}

/** 行内公式里,替换文本尾部的空格要去掉(上游 removeSnippetWhitespace)。
 *  `"\\sum $0"` 这种尾随 " $0" 的形态要保留 tabstop、只吃掉它前面那个空格。 */
export function trimReplacementWhitespace(insert: string): string {
  if (insert.endsWith(' ')) return insert.trimEnd()
  const last3 = insert.slice(-3)
  if (last3.slice(0, 2) === ' $' && !Number.isNaN(parseInt(last3.slice(-1), 10))) {
    return insert.slice(0, -3) + insert.slice(-2)
  }
  return insert
}
