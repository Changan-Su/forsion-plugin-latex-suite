// Settings and snippets share one load/save path. Failed reads never replace a working library.
import type { PluginContext } from '../types/forsion'
import type { LatexSuiteSettings } from './settingsUi/model'
import { DEFAULT_SETTINGS, mergeSettings, restoreLegacyDefaultSnippets } from './settingsUi/model'
import { DEFAULT_SNIPPET_VARIABLES } from './snippets/variables'
import { parseSnippets } from './snippets/parse'
import { sortSnippets, type Snippet } from './snippets/model'

export interface Store {
  settings(): LatexSuiteSettings
  ready(): boolean
  update(patch: Partial<LatexSuiteSettings>): void
  snippets(): Snippet[]
  errors(): string[]
  reload(): Promise<void>
  /** Old hosts can watch existing files but cannot discover new folder members. */
  watchMode(): 'live' | 'existing-files' | 'manual'
  subscribe(cb: () => void): () => void
  resetSnippets(): void
  dispose(): void
}

export function defaultSnippetsText(): string { return DEFAULT_SETTINGS.snippetsSourceText }

interface Issue { zh: string; en: string }
interface LastGoodLibrary { version: 1; snippetsSourceText: string; snippetVariablesSourceText: string }
interface VaultEvent { kind: string; path?: string; from?: string; folder?: boolean }
type VaultEventsApi = { onVaultEvent?(cb: (events: VaultEvent[]) => void): () => void }
const SNIPPET_FILE_RE = /\.(js|json)$/i
const SOURCE_KEYS: (keyof LatexSuiteSettings)[] = [
  'snippetsSource', 'snippetsFile', 'snippetsFolder', 'snippetsSourceText',
  'snippetVariablesSourceText', 'loadSnippetVariablesFromFile', 'snippetVariablesFileLocation',
]
const normalizePath = (path: string): string => path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
const issue = (zh: string, en: string): Issue => ({ zh, en })

/** The parser's legacy diagnostic strings are translated at the store boundary. */
function snippetIssue(message: string, path?: string): Issue {
  const syntax = message.match(/^片段库解析失败:(.*)$/s)
  const english = !/[\u3400-\u9fff]/.test(message) ? message
    : syntax ? `Invalid snippet source: ${syntax[1]}`
      : 'Invalid snippet. Check its trigger, replacement, options and regular expression.'
  return issue(path ? `${path}：${message}` : message, path ? `${path}: ${english}` : english)
}

