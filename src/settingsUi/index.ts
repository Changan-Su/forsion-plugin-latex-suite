// 设置面板 —— 上游 PluginSettingTab(935 行 Obsidian Setting 链式调用)的对位实现。
//
// 宿主给的是 `registerSettingsView({ mount(el) })`:**一个裸 div**,没有 Setting、没有 Modal、
// 没有 setIcon,里面画什么全归插件。所以这里自己搭了最小的一套:标签页 + 行 + 控件工厂。
// 纯 DOM,不引框架 —— 为了一个设置页把 React 打进 main.js 不划算(而且宿主的 React 拿不到)。
//
// 与上游的取舍差异(**刻意**):
//  1. 上游是一条 900 行的长卷,十个分区首尾相连,找一个开关得滚半天。这里切成七个标签页。
//  2. 上游的破坏性操作弹 Modal 确认。Amadeus 这边:插件拿不到宿主的 Modal,而 Electron 里
//     `window.confirm` 会锁死渲染进程(memory 有案底:Electron 无 window.prompt)。所以改成
//     **按钮二段式** —— 首点变成「再点一次确认」,失焦自动复位。
//  3. 上游的文件路径框带 FileSuggest 自动补全(要 Obsidian 的 vault 索引)。这里退化成纯文本框,
//     宿主 `app.listFiles?.()` 是异步且不保证存在的接缝,补全交给以后。

import { SETTINGS_CSS } from './css'
import { createT, type StringKey } from './i18n'
import type { LatexSuiteSettings } from './model'
import { createSnippetsEditor, type SnippetsEditorHandle } from './cmEditor'

export { SETTINGS_CSS } from './css'
export { DEFAULT_SETTINGS, mergeSettings, serializeRawSnippets, splitList } from './model'
export type { LatexSuiteSettings } from './model'

/** 面板向宿主要的全部东西。主入口负责实现 —— 面板不碰 ctx,也就不需要知道设置存在哪、怎么落盘。 */
export interface SettingsUiApi {
  get(): LatexSuiteSettings
  /** 增量写。主入口应就地合并 + 落盘 + 让引擎重新读设置。 */
  set(patch: Partial<LatexSuiteSettings>): void
  locale(): 'zh' | 'en'
  /** 片段库的解析错误(含从文件加载失败),显示在编辑器上方。面板在每次 set 之后重新拉一遍。 */
  snippetErrors(): string[]
  /** 恢复默认片段库。实现应写 DEFAULT_SETTINGS.snippetsSourceText —— 面板随后回读 get() 刷新编辑器。 */
  resetSnippets(): void
  /**
   * 可选:设置 / 片段表发生**外部**变化时通知(文件热重载、异步读盘完成、别处改了设置)。
   *
   * ⚠️收到通知**不重画面板**,只把值和错误刷新一遍。这条线一秒能响好几次(片段文件一改就重解析),
   * 重画会把用户正在打字的 CodeMirror 当场销毁。面板自己写入引发的回声也会被就地忽略。
   */
  subscribe?(cb: () => void): () => void
  /** 可选:宿主语言切换订阅(`ctx.subscribeLocale`)。这条**才**触发重画 —— 文案散在 30+ 个节点里。
   *  宿主挂载面板的 deps 是 [pluginId, def],语言变了不会重挂,不订阅就一直停在旧语言。 */
  subscribeLocale?(cb: () => void): () => void
}

// ── 类型工具:按值类型筛出设置里的键,行工厂就能只吃对得上的键(写错键名当场编译不过)。
type KeysOfType<T> = { [K in keyof LatexSuiteSettings]: LatexSuiteSettings[K] extends T ? K : never }[keyof LatexSuiteSettings]
type BoolKey = KeysOfType<boolean>
type StrKey = KeysOfType<string>
type NumKey = KeysOfType<number>

/** 计算键的 patch。唯一一处断言:`{ [key]: v }` 在 TS 里会推成索引签名,和 Partial<…> 对不上。 */
const patchOf = (key: keyof LatexSuiteSettings, value: unknown): Partial<LatexSuiteSettings> =>
  ({ [key]: value }) as Partial<LatexSuiteSettings>

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text) node.textContent = text
  return node
}

