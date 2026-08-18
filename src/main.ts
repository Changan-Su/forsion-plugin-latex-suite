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
import { autoEnlargeBrackets, autoFraction, matrixShortcut, tabout, taboutByCloseBracket, EDITOR_COMMANDS } from './features'
import { mountSettings, SETTINGS_CSS } from './settingsUi'
import { splitList } from './settingsUi/model'

/** `autofractionExcludedEnvs` 存的是一段 JSON(`[["^{","}"], …]`)—— 上游格式。
 *  解析失败一律给空表:一个写坏的设置不该让自动分式整个不能用。 */
function parseExcludedEnvs(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    // 兼容两种写法:["^{", "\\pu{"] 与 [["^{","}"], …](只取左定界符)
    return v.map((x) => (Array.isArray(x) ? String(x[0] ?? '') : String(x ?? ''))).filter(Boolean)
  } catch {
    return []
  }
}

const STYLE_ID = 'latex-suite-styles'

const BASE_CSS = `
.latex-suite-tabstop {
  background: color-mix(in srgb, var(--interactive-accent, #6b8afd) 18%, transparent);
  border-radius: 2px;
}
.latex-suite-tabstop-active {
  background: color-mix(in srgb, var(--interactive-accent, #6b8afd) 34%, transparent);
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
  const removeStyle = injectStyle(BASE_CSS + CONCEAL_CSS + SETTINGS_CSS)
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
            wordDelimiters: s.wordDelimiters,
            removeSnippetWhitespace: s.removeSnippetWhitespace,
            autoEnlargeBrackets: s.autoEnlargeBrackets,
            autoEnlargeBracketsTriggers: splitList(s.autoEnlargeBracketsTriggers),
            maxRecursion: s.snippetRecursion,
          }
        },
        (view) => enlarge(view),
      )

      // 设置 → 各特性入参的**唯一**换算点。散着写就会出现「同一次 Tab 用了两套右定界符名单」
      // 这类对不上的账(自审实测到过)。
      const s0 = () => store.settings()
      const taboutOpts = (s: ReturnType<typeof s0>) => ({
        closingSymbols: splitList(s.taboutClosingSymbols),
        exitOnlyOnEOL: s.taboutExitEquationOnlyOnEOL,
      })
      const matrixOpts = (s: ReturnType<typeof s0>) => ({
        macros: splitList(s.matrixShortcutsMacroNames),
        // 与 tabout 同一份名单:矩阵快捷键内部会先「跳出括号」,那一步用的就是右定界符表。
        closingSymbols: splitList(s.taboutClosingSymbols),
      })
      const enlarge = (view: EditorView): void => {
        const s = s0()
        autoEnlargeBrackets(view, {
          triggers: splitList(s.autoEnlargeBracketsTriggers),
          space: s.autoEnlargeBracketsSpace,
        })
      }

      const keys = new pm.Plugin({
        key: new pm.PluginKey('LATEX_SUITE_KEYS'),
        props: {
          handleTextInput: (view: EditorView, _from: number, _to: number, text: string): boolean => {
            if (view.composing) return false
            const s = store.settings()
            if (s.snippetsEnabled && engine.onTextInput(view, _from, _to, text)) return true
            // 自动分式的触发键固定是 `/`;设置里的 autofractionSymbol 是**替换出来的命令**
            // (`\frac` / `\dfrac` / `\tfrac`),不是触发键 —— 上游同款,别把两者搞混。
            if (s.autofractionEnabled && text === '/') {
              if (!autoFraction(view, s.autofractionSymbol, {
                enabled: true,
                excludedEnvs: parseExcludedEnvs(s.autofractionExcludedEnvs),
                breakingChars: s.autofractionBreakingChars,
              })) return false
              // 上游在自动分式展开成功后**也会再放大一次**:`(\sum x)/` 的分子里有 \sum,
              // 包着它的括号该跟着长高。features 层刻意不在 autoFraction 内部串这一步
              // (那会绕过 autoEnlargeBrackets 这个设置开关),由接线层接。
              if (s.autoEnlargeBrackets) enlarge(view)
              return true
            }
            // 括号「打穿」:光标右边已经有一个 `)`,再打一次不该多出一个,而是跳过去。
            // ⚠️必须排在自动分式**之后**:`/` 不是右括号,两者互不相干;但排在片段之后是必要的,
            // 用户的片段完全可能以 `)` 收尾。
            if (s.taboutEnabled && taboutByCloseBracket(view, text, taboutOpts(s))) return true
            return false
          },
          handleKeyDown: (view: EditorView, event: KeyboardEvent): boolean => {
            if (view.composing) return false
            const s = store.settings()
            if (event.key === 'Escape' && tabstops.hasActive(view.state)) {
              view.dispatch(view.state.tr.setMeta(tabstops.key, { clear: true }))
              return true
            }
            if (event.key === 'Tab' && !event.shiftKey) {
              // **顺序即优先级,与上游 latex_suite.ts 的 keybindings 装配次序逐条对齐,别调换**:
              //   手动片段展开 → 占位点跳位 → 矩阵分列 → 跳出括号 → 放行。
              // 两处曾经想当然写反过:
              //   ① 展开必须在跳位**前面** —— 人在占位点里打完一个手动触发串再按 Tab,要的是展开,
              //      不是跳走(上游把 snippet_triggers 推在 nextTabstop 之前,就是这个道理)。
              //   ② 矩阵必须在 tabout **前面** —— `}` 在 tabout 的右定界符名单里,不然
              //      `\begin{…}` 环境里的每一次 Tab 都被 tabout 劫走,矩阵永远加不了单元格。
              // 四条全不接就 return false,把 Tab 原样还给宿主(列表缩进等内置行为)。
              if (s.snippetsEnabled && s.snippetsTrigger === 'Tab' && engine.expandManual(view)) return true
              if (tabstops.cycle(view, 1)) return true
              if (s.matrixShortcutsEnabled && matrixShortcut(view, 'Tab', splitList(s.matrixShortcutsEnvNames), matrixOpts(s))) return true
              if (s.taboutEnabled && tabout(view, taboutOpts(s))) return true
              return false
            }
            if (event.key === 'Tab' && event.shiftKey) {
              return tabstops.cycle(view, -1)
            }
            if (event.key === 'Enter') {
              if (s.matrixShortcutsEnabled && matrixShortcut(view, 'Enter', splitList(s.matrixShortcutsEnvNames), matrixOpts(s))) return true
              return false
            }
            if (event.key === ' ' && s.snippetsEnabled && s.snippetsTrigger === 'Space') {
              return engine.expandManual(view)
            }
            return false
          },
        },
      })

      // 命令面板里的命令拿不到 EditorView(它不在编辑器上下文里跑)。ProseMirror 也没有
      // 「从 DOM 反查 view」的公开接口 —— 所以让扩展自己记账:哪个编辑器最后被聚焦过。
      // ⚠️编辑器销毁时必须销号,否则命令会作用在一个已经死掉的 view 上(Amadeus 里
      // 一篇 v3 笔记有几十个编辑器实例,切页销毁是常态)。
      const track = new pm.Plugin({
        key: new pm.PluginKey('LATEX_SUITE_TRACK'),
        view: (v: EditorView) => {
          const onFocus = (): void => { lastView = v }
          if (v.hasFocus()) lastView = v
          v.dom.addEventListener('focus', onFocus, true)
          return {
            destroy: () => {
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
      enabled: () => store.settings().concealEnabled,
      revealOnCursor: () => true,
    }),
    ...bracketPlugins(pm, {
      highlight: () => store.settings().highlightBracketsEnabled,
      colorize: () => store.settings().colorPairedBracketsEnabled,
    }),
    ...mathPreviewPlugins(pm, {
      enabled: () => store.settings().mathPreviewEnabled,
    }),
  ])

  // ── 设置面板:宿主给一个裸容器,面板自己画(含片段库的 CodeMirror 编辑器)。
  ctx.registerSettingsView?.({
    id: 'main',
    title: t('LaTeX Suite 设置', 'LaTeX Suite settings'),
    mount: (el) =>
      mountSettings(el, {
        get: () => store.settings(),
        set: (patch) => store.update(patch),
        locale: () => ctx.getLocale?.() ?? 'zh',
        snippetErrors: () => store.errors(),
        resetSnippets: () => store.resetSnippets(),
        // 面板的挂载 deps 是 [pluginId, def],语言变了宿主不会重挂 —— 面板自己订阅重绘。
        subscribeLocale: (cb: () => void) => ctx.subscribeLocale?.(() => cb()) ?? (() => {}),
      }),
  })

  // ── 命令面板:公式相关的几个操作。view 由上面的 track 插件记账(见那儿的说明)。
  const activeView = (): EditorView | null => (lastView?.dom.isConnected ? lastView : null)
  for (const cmd of EDITOR_COMMANDS) {
    ctx.registerCommand({
      id: `latex-${cmd.id}`,
      title: t(cmd.titleZh, cmd.titleEn),
      keywords: `latex math 公式 ${cmd.id}`,
      run: () => {
        const view = activeView()
        if (!view) {
          ctx.app.notify(t('请先把光标放进一篇笔记', 'Put the cursor in a note first'))
          return
        }
        if (!cmd.run(view)) ctx.app.notify(t('光标不在公式里', 'Cursor is not inside an equation'))
      },
    })
  }

  return () => {
    store.dispose()
    removeStyle()
  }
}