export function createStore(ctx: PluginContext): Store {
  let settings = { ...DEFAULT_SETTINGS }
  let loaded = false
  let disposed = false
  let generation = 0
  let active: Snippet[] = []
  let issues: Issue[] = []
  let saveIssue: Issue | null = null
  let pendingPatch: Partial<LatexSuiteSettings> = {}
  let lastGood: LastGoodLibrary | null = null
  let hasUserUpdates = false
  let saveQueue: Promise<void> = Promise.resolve()
  let folderPaths: string[] = []
  const listeners = new Set<() => void>()
  const fileUnsubs = new Map<string, () => void>()
  const vaultApi = ctx.app as typeof ctx.app & VaultEventsApi
  const emit = (): void => {
    if (disposed) return
    for (const cb of [...listeners]) {
      try { cb() } catch (e) { console.error('[latex-suite] subscriber failed', e) }
    }
  }
  const clearWatches = (): void => {
    for (const off of fileUnsubs.values()) {
      try { off() } catch { /* Cleanup must continue. */ }
    }
    fileUnsubs.clear()
  }
  const externalSources = (): boolean => settings.snippetsSource !== 'user' || settings.loadSnippetVariablesFromFile
  const watchMode = (): 'live' | 'existing-files' | 'manual' => {
    if (!externalSources() || vaultApi.onVaultEvent) return 'live'
    return ctx.app.watchFile ? 'existing-files' : 'manual'
  }
  const refreshWatches = (): void => {
    if (disposed || !loaded) return
    const targets = new Set<string>()
    // Vault events cover folder membership and edits. Older hosts only watch known files.
    if (!vaultApi.onVaultEvent && ctx.app.watchFile) {
      if (settings.snippetsSource === 'file' && settings.snippetsFile) targets.add(normalizePath(settings.snippetsFile))
      if (settings.snippetsSource === 'folder') for (const path of folderPaths) targets.add(path)
      if (settings.loadSnippetVariablesFromFile && settings.snippetVariablesFileLocation) {
        targets.add(normalizePath(settings.snippetVariablesFileLocation))
      }
    }
    for (const [path, off] of fileUnsubs) {
      if (!targets.has(path)) { try { off() } catch { /* Continue. */ }; fileUnsubs.delete(path) }
    }
    for (const path of targets) {
      if (!fileUnsubs.has(path)) {
        try { fileUnsubs.set(path, ctx.app.watchFile!(path, () => { void reload() })) }
        catch (e) { console.error('[latex-suite] watch failed', e) }
      }
    }
  }
  const persist = (): void => {
    if (!loaded || disposed || !ctx.saveData) return
    const snapshot = { ...settings, ...(lastGood ? { latexSuiteLastGood: { ...lastGood } } : {}) }
    // Serial saves prevent an older slow write from overwriting a newer setting.
    // Disposal stops new work, but writes already accepted from the UI still drain.
    saveQueue = saveQueue.then(async () => {
      try { await ctx.saveData!(snapshot); saveIssue = null }
      catch (e) {
        saveIssue = issue('设置保存失败，请重试。', 'Could not save settings. Please retry.')
        console.error('[latex-suite] save failed', e)
      }
      emit()
    })
  }

  const readVariables = async (snapshot: LatexSuiteSettings): Promise<Record<string, string>> => {
    let source = snapshot.snippetVariablesSourceText
    if (snapshot.loadSnippetVariablesFromFile) {
      const path = normalizePath(snapshot.snippetVariablesFileLocation)
      if (!path) throw issue('请选择片段变量文件。', 'Choose a snippet variables file.')
      const text = await ctx.app.readFile(path)
      if (text === null) throw issue(`读不到片段变量文件：${path}`, `Could not read snippet variables: ${path}`)
      source = text
    }
    let value: unknown
    try {
      try { value = JSON.parse(source) }
      catch {
        // Existing variable files accept JS object literals, just like snippet files.
        if (!snapshot.loadSnippetVariablesFromFile) throw new Error('Invalid JSON')
        value = new Function(`"use strict"; return (${source});`)() as unknown
      }
    }
    catch { throw issue('片段变量必须是有效的 JSON 对象，已保留上次有效的片段库。', 'Snippet variables must be a valid JSON object. The last working library is still active.') }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((v) => typeof v !== 'string')) {
      throw issue('片段变量的值必须全部是字符串。', 'Every snippet variable value must be a string.')
    }
    return { ...DEFAULT_SNIPPET_VARIABLES, ...value as Record<string, string> }
  }

  async function reload(): Promise<void> {
    if (disposed) return
    const run = ++generation
    const current = (): boolean => !disposed && generation === run
    let backupChanged = false
    if (!loaded) {
      try {
        const saved = await ctx.loadData?.<Partial<LatexSuiteSettings> & { latexSuiteLastGood?: unknown }>()
        if (!current()) return
        if (saved != null && (typeof saved !== 'object' || Array.isArray(saved))) {
          throw new Error('Invalid saved settings')
        }
        settings = mergeSettings({ ...(saved ?? {}), ...pendingPatch })
        settings.snippetsSourceText = restoreLegacyDefaultSnippets(settings.snippetsSourceText)
        // Backups belong only to embedded user code. External files are always read fresh.
        const backup = saved?.latexSuiteLastGood as Partial<LastGoodLibrary> | undefined
        if (settings.snippetsSource === 'user' && !settings.loadSnippetVariablesFromFile && backup?.version === 1
          && typeof backup.snippetsSourceText === 'string' && typeof backup.snippetVariablesSourceText === 'string') {
          try {
            const variables = JSON.parse(backup.snippetVariablesSourceText) as unknown
            if (!variables || typeof variables !== 'object' || Array.isArray(variables)
              || Object.values(variables).some((value) => typeof value !== 'string')) throw new Error('Invalid backup variables')
            const recovered = parseSnippets(backup.snippetsSourceText, { ...DEFAULT_SNIPPET_VARIABLES, ...variables as Record<string, string> })
            if (!recovered.errors.length) {
              active = recovered.snippets
              lastGood = backup as LastGoodLibrary
            }
          } catch { /* Ignore invalid backup metadata; never rewrite the user's draft. */ }
        }
        loaded = true
        const persistInitializedUpdates = Object.keys(pendingPatch).length > 0
        pendingPatch = {}
        // Once the saved settings are known, enqueue startup edits before any external
        // reads. A newer reload may supersede this one, but cannot drop this write.
        if (persistInitializedUpdates) persist()
      } catch (e) {
        if (!current()) return
        issues = [issue('无法读取已保存的设置，自动输入功能已暂停。请重新加载。', 'Saved settings could not be read. Automatic input is paused. Reload to retry.')]
        console.error('[latex-suite] settings load failed', e)
        emit()
        return
      }
    }
    const snapshot = { ...settings }
    refreshWatches()
    try {
      const variables = await readVariables(snapshot)
      if (!current()) return
      const candidates: Snippet[] = []
      const errors: Issue[] = []
      const parse = (source: string, path?: string): void => {
        const parsed = parseSnippets(source, variables)
        candidates.push(...parsed.snippets)
        errors.push(...parsed.errors.map((e) => snippetIssue(e, path)))
      }
      if (snapshot.snippetsSource === 'file') {
        const path = normalizePath(snapshot.snippetsFile)
        if (!path) throw issue('请选择片段文件。', 'Choose a snippet file.')
        const source = await ctx.app.readFile(path)
        if (!current()) return
        if (source === null) throw issue(`读不到片段文件：${path}`, `Could not read snippet file: ${path}`)
        parse(source, path)
      } else if (snapshot.snippetsSource === 'folder') {
        const prefix = normalizePath(snapshot.snippetsFolder)
        if (!prefix) throw issue('请选择片段文件夹。', 'Choose a snippets folder.')
        if (!ctx.app.listFiles) throw issue('此宿主无法列出文件，请使用单个文件或内置片段。', 'This host cannot list files. Use a single file or the built-in editor.')
        const all = await ctx.app.listFiles()
        if (!current()) return
        const hits = all.map(normalizePath).filter((p) => p.startsWith(`${prefix}/`) && SNIPPET_FILE_RE.test(p)).sort()
        folderPaths = hits
        refreshWatches()
        if (!hits.length) throw issue(`文件夹中没有 .js 或 .json 文件：${prefix}`, `No .js or .json files in folder: ${prefix}`)
        for (const path of hits) {
          const source = await ctx.app.readFile(path)
          if (!current()) return
          if (source === null) errors.push(issue(`读不到片段文件：${path}`, `Could not read snippet file: ${path}`))
          else parse(source, path)
        }
      } else {
        parse(snapshot.snippetsSourceText)
      }
      if (!current()) return
      // Treat the library as one configuration: no half-updated folder or broken draft.
      if (!errors.length) {
        active = sortSnippets(candidates)
        if (snapshot.snippetsSource === 'user' && !snapshot.loadSnippetVariablesFromFile) {
          backupChanged = lastGood?.snippetsSourceText !== snapshot.snippetsSourceText
            || lastGood?.snippetVariablesSourceText !== snapshot.snippetVariablesSourceText
          lastGood = { version: 1, snippetsSourceText: snapshot.snippetsSourceText, snippetVariablesSourceText: snapshot.snippetVariablesSourceText }
        }
      }
      issues = errors
    } catch (e) {
      if (!current()) return
      issues = [e && typeof e === 'object' && 'zh' in e && 'en' in e ? e as Issue
        : issue('加载片段库失败，已保留上次有效的片段库。', 'Could not load snippets. The last working library is still active.')]
    }
    if (current()) {
      // Persist a newly validated user draft as the durable fallback too. Initial read-only
      // loading must not rewrite settings merely to seed backup metadata.
      if (backupChanged && hasUserUpdates) persist()
      emit()
    }
  }

  const relevantPath = (path?: string, folder = false): boolean => {
    if (!path) return false
    const normalized = normalizePath(path)
    const matchesFile = (target: string): boolean => normalized === normalizePath(target)
      || (folder && normalizePath(target).startsWith(`${normalized}/`))
    if (settings.loadSnippetVariablesFromFile && matchesFile(settings.snippetVariablesFileLocation)) return true
    if (settings.snippetsSource === 'file' && matchesFile(settings.snippetsFile)) return true
    if (settings.snippetsSource === 'folder') {
      const prefix = normalizePath(settings.snippetsFolder)
      return normalized === prefix || normalized.startsWith(`${prefix}/`) || (folder && prefix.startsWith(`${normalized}/`))
    }
    return false
  }
  const offVault = vaultApi.onVaultEvent?.((events) => {
    if (disposed || !externalSources()) return
    if (events.some((event) => event.kind === 'vault' || relevantPath(event.path, event.folder) || relevantPath(event.from, event.folder))) {
      // A different vault must never inherit the previous vault's active snippet code.
      if (events.some((event) => event.kind === 'vault')) active = []
      void reload()
    }
  })

  const update = (patch: Partial<LatexSuiteSettings>): void => {
    if (disposed) return
    hasUserUpdates = true
    const before = settings
    settings = mergeSettings({ ...settings, ...patch })
    if (!loaded) { pendingPatch = { ...pendingPatch, ...patch }; emit(); return }
    persist()
    if (before.snippetsFolder !== settings.snippetsFolder || before.snippetsSource !== settings.snippetsSource) folderPaths = []
    if (SOURCE_KEYS.some((key) => before[key] !== settings[key])) void reload()
    else emit()
  }
  void reload()
  return {
    settings: () => settings,
    ready: () => loaded && !disposed,
    update,
    snippets: () => loaded && !disposed && settings.snippetsEnabled ? active : [],
    errors: () => [...issues, ...(saveIssue ? [saveIssue] : [])].map((e) => ctx.getLocale?.() === 'en' ? e.en : e.zh),
    reload,
    watchMode,
    subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    resetSnippets: () => update({ snippetsSource: 'user', snippetsSourceText: defaultSnippetsText() }),
    dispose: () => {
      disposed = true
      generation++
      clearWatches()
      offVault?.()
      listeners.clear()
      active = []
    },
  }
}
