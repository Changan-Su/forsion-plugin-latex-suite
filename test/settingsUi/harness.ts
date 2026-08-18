// 设置面板的浏览器台架入口:把 mountSettings 挂进一个假宿主容器,并把操作接口挂到 window.H。
// 只装设置面板,**不经过 main.ts** —— 这里要验的是面板本身,不该被插件其余部分的状态牵连。
import { mountSettings, type SettingsUiApi } from '../../src/settingsUi'
import { DEFAULT_SETTINGS, type LatexSuiteSettings } from '../../src/settingsUi/model'

let settings: LatexSuiteSettings = { ...DEFAULT_SETTINGS }
let errors: string[] = []
let locale: 'zh' | 'en' = 'zh'
const listeners = new Set<() => void>()
const localeListeners = new Set<() => void>()
const emit = (): void => { for (const cb of Array.from(listeners)) cb() }

const api: SettingsUiApi = {
  get: () => settings,
  // 真宿主(store.update)也是同步 emit 的 —— 台架必须照做,否则「面板写入 → 自己收到通知」
  // 这条回声路径根本测不到。
  set: (patch) => { settings = { ...settings, ...patch }; emit() },
  locale: () => locale,
  snippetErrors: () => errors,
  resetSnippets: () => { settings = { ...settings, snippetsSourceText: DEFAULT_SETTINGS.snippetsSourceText }; emit() },
  subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
  subscribeLocale: (cb) => { localeListeners.add(cb); return () => localeListeners.delete(cb) },
}

let dispose: (() => void) | null = null

const H = {
  mount: () => {
    dispose?.()
    dispose = mountSettings(document.getElementById('host') as HTMLElement, api)
  },
  unmount: () => { dispose?.(); dispose = null },
  settings: () => settings,
  setErrors: (e: string[]) => { errors = e; emit() },
  setLocale: (l: 'zh' | 'en') => { locale = l; for (const cb of Array.from(localeListeners)) cb() },
  externalSnippets: (text: string) => { settings = { ...settings, snippetsSourceText: text }; emit() },
}
;(window as unknown as Record<string, unknown>).H = H
