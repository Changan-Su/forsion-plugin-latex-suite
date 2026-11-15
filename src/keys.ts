// 按键接线:打字(handleTextInput)与按键(handleKeyDown)各自交给哪个特性、按什么顺序。
//
// 从 main.ts 拆出来只为一件事:单测要跑的是**和真编辑器同一条** Tab 链(手动片段 → 占位跳转 →
// 矩阵 → 跳出公式 → 放行),而不是在测试里再抄一份顺序。顺序本身的理由见 handleKeyDown 里的注释。

import type { EditorView } from 'prosemirror-view'
import type { Engine } from './editor/expand'
import type { TabstopApi } from './editor/tabstops'
import type { LatexSuiteSettings } from './settingsUi/model'
import { splitList } from './settingsUi/model'
import { autoFraction, matrixShortcut, exitMatrix, tabout, taboutByCloseBracket } from './features'

export interface KeyDeps {
  settings(): LatexSuiteSettings
  /** 设置还没读完 = 什么都不接(读完之前的默认值不一定是用户的)。 */
  ready(): boolean
  /** 命令面板里「暂停自动展开」。 */
  paused(): boolean
  engine: Engine
  tabstops: TabstopApi
  enlarge(view: EditorView): void
}

/** `autofractionExcludedEnvs` 存的是一段 JSON(`[["^{","}"], …]`)—— 上游格式。
 *  解析失败一律给空表:一个写坏的设置不该让自动分式整个不能用。 */
export function parseExcludedEnvs(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    // 兼容两种写法:["^{", "\\pu{"] 与 [["^{","}"], …](只取左定界符)
    return v.map((x) => (Array.isArray(x) ? String(x[0] ?? '') : String(x ?? ''))).filter(Boolean)
  } catch {
    return []
  }
}

/** 键盘事件里这里用得到的那几个字段(单测不必造真 KeyboardEvent)。 */
export type KeyLike = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>

export function createKeyHandlers(deps: KeyDeps): {
  handleTextInput(view: EditorView, from: number, to: number, text: string): boolean
  handleKeyDown(view: EditorView, event: KeyLike): boolean
} {
  const { engine, tabstops } = deps
  // 设置 → 各特性入参的**唯一**换算点。散着写就会出现「同一次 Tab 用了两套右定界符名单」
  // 这类对不上的账(自审实测到过)。
  const taboutOpts = (s: LatexSuiteSettings) => ({
    closingSymbols: splitList(s.taboutClosingSymbols),
    exitOnlyOnEOL: s.taboutExitEquationOnlyOnEOL,
  })
  const matrixOpts = (s: LatexSuiteSettings) => ({
    macros: splitList(s.matrixShortcutsMacroNames),
    // 与 tabout 同一份名单:矩阵快捷键内部会先「跳出括号」,那一步用的就是右定界符表。
    closingSymbols: splitList(s.taboutClosingSymbols),
  })

  return {
    handleTextInput: (view, from, to, text) => {
      if (view.composing || !view.editable || !deps.ready()) return false
      const s = deps.settings()
      const paused = deps.paused()
      if (!paused && s.snippetsEnabled && engine.onTextInput(view, from, to, text)) return true
      // 自动分式的触发键固定是 `/`;设置里的 autofractionSymbol 是**替换出来的命令**
      // (`\frac` / `\dfrac` / `\tfrac`),不是触发键 —— 上游同款,别把两者搞混。
      if (!paused && s.autofractionEnabled && text === '/') {
        const literal = view.state.applyTransaction(view.state.tr.insertText(text, from, to)).state
        if (!autoFraction(view, s.autofractionSymbol, {
          enabled: true,
          excludedEnvs: parseExcludedEnvs(s.autofractionExcludedEnvs),
          breakingChars: s.autofractionBreakingChars,
          tabstops: tabstops.push,
        })) return false
        // 上游在自动分式展开成功后**也会再放大一次**:`(\sum x)/` 的分子里有 \sum,
        // 包着它的括号该跟着长高。features 层刻意不在 autoFraction 内部串这一步
        // (那会绕过 autoEnlargeBrackets 这个设置开关),由接线层接。
        if (s.autoEnlargeBrackets) deps.enlarge(view)
        engine.rememberExpansion(view, literal)
        return true
      }
      // 括号「打穿」:光标右边已经有一个 `)`,再打一次不该多出一个,而是跳过去。
      // ⚠️必须排在自动分式**之后**:`/` 不是右括号,两者互不相干;但排在片段之后是必要的,
      // 用户的片段完全可能以 `)` 收尾。
      if (!paused && s.taboutEnabled && taboutByCloseBracket(view, text, taboutOpts(s))) return true
      return false
    },
    handleKeyDown: (view, event) => {
      if (view.composing || !view.editable || !deps.ready()) return false
      const s = deps.settings()
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false
      if (event.key === 'Backspace' && !event.shiftKey && engine.undoExpansion(view)) return true
      // 清表后还在联动的那一组(mirror)也算:Esc 是停掉联动的唯一按键。
      if (event.key === 'Escape' && (tabstops.hasActive(view.state) || tabstops.snapshot(view.state).mirror)) {
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
        // 上游:第一格再往前没有格了 → 不接,交还编辑器(占位表原样留着)。
        return tabstops.cycle(view, -1)
      }
      if (event.key === 'Enter' && event.shiftKey) return s.matrixShortcutsEnabled && exitMatrix(view, splitList(s.matrixShortcutsEnvNames))
      if (event.key === 'Enter') {
        if (s.matrixShortcutsEnabled && matrixShortcut(view, 'Enter', splitList(s.matrixShortcutsEnvNames), matrixOpts(s))) return true
        return false
      }
      if (event.key === ' ' && s.snippetsEnabled && s.snippetsTrigger === 'Space') {
        return engine.expandManual(view)
      }
      return false
    },
  }
}
