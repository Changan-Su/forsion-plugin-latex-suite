// 设置与片段库的单一真源:落盘、读盘、库内片段文件的加载与热重载。
//
// 落盘走宿主 2026-08-15 新增的 `ctx.loadData()/saveData()`(每插件一份 JSON,存在
// ~/.forsion/plugins-data/<id>.json)。**不用 registerSetting** —— 那是"每键一个字符串塞
// localStorage"的旋钮通道,装不下几十 KB 的片段库,也没有原子性。
//
// 片段库三种来源(上游同款):
//   user   — 就存在插件数据里(默认)
//   file   — 库里的一个文件,外部编辑器改完热重载
//   folder — 库里一个文件夹下的所有 .js/.json,合并
// 热重载靠 `ctx.app.watchFile`;宿主没有这条接缝时退化成"打开设置页时重读",而不是假装在监听。

import type { PluginContext } from '../types/forsion'
import type { LatexSuiteSettings } from './settingsUi/model'
import { DEFAULT_SETTINGS } from './settingsUi/model'
import { DEFAULT_SNIPPETS } from './snippets/defaults'
import { DEFAULT_SNIPPET_VARIABLES } from './snippets/variables'
import { normalizeSnippets, parseSnippets, type ParseResult } from './snippets/parse'
import type { Snippet } from './snippets/model'

export interface Store {
  settings(): LatexSuiteSettings
  update(patch: Partial<LatexSuiteSettings>): void
  snippets(): Snippet[]
  errors(): string[]
  /** 设置或片段表变化时通知(设置面板重绘、编辑器无需重建 —— 它每次按键现读)。 */
  subscribe(cb: () => void): () => void
  /** 恢复默认片段库(设置面板的"重置"按钮)。 */
  resetSnippets(): void
  dispose(): void
}

/** 默认片段库的可读文本形态 —— 用户点"重置"后看到的就是这份,能直接编辑。
 *  ⚠️不是 JSON.stringify:默认表里有正则字面量,JSON 化会把它们变成 `{}`。 */
export function defaultSnippetsText(): string {
  const body = DEFAULT_SNIPPETS.map((s) => {
    const trigger = s.trigger instanceof RegExp ? String(s.trigger) : JSON.stringify(s.trigger)
    const replacement = typeof s.replacement === 'function' ? String(s.replacement) : JSON.stringify(s.replacement)
    const parts = [`trigger: ${trigger}`, `replacement: ${replacement}`]
    if (s.options) parts.push(`options: ${JSON.stringify(s.options)}`)
    if (s.priority) parts.push(`priority: ${s.priority}`)
    if (s.description) parts.push(`description: ${JSON.stringify(s.description)}`)
    return `  {${parts.join(', ')}}`
  }).join(',\n')
  return `[\n${body}\n]\n`
}

const SNIPPET_FILE_RE = /\.(js|json)$/i

