// LaTeX Suite for Forsion —— obsidian-latex-suite(MIT, artisticat1)的 ProseMirror 重实现。
//
// 装载方式:宿主 `new Function('ctx', main.js)`,footer 里 `return __latexSuite.setup(ctx)`。
// 所以本文件导出的 setup 就是插件入口,返回值是停用时的 disposer。
//
// 分层:
//   snippets/  纯逻辑(选项、匹配、解析、tabstop 语法)—— 与编辑器无关,可单测
//   editor/    ProseMirror 适配(文本视图、数学模式、tabstop 状态机、展开引擎)
//   features/  tabout / 自动分式 / 矩阵 / 括号放大 / 编辑器命令
//   conceal/   实时符号隐藏
//   settingsUi/ 设置面板(宿主给裸 DOM,这里自己画)

import type { PluginContext, PmToolkit } from '../types/forsion'
import type { EditorView } from 'prosemirror-view'
import type { Plugin as PmPlugin } from 'prosemirror-state'
import { createStore } from './store'
import { setTextSelectionCtor } from './editor/text'
import { createTabstops } from './editor/tabstops'
import { createEngine } from './editor/expand'
import { bracketPlugins } from './editor/brackets'
import { mathPreviewPlugins } from './editor/mathPreview'
import { concealPlugins, CONCEAL_CSS } from './conceal/conceal'
import { autoEnlargeBrackets, EDITOR_COMMANDS } from './features'
import { createKeyHandlers } from './keys'
import { mountSettings, SETTINGS_CSS } from './settingsUi'
import { splitList } from './settingsUi/model'

const STYLE_ID = 'latex-suite-styles'

// 占位标记的颜色与几何逐值照上游 styles.css(latex-suite-snippet-placeholder-N / cm-snippetFieldPosition)。
// 明暗跟宿主走:宿主在 <html>(以及独立画出来的面板 / 导出副本)上写 data-mode,变量挂在那一层,
// 就近的那一层说了算 —— 不用 prefers-color-scheme,宿主主题和系统明暗无关。
const BASE_CSS = `
:root, [data-mode="light"] {
  --ls-ph-0-bg: #87cefa2e; --ls-ph-0-outline: #87cefa6e;
  --ls-ph-1-bg: #ffa50033; --ls-ph-1-outline: #ffa5006b;
  --ls-ph-2-bg: #00ff0022; --ls-ph-2-outline: #00ff0060;
}
[data-mode="dark"] {
  --ls-ph-0-outline: #87cefa43;
  --ls-ph-1-outline: #ffa5004d;
  --ls-ph-2-outline: #00ff003d;
}
.latex-suite-snippet-placeholder {
  border-radius: 2px;
  background-color: var(--ls-ph-bg);
  outline: var(--ls-ph-outline) solid 1px;
}
.latex-suite-snippet-placeholder-0 { --ls-ph-bg: var(--ls-ph-0-bg); --ls-ph-outline: var(--ls-ph-0-outline); }
.latex-suite-snippet-placeholder-1 { --ls-ph-bg: var(--ls-ph-1-bg); --ls-ph-outline: var(--ls-ph-1-outline); }
.latex-suite-snippet-placeholder-2 { --ls-ph-bg: var(--ls-ph-2-bg); --ls-ph-outline: var(--ls-ph-2-outline); }
.latex-suite-snippet-field {
  vertical-align: text-top;
  width: 0;
  height: 1.15em;
  display: inline-block;
  margin: 0 -0.7px -.7em;
  border-left: 1.4px dotted #888;
}
`

function injectStyle(css: string): () => void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = css
  return () => el?.remove()
}

/** 最后被聚焦的编辑器实例(命令面板用)。由 track 插件维护 —— 见 setup 里的说明。 */
let lastView: EditorView | null = null

