// 片段库解析:用户写的那份数组 → 可执行的 Snippet[]。
//
// 用户格式与上游**逐字兼容** —— 从 Obsidian 那边把 snippets.js 整份贴过来就能用,这是移植的意义所在。
// 支持 JSON,也支持带正则字面量和函数的 JS 数组(上游同款)。求值用 `new Function`:插件本身就跑在
// `new Function` 里,这里不构成新的信任边界;而且这是用户自己写进自己片段库的代码。

import type { Snippet, SnippetType } from './model'
import { parseOptions, sortSnippets } from './model'

export interface RawSnippet {
  trigger: string | RegExp
  /** 函数形态的入参:string 片段拿到触发串,regex 片段拿到匹配结果,visual 片段拿到选区文本。
   *  ⚠️故意用 `any`:这是**用户写的任意 JS**,上游默认表里就有靠 `match.groups`、靠 `this.trigger`
   *  的条目。给它一个严格类型只会逼着自己到处 as,并不会让第三方代码更安全 —— 安全靠的是
   *  返回值消毒(见 model.ts 的 fromUserFn)。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  replacement: string | ((m: any) => unknown)
  options?: string
  priority?: number
  description?: string
  /** 正则片段的附加 flag(与 trigger 自带的 flag 合并)。 */
  flags?: string
  /** 触发串**之后**还必须匹配上的内容(不消耗它,只作条件)。 */
  triggerAfter?: string | RegExp
  /** 不在这些 `\begin{名字}` 环境里触发。 */
  excludedEnvironments?: string[]
  /** 不在这些**宏参数**里触发(上游同款,默认表用它挡住化学式:`\ce{H2}` 里的 `H2` 不该变成 `H_{2}`)。 */
  excludedMacros?: Array<string | { name: string }>
}

export interface ParseResult {
  snippets: Snippet[]
  /** 人话错误信息,直接显示在设置面板上。空数组 = 全好。 */
  errors: string[]
}

/** 只保留 JS 正则合法的 flag,并去重(上游同款:用户可能从别处抄来 pcre 的 flag)。 */
function filterFlags(flags: string): string {
  return Array.from(new Set(String(flags ?? '').split(''))).filter((f) => 'dgimsuvy'.includes(f)).join('')
}

/** 把 `${GREEK}` 这类片段变量代进 trigger。变量值本身是正则分支串。 */
export function insertVariables(trigger: string, vars: Record<string, string>): string {
  let out = trigger
  for (const [name, value] of Object.entries(vars)) out = out.split(name).join(value)
  return out
}

/** 求值用户写的片段源。**不做沙箱** —— 见文件头的信任说明。 */
export function evalSnippetSource(source: string): { raw: RawSnippet[]; error?: string } {
  const src = String(source ?? '').trim()
  if (!src) return { raw: [] }
  try {
    // eslint-disable-next-line no-new-func
    const out = new Function(`"use strict"; return (${src});`)() as unknown
    if (!Array.isArray(out)) return { raw: [], error: '片段库必须是一个数组(以 [ 开头、] 结尾)' }
    return { raw: out as RawSnippet[] }
  } catch (e) {
    return { raw: [], error: `片段库解析失败:${e instanceof Error ? e.message : String(e)}` }
  }
}

function describe(raw: RawSnippet): string {
  const t = raw.trigger instanceof RegExp ? raw.trigger.source : String(raw.trigger)
  return t.length > 40 ? `${t.slice(0, 40)}…` : t
}

/** 一条 raw → 一个 Snippet;不合法则返回错误串。 */
function normalizeOne(raw: RawSnippet, vars: Record<string, string>): Snippet | string {
  if (!raw || typeof raw !== 'object') return '片段必须是对象'
  if (raw.trigger == null || raw.trigger === '') return '片段缺少 trigger'
  if (raw.replacement == null) return `片段 "${describe(raw)}" 缺少 replacement`
  if (typeof raw.replacement !== 'string' && typeof raw.replacement !== 'function') {
    return `片段 "${describe(raw)}" 的 replacement 只能是字符串或函数`
  }

  const options = parseOptions(raw.options ?? '')
  const isRegex = options.regex || raw.trigger instanceof RegExp
  const priority = Number(raw.priority ?? 0) || 0
  const description = String(raw.description ?? '')
  const excludedEnvironments = Array.isArray(raw.excludedEnvironments) ? raw.excludedEnvironments.map(String) : []
  // 上游两种写法都收:`["ce"]` 与 `[{name:'ce'}]`。
  const excludedMacros = Array.isArray(raw.excludedMacros)
    ? raw.excludedMacros.map((m) => (typeof m === 'string' ? m : String(m?.name ?? ''))).filter(Boolean)
    : []
  const triggerSource = describe(raw)

  if (options.visual) {
    if (typeof raw.trigger !== 'string') return `visual 片段 "${triggerSource}" 的 trigger 必须是字符串`
    return {
      type: 'visual' as SnippetType,
      trigger: raw.trigger,
      replacement: raw.replacement,
      options,
      priority,
      description,
      excludedEnvironments,
      excludedMacros,
      triggerSource,
    }
  }

  if (isRegex) {
    let source = raw.trigger instanceof RegExp ? raw.trigger.source : String(raw.trigger)
    let flags = raw.trigger instanceof RegExp ? `${raw.trigger.flags}${raw.flags ?? ''}` : String(raw.flags ?? '')
    source = insertVariables(source, vars)
    flags = filterFlags(flags).replace(/[gy]/g, '') // 锚在行尾的一次性匹配,粘性/全局只会捣乱
    let trigger: RegExp
    try {
      // 锚到行尾 = 「在光标当前位置找匹配」。这一步是正则片段能工作的全部原因。
      trigger = new RegExp(`(?:${source})$`, flags)
    } catch (e) {
      return `正则片段 "${triggerSource}" 编译失败:${e instanceof Error ? e.message : String(e)}`
    }
    options.regex = true
    return {
      type: 'regex' as SnippetType,
      trigger,
      replacement: raw.replacement,
      options,
      priority,
      description,
      excludedEnvironments,
      excludedMacros,
      triggerSource,
    }
  }

  return {
    type: 'string' as SnippetType,
    trigger: insertVariables(String(raw.trigger), vars),
    replacement: raw.replacement,
    options,
    priority,
    description,
    excludedEnvironments,
    excludedMacros,
    triggerSource,
  }
}

export function normalizeSnippets(raws: RawSnippet[], vars: Record<string, string>): ParseResult {
  const snippets: Snippet[] = []
  const errors: string[] = []
  for (const raw of raws) {
    const out = normalizeOne(raw, vars)
    if (typeof out === 'string') errors.push(out)
    else snippets.push(out)
  }
  return { snippets: sortSnippets(snippets), errors }
}

/** 一步到位:源码串 → 排好序的片段表 + 错误清单。 */
export function parseSnippets(source: string, vars: Record<string, string>): ParseResult {
  const { raw, error } = evalSnippetSource(source)
  const res = normalizeSnippets(raw, vars)
  if (error) res.errors.unshift(error)
  return res
}