// ── 样式注入:模块级只存字符串,createElement 一律等到 mount。
// 这个文件会被打进 main.js 交给 `new Function` 求值,而 check.mjs 在 node 里跑装载 —— 模块顶层
// 碰 document 就当场炸。
//
// 主入口通常已经把 SETTINGS_CSS 拼进它自己那张 style 里了。这里扫一遍哨兵串确认「已经有了」就不再注入,
// 但**绝不去删别人的标签** —— 那张里还拼着 conceal 等别处的样式。
//
// ⚠️扫描必须**排除自己那张**:哨兵串就写在 SETTINGS_CSS 正文里,自己注入完再扫必然扫到自己。
// 后果是第二次挂载被误判成「别人已经注入过」而返回 noop,引用计数停在 1 —— 第一个面板一拆,
// 样式被整张拔掉,还活着的第二个面板当场裸奔(多窗口、或设置页与插件详情页同时开着就会遇到)。
let cssRefs = 0
const CSS_ID = 'ls-settings-css'
const CSS_SENTINEL = 'ls-settings-css-v1'

const noop = (): void => {}

function ensureCss(): () => void {
  const own = document.getElementById(CSS_ID)
  const byOthers = Array.from(document.querySelectorAll('style')).some(
    (el) => el !== own && el.textContent?.includes(CSS_SENTINEL),
  )
  if (byOthers) return noop
  cssRefs++
  if (!own) {
    const style = h('style')
    style.id = CSS_ID
    style.textContent = SETTINGS_CSS
    document.head.appendChild(style)
  }
  return () => {
    cssRefs = Math.max(0, cssRefs - 1)
    if (cssRefs === 0) document.getElementById(CSS_ID)?.remove()
  }
}

/**
 * computed color 串 → 0–255 的三通道;认不出就给 null(**不要**默默当成黑)。
 *
 * ⚠️必须认两种序列化,这是宿主坑册里的记名事故:
 *   - 传统写法 `rgb(28, 28, 28)` / `rgba(…)` / 新语法 `rgb(28 28 28 / 50%)`,通道 **0–255**
 *   - 色空间函数 `color(srgb 0.97 0.96 0.95)`,通道 **0–1** —— 主题里凡是经 `color-mix()` 算出来的
 *     颜色,Chromium 就序列化成这一种。按 0–255 读会把近白算成 0.97 ≈ 全黑,明暗判断整个翻面。
 *
 * 导出只为单测(test/settingsUi/color.test.ts)—— 这条判断错了整片配色翻面,而它在无头环境里
 * 量不出来,只能拿真实序列化串钉死。
 */
export function parseChannels(color: string): [number, number, number] | null {
  const m = /^\s*(rgba?|color)\(([^)]+)\)/i.exec(color)
  if (!m) return null
  const isColorFn = m[1].toLowerCase() === 'color'
  // 逗号式与空格斜杠式一起切;color() 的头一个 token 是色空间名,得先扔掉。
  const tokens = m[2].trim().split(/[,\s/]+/).filter((tk) => tk.length > 0)
  const raw = (isColorFn ? tokens.slice(1) : tokens).slice(0, 3)
  if (raw.length < 3) return null
  const full = isColorFn ? 1 : 255 // 该写法下「满通道」是多少
  const out = raw.map((tk) => {
    const n = parseFloat(tk)
    if (!Number.isFinite(n)) return NaN
    return (tk.endsWith('%') ? (n / 100) * full : n) * (255 / full)
  })
  if (out.some((n) => !Number.isFinite(n))) return null
  return [out[0], out[1], out[2]]
}

/** 容器是深色底吗 —— 量**文字颜色**的亮度反推;量不出来给 null,由调用方决定保留原判断。
 *  为什么不用 prefers-color-scheme:宿主主题是应用内自己切的(素纸/夜航…),和系统明暗无关,
 *  媒体查询在这里会猜错。文字亮 = 底暗,这个反推对任何皮肤都成立。
 *  ⚠️返回 null 的两种情形都真实存在:容器还没进文档(computed 全空)、颜色写成 lab()/oklch()
 *  这类本函数不认的空间。这两种都不该翻成「浅色」—— 那是猜,而猜错的代价是整片配色翻面。 */