export function setup(ctx: PluginContext): () => void {
  // 宿主太老(没有编辑器接缝)→ 说清楚原因就退场,别装作装上了。
  if (!ctx.registerEditorExtension) {
    ctx.notify?.('LaTeX Suite 需要 Forsion 2026-08-15 之后的版本(编辑器扩展接缝)', {
      level: 'error',
      title: 'LaTeX Suite',
    })
    return () => {}
  }

  const store = createStore(ctx)
  let autoPaused = false
  let practiceDraft = '$x$\n\n$$ \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} $$'
  const views = new Map<EditorView, () => boolean>()
  const listeners = new Set<() => void>()
  const refresh = (): void => {
    for (const view of views.keys()) if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta('latex-suite-settings', true))
    for (const cb of listeners) cb()
  }
  const offStore = store.subscribe(refresh)
  const togglePause = (): void => { autoPaused = !autoPaused; refresh() }

  const removeStyle = (ctx.addStyle ?? injectStyle)(BASE_CSS + CONCEAL_CSS + SETTINGS_CSS)
  const t = (zh: string, en: string): string => ((ctx.getLocale?.() ?? 'zh') === 'en' ? en : zh)

  // ── 编辑器扩展:高优先级桶(按键)与普通桶(装饰)分开注册。
  //    Tab 被宿主用作列表缩进 —— tabstop 必须能在片段活动时抢在它前面,那只能进 high 桶;
  //    conceal 只是装饰,不抢任何键,放普通桶即可(也就不会挡住宿主的按键行为)。
  ctx.registerEditorExtension(
    (pm: PmToolkit): PmPlugin[] => {
      setTextSelectionCtor(pm.TextSelection)
      const tabstops = createTabstops(pm)
      const engine = createEngine(
        pm,
        tabstops,
        () => store.snippets(),
        () => {
          const s = store.settings()
          return {
            proseSnippetsEnabled: s.proseSnippetsEnabled,
            wordDelimiters: s.wordDelimiters,
            removeSnippetWhitespace: s.removeSnippetWhitespace,
            autoEnlargeBrackets: s.autoEnlargeBrackets,
            autoEnlargeBracketsTriggers: splitList(s.autoEnlargeBracketsTriggers),
            maxRecursion: s.snippetRecursion,
          }
        },
        (view) => enlarge(view),
      )

      const enlarge = (view: EditorView): void => {
        const s = store.settings()
        autoEnlargeBrackets(view, {
          triggers: splitList(s.autoEnlargeBracketsTriggers),
          space: s.autoEnlargeBracketsSpace,
        })
      }
      const handlers = createKeyHandlers({
        settings: () => store.settings(),
        ready: () => store.ready(),
        paused: () => autoPaused,
        engine,
        tabstops,
        enlarge,
      })
      const keys = new pm.Plugin({
        key: new pm.PluginKey('LATEX_SUITE_KEYS'),
        props: {
          handleTextInput: (view: EditorView, from: number, to: number, text: string): boolean => handlers.handleTextInput(view, from, to, text),
          handleKeyDown: (view: EditorView, event: KeyboardEvent): boolean => handlers.handleKeyDown(view, event),
        },
      })

      // 命令面板里的命令拿不到 EditorView(它不在编辑器上下文里跑)。ProseMirror 也没有
      // 「从 DOM 反查 view」的公开接口 —— 所以让扩展自己记账:哪个编辑器最后被聚焦过。
      // ⚠️编辑器销毁时必须销号,否则命令会作用在一个已经死掉的 view 上(Amadeus 里
      // 一篇 v3 笔记有几十个编辑器实例,切页销毁是常态)。
      const track = new pm.Plugin({
        key: new pm.PluginKey('LATEX_SUITE_TRACK'),
        view: (v: EditorView) => {
          views.set(v, () => engine.undoExpansion(v))
          const onFocus = (): void => { lastView = v }
          if (v.hasFocus()) lastView = v
          v.dom.addEventListener('focus', onFocus, true)
          return {
            destroy: () => {
              views.delete(v)
              v.dom.removeEventListener('focus', onFocus, true)
              if (lastView === v) lastView = null
            },
          }
        },
      })

      return [tabstops.plugin, keys, track]
    },
    { priority: 'high' },
  )

  // 普通桶:纯装饰 / 纯浮层,不抢任何按键 —— 排在宿主之后即可,也就绝不会挡住内置行为。
  ctx.registerEditorExtension((pm: PmToolkit): PmPlugin[] => [
    ...concealPlugins(pm, {
      enabled: () => store.ready() && store.settings().concealEnabled,
      revealOnCursor: () => true,
    }),
    ...bracketPlugins(pm, {
      highlight: () => store.ready() && store.settings().highlightBracketsEnabled,
      colorize: () => store.ready() && store.settings().colorPairedBracketsEnabled,
    }),
    ...mathPreviewPlugins(pm, {
      enabled: () => store.ready() && store.settings().mathPreviewEnabled,
    }),
  ])

  // ── 设置面板:宿主给一个裸容器,面板自己画(含片段库的 CodeMirror 编辑器)。
  ctx.registerSettingsView?.({
    id: 'main',
    title: () => t('LaTeX Suite 设置', 'LaTeX Suite settings'),
    mount: (el) =>
      mountSettings(el, {
        get: () => store.settings(),
        set: (patch) => store.update(patch),
        locale: () => ctx.getLocale?.() ?? 'zh',
        snippetErrors: () => store.errors(),
        resetSnippets: () => store.resetSnippets(),
        reload: () => store.reload(),
        watchMode: () => store.watchMode(),
        snippets: () => store.snippets(),
        paused: () => autoPaused,
        togglePause,
        practiceDraft: () => practiceDraft,
        setPracticeDraft: (text) => { practiceDraft = text },
        mountPractice: ctx.ui?.mountMarkdownEditor ? (el, opts) => ctx.ui!.mountMarkdownEditor!(el, opts) : undefined,
        runPracticeCommand: (el, id) => {
          const view = lastView && el.contains(lastView.dom) ? lastView : [...views.keys()].find((v) => el.contains(v.dom))
          if (!view || !view.editable) return
          EDITOR_COMMANDS.find((c) => c.id === id)?.run(view)
          view.focus()
        },
        subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
        // 面板的挂载 deps 是 [pluginId, def],语言变了宿主不会重挂 —— 面板自己订阅重绘。
        subscribeLocale: (cb: () => void) => ctx.subscribeLocale?.(() => cb()) ?? (() => {}),
      }),
  })

  // ── 命令面板:公式相关的几个操作。view 由上面的 track 插件记账(见那儿的说明)。
  const activeView = (): EditorView | null => (lastView?.dom.isConnected ? lastView : null)
  for (const cmd of EDITOR_COMMANDS) {
    ctx.registerCommand({
      id: `latex-${cmd.id}`,
      title: () => t(cmd.titleZh, cmd.titleEn),
      keywords: `latex math 公式 ${cmd.id}`,
      run: () => {
        const view = activeView()
        if (!view) {
          ctx.app.notify(t('请先把光标放进一篇笔记', 'Put the cursor in a note first'))
          return
        }
        if (!view.editable || !cmd.run(view)) ctx.app.notify(t('光标不在公式里', 'Cursor is not inside an equation'))
        else view.focus()
      },
    })
  }

  ctx.registerCommand({
    id: 'latex-suite-toggle-auto-expansion', title: () => autoPaused ? t('恢复 LaTeX 自动展开', 'Resume LaTeX automatic expansion') : t('暂停 LaTeX 自动展开', 'Pause LaTeX automatic expansion'),
    run: togglePause,
  })
  ctx.registerCommand({ id: 'latex-suite-reload-snippets', title: () => t('重新加载 LaTeX 片段', 'Reload LaTeX snippets'), run: () => { void store.reload() } })
  ctx.registerCommand({ id: 'latex-suite-restore-trigger', title: () => t('还原刚刚展开的 LaTeX 触发串', 'Restore the last LaTeX trigger'), run: () => {
    const view = activeView()
    if (!view || !view.editable || !views.get(view)?.()) ctx.app.notify(t('没有可还原的自动展开', 'No automatic expansion to restore'))
    else view.focus()
  } })
  return () => {
    offStore()
    listeners.clear()
    views.clear()
    lastView = null
    store.dispose()
    removeStyle()
  }
}
