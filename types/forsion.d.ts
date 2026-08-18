// Forsion(Amadeus)插件宿主 API 的作者向类型声明 —— 只覆盖本插件用到的那部分。
// 正典是宿主仓的 `desktop/frontend/src/amadeus/plugins/types.ts`;这里是抄件,加了 2026-08-15
// 那批新接缝(registerEditorExtension / registerSettingsView / loadData / saveData / app.watchFile)。
//
// ⚠️宿主老版本不一定有新接缝 —— 一律按可选声明,调用点必须走可选链并有降级路径。

import type { Plugin as PmPlugin, PluginKey, Selection, TextSelection, NodeSelection } from 'prosemirror-state'
import type { Decoration, DecorationSet } from 'prosemirror-view'
import type { Slice, Fragment } from 'prosemirror-model'
import type { keymap } from 'prosemirror-keymap'
import type { InputRule, inputRules } from 'prosemirror-inputrules'

export interface PmToolkit {
  Plugin: typeof PmPlugin
  PluginKey: typeof PluginKey
  Selection: typeof Selection
  TextSelection: typeof TextSelection
  NodeSelection: typeof NodeSelection
  Decoration: typeof Decoration
  DecorationSet: typeof DecorationSet
  Slice: typeof Slice
  Fragment: typeof Fragment
  keymap: typeof keymap
  InputRule: typeof InputRule
  inputRules: typeof inputRules
}

export interface PluginAppApi {
  getActivePage(): string | null
  notify(message: string): void
  readFile(path: string): Promise<string | null>
  writeFile(path: string, text: string): Promise<void>
  workFolder?(): string
  openFile(path: string): void
  listFiles?(): Promise<string[]>
  vaultRoot?(): string | null
  /** 2026-08-15+;缺位时自己退化成轮询。 */
  watchFile?(path: string, cb: () => void): () => void
}

export interface SettingsViewContribution {
  id: string
  title?: string
  mount(el: HTMLElement): void | (() => void)
}

export interface CommandContribution {
  id: string
  title: string
  keywords?: string
  run(): void
}

export interface PluginContext {
  app: PluginAppApi
  registerCommand(command: CommandContribution): void
  notify?(message: string, opts?: { level?: 'info' | 'success' | 'warning' | 'error'; title?: string; sticky?: boolean }): void
  getLocale?(): 'zh' | 'en'
  subscribeLocale?(cb: (locale: 'zh' | 'en') => void): () => void
  registerSetting(def: {
    key: string
    label: string
    type: 'number' | 'boolean' | 'text'
    default: string | number | boolean
    min?: number
    max?: number
    description?: string
  }): void
  /** 2026-08-15+ */
  registerSettingsView?(def: SettingsViewContribution): void
  /** 2026-08-15+。`priority:'high'` = 排在宿主全部插件之前(接管 Tab 这类已被占用的键必须用它;
   *  代价是自己不处理的按键**必须** return false,否则内置行为静默消失)。 */
  registerEditorExtension?(
    factory: (pm: PmToolkit) => PmPlugin[],
    opts?: { priority?: 'high' | 'normal' },
  ): void
  /** 2026-08-15+ */
  loadData?<T = unknown>(): Promise<T | null>
  /** 2026-08-15+ */
  saveData?(value: unknown): Promise<void>
  activity?: { log(event: string, detail?: Record<string, unknown>): void }
}