export function createStore(ctx: PluginContext): Store {
  let settings: LatexSuiteSettings = { ...DEFAULT_SETTINGS }
  // 默认片段表是**已解析好的对象**,不必绕一圈字符串 —— 首帧就能用,不等异步读盘。
  let parsed: ParseResult = normalizeSnippets(DEFAULT_SNIPPETS, DEFAULT_SNIPPET_VARIABLES)
  const listeners = new Set<() => void>()
  const fileUnsubs: Array<() => void> = []
  let disposed = false

  const emit = (): void => {
    for (const cb of Array.from(listeners)) {
      try { cb() } catch (e) { console.error('[latex-suite] 订阅者抛错', e) }
    }
  }

  const variables = (): Record<string, string> => {
    if (!settings.loadSnippetVariablesFromFile) return DEFAULT_SNIPPET_VARIABLES
    return { ...DEFAULT_SNIPPET_VARIABLES, ...loadedVariables }
  }
  let loadedVariables: Record<string, string> = {}

  /** 按当前来源重算片段表。异步(要读库里的文件),完成后 emit。 */
  const reload = async (): Promise<void> => {
    if (disposed) return
    let source: string | null = null
    try {
      if (settings.snippetsSource === 'file' && settings.snippetsFile) {
        source = await ctx.app.readFile(settings.snippetsFile)
        if (source === null) {
          parsed = { snippets: [], errors: [`读不到片段文件:${settings.snippetsFile}`] }
          emit()
          return
        }
      } else if (settings.snippetsSource === 'folder' && settings.snippetsFolder) {
        const prefix = settings.snippetsFolder.replace(/^\/+|\/+$/g, '')
        const all = (await ctx.app.listFiles?.()) ?? []
        const hits = all.filter((p) => p.startsWith(`${prefix}/`) && SNIPPET_FILE_RE.test(p)).sort()
        if (!hits.length) {
          parsed = { snippets: [], errors: [`片段文件夹里没有 .js / .json:${prefix}`] }
          emit()
          return
        }
        // 各文件独立解析再合并:一个文件写坏了不该把整个片段库带走(上游同款容错)。
        const merged: Snippet[] = []
        const errs: string[] = []
        for (const p of hits) {
          const text = await ctx.app.readFile(p)
          if (text === null) { errs.push(`读不到 ${p}`); continue }
          const r = parseSnippets(text, variables())
          merged.push(...r.snippets)
          errs.push(...r.errors.map((e) => `${p}: ${e}`))
        }
        parsed = { ...normalizeSnippets([], {}), snippets: sortMerged(merged), errors: errs }
        emit()
        return
      }
    } catch (e) {
      parsed = { snippets: [], errors: [`加载片段库失败:${e instanceof Error ? e.message : String(e)}`] }
      emit()
      return
    }

    const text = source ?? settings.snippetsSourceText
    parsed = text.trim()
      ? parseSnippets(text, variables())
      : normalizeSnippets(DEFAULT_SNIPPETS, variables())
    emit()
  }

  /** 合并多文件时重新按优先级排序(各文件内部已排过,合起来必须再排一次)。 */
  const sortMerged = (list: Snippet[]): Snippet[] => {
    const len = (s: Snippet): number => (typeof s.trigger === 'string' ? s.trigger.length : s.trigger.source.length)
    return [...list].sort((a, b) => b.priority - a.priority || len(b) - len(a))
  }

  /** 重新挂文件监听(来源/路径变了要重挂)。 */
  const rewatch = (): void => {
    while (fileUnsubs.length) {
      const off = fileUnsubs.pop()
      try { off?.() } catch { /* 退订失败不该挡住后面 */ }
    }
    if (!ctx.app.watchFile) return
    const targets: string[] = []
    if (settings.snippetsSource === 'file' && settings.snippetsFile) targets.push(settings.snippetsFile)
    if (settings.loadSnippetVariablesFromFile && settings.snippetVariablesFileLocation) {
      targets.push(settings.snippetVariablesFileLocation)
    }
    // 文件夹来源没法逐个订(文件会增减),只订当前枚举到的那批 —— 新增文件靠用户回设置页时重读。
    for (const t of targets) {
      const off = ctx.app.watchFile(t, () => { void reload() })
      if (off) fileUnsubs.push(off)
    }
  }

  const loadVariablesFile = async (): Promise<void> => {
    if (!settings.loadSnippetVariablesFromFile || !settings.snippetVariablesFileLocation) {
      loadedVariables = {}
      return
    }
    const text = await ctx.app.readFile(settings.snippetVariablesFileLocation)
    if (text === null) { loadedVariables = {}; return }
    try {
      // eslint-disable-next-line no-new-func
      const out = new Function(`"use strict"; return (${text});`)() as unknown
      loadedVariables = out && typeof out === 'object' ? (out as Record<string, string>) : {}
    } catch (e) {
      loadedVariables = {}
      console.error('[latex-suite] 片段变量文件解析失败', e)
    }
  }

  const persist = (): void => {
    void ctx.saveData?.(settings).catch((e) => console.error('[latex-suite] 设置落盘失败', e))
  }

  // 首帧用默认值直接可用,读盘完成后再刷新一次 —— 用户不会看到"插件先没反应再突然生效"。
  void (async () => {
    const saved = await ctx.loadData?.<Partial<LatexSuiteSettings>>().catch(() => null)
    if (disposed) return
    if (saved && typeof saved === 'object') settings = { ...DEFAULT_SETTINGS, ...saved }
    await loadVariablesFile()
    rewatch()
    await reload()
  })()

  return {
    settings: () => settings,
    update: (patch) => {
      const before = settings
      settings = { ...settings, ...patch }
      persist()
      const sourceChanged =
        before.snippetsSource !== settings.snippetsSource ||
        before.snippetsFile !== settings.snippetsFile ||
        before.snippetsFolder !== settings.snippetsFolder ||
        before.snippetsSourceText !== settings.snippetsSourceText ||
        before.loadSnippetVariablesFromFile !== settings.loadSnippetVariablesFromFile ||
        before.snippetVariablesFileLocation !== settings.snippetVariablesFileLocation
      if (sourceChanged) {
        void (async () => {
          await loadVariablesFile()
          rewatch()
          await reload()
        })()
      } else {
        emit()
      }
    },
    snippets: () => (settings.snippetsEnabled ? parsed.snippets : []),
    errors: () => parsed.errors,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    resetSnippets: () => {
      settings = { ...settings, snippetsSource: 'user', snippetsSourceText: defaultSnippetsText() }
      persist()
      void reload()
    },
    dispose: () => {
      disposed = true
      listeners.clear()
      while (fileUnsubs.length) {
        const off = fileUnsubs.pop()
        try { off?.() } catch { /* ignore */ }
      }
    },
  }
}