function measureDark(el: HTMLElement): boolean | null {
  const ch = parseChannels(getComputedStyle(el).color)
  if (!ch) return null
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2] > 140
}

/** 输入类控件的落盘节奏:停手 300ms 才写。逐键写会把宿主的 saveData 打成筛子。 */
const INPUT_DELAY = 300

interface Deferred {
  flush(): void
  cancel(): void
}

export function mountSettings(el: HTMLElement, api: SettingsUiApi): () => void {
  const releaseCss = ensureCss()
  // 重画时把标签停在原处 —— 在「显示」页切了个语言,回来发现自己被扔回「片段」页是很烦的。
  let activeTab = 0
  const start = (): (() => void) => render(el, api, { initialTab: activeTab, onTab: (i) => { activeTab = i } })
  let teardown = start()
  // 语言切换 = 整块重画。文案散在 30+ 个节点里,逐个改还不如重来一遍;重来一遍就必须走同一个
  // teardown(里面会 flush 未落盘的输入并 destroy 掉 CM6)。
  const offLocale = api.subscribeLocale?.(() => {
    teardown()
    teardown = start()
  })
  return () => {
    offLocale?.()
    teardown()
    releaseCss()
  }
}

interface RenderOpts {
  initialTab: number
  onTab(index: number): void
}

/** 面板实例号。同一时刻可能有两份面板在场(多窗口、或设置页与插件详情页各挂一份),
 *  而 id 是全文档唯一的 —— 不带实例号的话 `list=` / `aria-labelledby` 会指到**另一份面板**的节点上。 */
let instanceSeq = 0

/** 能承接 `aria-labelledby` 的控件。 */
const CONTROL_SEL = 'button, input, select, textarea'

function render(host: HTMLElement, api: SettingsUiApi, opts: RenderOpts): () => void {
  const t = createT(api.locale())
  const s = (): LatexSuiteSettings => api.get()
  const uid = `ls${++instanceSeq}`
  let labelSeq = 0

  /** 把行标题接到控件上。开关是个光秃秃的 `button[role=switch]`,不接的话读屏只念得出「开关」,
   *  念不出这是哪一项。deep=false 用于整块行:那里的 body 里还躺着页脚按钮,深挖会把标题
   *  错接到「恢复默认」上。 */
  const labelControl = (control: HTMLElement, labelEl: HTMLElement, deep: boolean): void => {
    const target = control.matches(CONTROL_SEL)
      ? control
      : deep
        ? control.querySelector<HTMLElement>(CONTROL_SEL)
        : null
    if (!target) return
    labelEl.id = `${uid}-lbl-${labelSeq++}`
    target.setAttribute('aria-labelledby', labelEl.id)
  }

  const root = h('div', 'ls-settings')
  host.appendChild(root)
  // 挂进容器之后才量得到颜色(样式要先继承下来)。容器此刻可能还没进文档 —— 那种情况下
  // getComputedStyle 给不出有效值,先按亮色走,下一帧再复核一次。
  let dark = measureDark(root) ?? false
  const applyScheme = (): void => {
    root.classList.toggle('ls-dark', dark)
    // color-scheme 管的是**浏览器自己画的那部分**:select 弹出的选项列表、焦点环、框内滚动条。
    // 不设的话,宿主是深色皮肤时点开下拉会弹出一片白。
    root.style.colorScheme = dark ? 'dark' : 'light'
  }
  applyScheme()

  const deferreds: Deferred[] = []
  const hooks: (() => void)[] = []
  const syncAll = (): void => {
    for (const fn of hooks) fn()
  }
  // 面板最后一次「知道」的片段库正文。外部回灌只在这个值真的变了时才动编辑器 —— 否则用户
  // 写到一半的(还没通过语法校验、因而没落盘的)现场会被一次无关的通知抹掉。
  let lastSeenText = s().snippetsSourceText
  // 自己写入期间为真。`api.set` 往往会同步回调 subscribe(store 立刻 emit),不挡住的话
  // 「面板写 → 收到通知 → 再刷新一遍面板」会在每次按键上多跑一圈,还可能把输入框里的值抢回去。
  let writing = false
  /** 任何一次写入都走这里:落盘 + 刷新联动可见性 + 重新拉一遍片段库错误。 */
  const write = (patch: Partial<LatexSuiteSettings>): void => {
    writing = true
    try {
      api.set(patch)
    } finally {
      writing = false
    }
    if (patch.snippetsSourceText !== undefined) lastSeenText = patch.snippetsSourceText
    syncAll()
    refreshErrors()
  }

  // ── 标签页骨架
  const tabsBar = h('div', 'ls-tabs')
  root.appendChild(tabsBar)
  const panes: HTMLElement[] = []
  const tabs: HTMLButtonElement[] = []
  let editor: SnippetsEditorHandle | null = null

  const addTab = (labelKey: StringKey): HTMLElement => {
    const btn = h('button', 'ls-tab', t(labelKey))
    btn.type = 'button'
    const pane = h('div', 'ls-pane')
    const index = panes.length
    btn.addEventListener('click', () => activate(index))
    tabsBar.appendChild(btn)
    root.appendChild(pane)
    tabs.push(btn)
    panes.push(pane)
    return pane
  }

  const activate = (index: number): void => {
    panes.forEach((pane, i) => {
      pane.hidden = i !== index
      tabs[i].classList.toggle('is-active', i === index)
    })
    opts.onTab(index)
    // 片段页藏起来时 CM 量到的高度是 0;重新露出来必须让它再量一次,否则光标定位全错。
    if (index === 0) editor?.measure()
    refreshErrors()
  }

  // ── 行与控件
  interface RowOpts {
    label: StringKey
    desc: StringKey
    control: HTMLElement
    visible?: () => boolean
  }

  const addRow = (pane: HTMLElement, o: RowOpts): void => {
    const row = h('div', 'ls-row')
    const main = h('div', 'ls-row-main')
    const labelEl = h('div', 'ls-row-label', t(o.label))
    main.appendChild(labelEl)
    main.appendChild(h('div', 'ls-row-desc', t(o.desc)))
    const ctl = h('div', 'ls-row-ctl')
    ctl.appendChild(o.control)
    row.append(main, ctl)
    pane.appendChild(row)
    labelControl(o.control, labelEl, true)
    const { visible } = o
    if (visible) hooks.push(() => { row.hidden = !visible() })
  }

  /** 整块行:控件占满宽度(编辑器、大文本框)。 */
  const addBlock = (pane: HTMLElement, label: StringKey, desc: StringKey, body: HTMLElement, visible?: () => boolean): void => {
    const block = h('div', 'ls-block')
    const head = h('div', 'ls-block-head')
    const labelEl = h('div', 'ls-row-label', t(label))
    head.appendChild(labelEl)
    head.appendChild(h('div', 'ls-row-desc', t(desc)))
    block.append(head, body)
    pane.appendChild(block)
    labelControl(body, labelEl, false)
    // 先落成 const 再进闭包:TS 对「可选参数」的收窄不保证带进后跑的回调里。
    const vis = visible
    if (vis) hooks.push(() => { block.hidden = !vis() })
  }

  const toggle = (key: BoolKey): HTMLElement => {
    const btn = h('button', 'ls-switch')
    btn.type = 'button'
    btn.setAttribute('role', 'switch')
    const sync = (): void => btn.setAttribute('aria-checked', String(s()[key]))
    sync()
    hooks.push(sync)
    btn.addEventListener('click', () => write(patchOf(key, !s()[key])))
    return btn
  }

  // 选项值按**该字段自己的字面量联合**收 —— 'Tab' 写成 'tab' 这类错在这里编译不过。
  // 不然只有等用户点开下拉、看到一个空白的选中项才发现(select 对不上任何 option 时显示空)。
  const select = <K extends StrKey>(key: K, options: [value: LatexSuiteSettings[K], label: StringKey][]): HTMLElement => {
    const node = h('select', 'ls-select')
    for (const [value, label] of options) {
      const opt = h('option', undefined, t(label))
      opt.value = value
      node.appendChild(opt)
    }
    const sync = (): void => { node.value = s()[key] }
    sync()
    hooks.push(sync)
    node.addEventListener('change', () => write(patchOf(key, node.value)))
    return node
  }

  /** 文本框。改动 debounce,失焦立刻结算 —— 用户改完直接切标签页时不该丢。 */
  const textInput = (key: StrKey, opts?: { mono?: boolean; suggestions?: string[] }): HTMLElement => {
    // 包一层是因为 datalist 必须与 input 同在 DOM 里(它自己 display:none,不占位)。
    const wrap = h('span', 'ls-ctl')
    const input = h('input', `ls-input${opts?.mono ? ' ls-input--mono' : ''}`)
    input.type = 'text'
    input.value = s()[key]
    if (opts?.suggestions?.length) {
      // datalist 只是提示,不限制取值(上游用同样的手法给 \frac/\dfrac/\tfrac 做候选)。
      // id 带实例号:两份面板同时在场时,不带的话两个 datalist 同 id,`list=` 只认得先进 DOM 的那个。
      const listId = `${uid}-dl-${key}`
      const list = h('datalist')
      list.id = listId
      for (const value of opts.suggestions) {
        const opt = h('option')
        opt.value = value
        list.appendChild(opt)
      }
      input.setAttribute('list', listId)
      wrap.appendChild(list)
    }
    wrap.appendChild(input)

    let timer: ReturnType<typeof setTimeout> | null = null
    const commit = (): void => {
      timer = null
      if (input.value !== s()[key]) write(patchOf(key, input.value))
    }
    const deferred: Deferred = {
      flush: () => { if (timer) { clearTimeout(timer); commit() } },
      cancel: () => { if (timer) { clearTimeout(timer); timer = null } },
    }
    deferreds.push(deferred)
    input.addEventListener('input', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(commit, INPUT_DELAY)
    })
    input.addEventListener('blur', deferred.flush)
    // 外部改了设置(如恢复默认)时把框里的值拉回来 —— 但用户正在里面打字就别抢。
    hooks.push(() => { if (document.activeElement !== input) input.value = s()[key] })
    return wrap
  }

  /** 非负整数框。非法输入**不写**设置(照上游),只把框标红 —— 清空重打的中间态不该把值改成 0。 */
  const numberInput = (key: NumKey): HTMLElement => {
    const input = h('input', 'ls-input ls-input--num')
    input.type = 'text'
    input.inputMode = 'numeric'
    input.value = String(s()[key])

    let timer: ReturnType<typeof setTimeout> | null = null
    const commit = (): void => {
      timer = null
      const ok = /^\d+$/.test(input.value.trim())
      input.setAttribute('aria-invalid', String(!ok))
      if (!ok) return
      const value = Number(input.value.trim())
      if (value !== s()[key]) write(patchOf(key, value))
    }
    const deferred: Deferred = {
      flush: () => { if (timer) { clearTimeout(timer); commit() } },
      cancel: () => { if (timer) { clearTimeout(timer); timer = null } },
    }
    deferreds.push(deferred)
    input.addEventListener('input', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(commit, INPUT_DELAY)
    })
    input.addEventListener('blur', deferred.flush)
    hooks.push(() => {
      if (document.activeElement === input) return
      // 人已经走了:把设置里的真值拉回来,顺手撤掉红边 —— 框里留着一个红的非法值、
      // 而设置其实是另一个数,是最误导人的状态。
      input.value = String(s()[key])
      input.removeAttribute('aria-invalid')
    })
    return input
  }

  const textArea = (key: StrKey): HTMLElement => {
    const area = h('textarea', 'ls-textarea')
    area.value = s()[key]
    area.spellcheck = false

    let timer: ReturnType<typeof setTimeout> | null = null
    const commit = (): void => {
      timer = null
      if (area.value !== s()[key]) write(patchOf(key, area.value))
    }
    const deferred: Deferred = {
      flush: () => { if (timer) { clearTimeout(timer); commit() } },
      cancel: () => { if (timer) { clearTimeout(timer); timer = null } },
    }
    deferreds.push(deferred)
    area.addEventListener('input', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(commit, INPUT_DELAY)
    })
    area.addEventListener('blur', deferred.flush)
    hooks.push(() => { if (document.activeElement !== area) area.value = s()[key] })
    return area
  }

  /** 破坏性按钮:首点武装、再点执行、失焦复位。没有 Modal 可用,也不敢用 window.confirm。 */
  const armedButton = (label: StringKey, confirmLabel: StringKey, run: () => void): HTMLButtonElement => {
    const btn = h('button', 'ls-btn', t(label))
    btn.type = 'button'
    let armed = false
    const disarm = (): void => {
      armed = false
      btn.textContent = t(label)
      btn.classList.remove('is-armed')
    }
    btn.addEventListener('click', () => {
      if (!armed) {
        armed = true
        btn.textContent = t(confirmLabel)
        btn.classList.add('is-armed')
        return
      }
      disarm()
      run()
    })
    btn.addEventListener('blur', disarm)
    return btn
  }

  // ── 片段页
  const snippetsPane = addTab('tab.snippets')
  addRow(snippetsPane, { label: 'snippets.enabled.label', desc: 'snippets.enabled.desc', control: toggle('snippetsEnabled') })
  addRow(snippetsPane, {
    label: 'snippets.trigger.label',
    desc: 'snippets.trigger.desc',
    control: select('snippetsTrigger', [['Tab', 'snippets.trigger.tab'], ['Space', 'snippets.trigger.space']]),
    visible: () => s().snippetsEnabled,
  })
  addRow(snippetsPane, {
    label: 'snippets.source.label',
    desc: 'snippets.source.desc',
    control: select('snippetsSource', [
      ['user', 'snippets.source.user'],
      ['file', 'snippets.source.file'],
      ['folder', 'snippets.source.folder'],
    ]),
  })
  addRow(snippetsPane, {
    label: 'snippets.file.label',
    desc: 'snippets.file.desc',
    control: textInput('snippetsFile', { mono: true }),
    visible: () => s().snippetsSource === 'file',
  })
  addRow(snippetsPane, {
    label: 'snippets.folder.label',
    desc: 'snippets.folder.desc',
    control: textInput('snippetsFolder', { mono: true }),
    visible: () => s().snippetsSource === 'folder',
  })

  // 片段库编辑器:提示条 + 错误面板 + CM6 + 页脚(状态 / 恢复默认 / 清空)
  const editorBox = h('div')
  const externalNote = h('div', 'ls-note', t('snippets.externalHint'))
  const errorsBox = h('div', 'ls-errors')
  const errorsList = h('div')
  errorsBox.append(h('div', 'ls-errors-title', t('snippets.problems')), errorsList)
  const status = h('div', 'ls-cm-status', t('snippets.saved'))
  const footer = h('div', 'ls-cm-footer')
  const actions = h('div', 'ls-cm-actions')

  function refreshErrors(): void {
    const errors = api.snippetErrors()
    errorsBox.hidden = errors.length === 0
    errorsList.textContent = ''
    for (const message of errors) errorsList.appendChild(h('div', 'ls-errors-item', message))
  }

  editor = createSnippetsEditor({
    value: s().snippetsSourceText,
    dark,
    onTyping: () => {
      status.classList.add('is-pending')
    },
    onSettle: (text, valid) => {
      status.classList.remove('is-pending')
      status.classList.toggle('is-invalid', !valid)
      status.textContent = valid ? t('snippets.saved') : t('snippets.invalid')
      // 语法不通过就不落盘:半截的片段库存进去,插件下次启动会整份失效。
      if (valid) write({ snippetsSourceText: text })
    },
  })

  const applySnippetsText = (text: string): void => {
    editor?.setValue(text)
    lastSeenText = text
    status.classList.remove('is-pending', 'is-invalid')
    status.textContent = t('snippets.saved')
  }

  actions.append(
    armedButton('snippets.reset', 'snippets.resetConfirm', () => {
      api.resetSnippets()
      // 默认正文以宿主回读为准 —— 面板不自己拼一份,免得和 resetSnippets 的实现漂开。
      applySnippetsText(s().snippetsSourceText)
      syncAll()
      refreshErrors()
    }),
    armedButton('snippets.clear', 'snippets.clearConfirm', () => {
      const empty = '[\n\n]'
      write({ snippetsSourceText: empty })
      applySnippetsText(empty)
    }),
  )
  footer.append(status, actions)
  editorBox.append(externalNote, errorsBox, editor.dom, footer)
  hooks.push(() => { externalNote.hidden = s().snippetsSource === 'user' })
  addBlock(snippetsPane, 'snippets.editor.label', 'snippets.editor.desc', editorBox)

  // ── 自动分式页
  const afPane = addTab('tab.autofraction')
  addRow(afPane, { label: 'af.enabled.label', desc: 'af.enabled.desc', control: toggle('autofractionEnabled') })
  addRow(afPane, {
    label: 'af.symbol.label',
    desc: 'af.symbol.desc',
    control: textInput('autofractionSymbol', { mono: true, suggestions: ['\\frac', '\\dfrac', '\\tfrac'] }),
    visible: () => s().autofractionEnabled,
  })
  addRow(afPane, {
    label: 'af.breaking.label',
    desc: 'af.breaking.desc',
    control: textInput('autofractionBreakingChars', { mono: true }),
    visible: () => s().autofractionEnabled,
  })
  addBlock(afPane, 'af.excluded.label', 'af.excluded.desc', textArea('autofractionExcludedEnvs'), () => s().autofractionEnabled)

  // ── Tabout 页
  const taboutPane = addTab('tab.tabout')
  addRow(taboutPane, { label: 'tabout.enabled.label', desc: 'tabout.enabled.desc', control: toggle('taboutEnabled') })
  addRow(taboutPane, {
    label: 'tabout.eol.label',
    desc: 'tabout.eol.desc',
    control: toggle('taboutExitEquationOnlyOnEOL'),
    visible: () => s().taboutEnabled,
  })
  addRow(taboutPane, {
    label: 'tabout.symbols.label',
    desc: 'tabout.symbols.desc',
    control: textInput('taboutClosingSymbols', { mono: true }),
    visible: () => s().taboutEnabled,
  })

  // ── 矩阵页
  const matrixPane = addTab('tab.matrix')
  addRow(matrixPane, { label: 'matrix.enabled.label', desc: 'matrix.enabled.desc', control: toggle('matrixShortcutsEnabled') })
  addRow(matrixPane, {
    label: 'matrix.envs.label',
    desc: 'matrix.envs.desc',
    control: textInput('matrixShortcutsEnvNames', { mono: true }),
    visible: () => s().matrixShortcutsEnabled,
  })
  addRow(matrixPane, {
    label: 'matrix.macros.label',
    desc: 'matrix.macros.desc',
    control: textInput('matrixShortcutsMacroNames', { mono: true }),
    visible: () => s().matrixShortcutsEnabled,
  })

  // ── 括号页
  const bracketsPane = addTab('tab.brackets')
  addRow(bracketsPane, { label: 'brk.enlarge.label', desc: 'brk.enlarge.desc', control: toggle('autoEnlargeBrackets') })
  addRow(bracketsPane, {
    label: 'brk.triggers.label',
    desc: 'brk.triggers.desc',
    control: textInput('autoEnlargeBracketsTriggers', { mono: true }),
    visible: () => s().autoEnlargeBrackets,
  })
  addRow(bracketsPane, {
    label: 'brk.space.label',
    desc: 'brk.space.desc',
    control: toggle('autoEnlargeBracketsSpace'),
    visible: () => s().autoEnlargeBrackets,
  })

  // ── 显示页
  const displayPane = addTab('tab.display')
  addRow(displayPane, { label: 'disp.conceal.label', desc: 'disp.conceal.desc', control: toggle('concealEnabled') })
  addRow(displayPane, {
    label: 'disp.concealDelay.label',
    desc: 'disp.concealDelay.desc',
    control: numberInput('concealRevealTimeout'),
    visible: () => s().concealEnabled,
  })
  addRow(displayPane, { label: 'disp.preview.label', desc: 'disp.preview.desc', control: toggle('mathPreviewEnabled') })
  addRow(displayPane, { label: 'disp.highlight.label', desc: 'disp.highlight.desc', control: toggle('highlightBracketsEnabled') })
  addRow(displayPane, { label: 'disp.color.label', desc: 'disp.color.desc', control: toggle('colorPairedBracketsEnabled') })

  // ── 高级页
  const advancedPane = addTab('tab.advanced')
  addRow(advancedPane, {
    label: 'adv.varFromFile.label',
    desc: 'adv.varFromFile.desc',
    control: toggle('loadSnippetVariablesFromFile'),
  })
  addRow(advancedPane, {
    label: 'adv.varFile.label',
    desc: 'adv.varFile.desc',
    control: textInput('snippetVariablesFileLocation', { mono: true }),
    visible: () => s().loadSnippetVariablesFromFile,
  })
  addBlock(
    advancedPane,
    'adv.variables.label',
    'adv.variables.desc',
    textArea('snippetVariablesSourceText'),
    () => !s().loadSnippetVariablesFromFile,
  )
  addRow(advancedPane, {
    label: 'adv.wordDelimiters.label',
    desc: 'adv.wordDelimiters.desc',
    control: textInput('wordDelimiters', { mono: true }),
  })
  addRow(advancedPane, {
    label: 'adv.trimWhitespace.label',
    desc: 'adv.trimWhitespace.desc',
    control: toggle('removeSnippetWhitespace'),
  })
  addRow(advancedPane, { label: 'adv.recursion.label', desc: 'adv.recursion.desc', control: numberInput('snippetRecursion') })

  syncAll()
  refreshErrors()
  activate(Math.min(Math.max(0, opts.initialTab), panes.length - 1))

  // ── 外部变化(片段文件热重载、异步读盘完成、别处改了设置):只刷新,不重画。
  const offExternal = api.subscribe?.(() => {
    if (writing) return // 自己刚写的回声,syncAll 已经跑过了
    syncAll()
    refreshErrors()
    const text = s().snippetsSourceText
    if (text === lastSeenText) return // 正文没变 → 编辑器里是用户的现场,别碰
    lastSeenText = text
    // 用户正在框里打字时让路:抢过去会连光标带撤销历史一起清掉。这一轮就不同步了,
    // 下次进设置页重挂时自然是新值。
    if (editor && !editor.hasFocus()) applySnippetsText(text)
  })

  // 容器此刻可能还没进文档(宿主先 mount 再插 DOM 也是合法的)。下一帧复核一次明暗,
  // 顺便让 CM 重新量尺寸 —— 两件事都依赖「已经有布局」。
  const raf = requestAnimationFrame(() => {
    const now = measureDark(root)
    // null = 这一帧也量不出来(容器仍未进文档 / 颜色是本函数不认的色空间)。保留初判,别乱翻。
    if (now !== null && now !== dark) {
      dark = now
      applyScheme()
      // CM6 的 dark 标志是**构造时**定死的,不跟着 .ls-dark 类走 —— 这里得单独通知它一声,
      // 否则它内部那套选区/光标层还按翻面前的明暗画。
      editor?.setDark(dark)
    }
    editor?.measure()
  })

  return () => {
    offExternal?.()
    cancelAnimationFrame(raf)
    // 顺序有讲究:先把还没到点的输入结算掉(用户改完直接关页面的那 300ms),再拆 CM6。
    for (const d of deferreds) d.flush()
    editor?.flush()
    for (const d of deferreds) d.cancel()
    editor?.destroy()
    editor = null
    root.remove()
  }
}
