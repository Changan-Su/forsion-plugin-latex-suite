// 片段库编辑器 = 一个内嵌的 CodeMirror 6。
//
// 为什么设置面板里反而出现了 CM6:上游 latex-suite 的**编辑器**长在 CM6 上,本移植把那部分整个重写成了
// ProseMirror;但设置页里这个「编辑一份 JS 数组」的框子,上游用的也是 CM6,而这一份没有任何理由重写 ——
// 它和宿主文档编辑器井水不犯河水(宿主是 ProseMirror,这里是一个纯粹的代码框),整包内联进 main.js。
//
// ⚠️生命周期:CM6 会往 document 里挂样式、往容器挂事件与 ResizeObserver。用户在设置页里来回切标签、
// 反复进出插件详情,mount/dispose 会跑很多次 —— `destroy()` 漏一次就是一份泄漏的 EditorView。
// 所以这里只暴露一个 handle,销毁路径唯一。

import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting, indentOnInput, indentUnit, bracketMatching } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { tags as t } from '@lezer/highlight'
import { evalSnippetSource } from '../snippets/parse'

/** 停手多久后才校验并保存。太短会在用户还没写完一条时反复报「语法有误」。 */
const COMMIT_DELAY = 300

// 高亮色**只写变量名**,真值在 css.ts 里按明暗两套给 —— style-mod 会把 var(…) 原样落进 CSS,
// 于是同一份 HighlightStyle 在两种皮肤下自动换色,不用建两份。
const SYNTAX = HighlightStyle.define([
  { tag: t.comment, color: 'var(--ls-syn-comment)', fontStyle: 'italic' },
  { tag: [t.string, t.special(t.string)], color: 'var(--ls-syn-string)' },
  { tag: t.regexp, color: 'var(--ls-syn-regexp)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--ls-syn-number)' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.self], color: 'var(--ls-syn-keyword)' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--ls-syn-property)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--ls-syn-function)' },
  { tag: t.invalid, color: 'var(--ls-danger)' },
])

export interface SnippetsEditorOptions {
  value: string
  /** 宿主是不是深色皮肤 —— 只用来告诉 CM6 它的基础主题该走哪一档(选区/光标层)。 */
  dark: boolean
  /** 用户一动就回调(同步)。用来把「已保存」置灰,表示还没落盘。 */
  onTyping(): void
  /** 停手 300ms 后回调。valid=false 时 text 仍是当前正文,但**不该保存**(上游同款:坏语法不落盘)。 */
  onSettle(text: string, valid: boolean): void
}

export interface SnippetsEditorHandle {
  dom: HTMLElement
  /** 外部改写正文(恢复默认 / 清空)。不会触发 onSettle —— 调用方自己已经写过设置了。 */
  setValue(text: string): void
  /** 立刻结算待落盘的改动。dispose 前必须调,否则最后 300ms 内的输入丢掉。 */
  flush(): void
  /** 容器从 display:none 变回可见时叫一下,让 CM 重新量尺寸(隐藏时量到的是 0)。 */
  measure(): void
  /** 明暗改判时叫一下。构造时容器可能还没进文档,那一刻量到的明暗是猜的(见 index.ts 的 rAF 复核)。 */
  setDark(dark: boolean): void
  /** 用户此刻是不是正在框里打字 —— 外部回灌(热重载、恢复默认)必须让路,不能抢走光标。 */
  hasFocus(): boolean
  destroy(): void
}

export function createSnippetsEditor(opts: SnippetsEditorOptions): SnippetsEditorHandle {
  const dom = document.createElement('div')
  dom.className = 'ls-cm'

  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  // setValue 自己 dispatch 时,更新监听器照样会跑 —— 用这个标志把它挡掉,免得把刚写进去的
  // 默认库当成「用户输入」再保存一遍(dispatch 是同步的,布尔量足够)。
  let applying = false

  /** @param force 只有拆卸时的 flush 传 true —— 那一刻不能再往后推,否则最后一段输入直接丢。 */
  const settle = (force: boolean): void => {
    timer = null
    if (!dirty) return
    // 输入法组合中:文档里是半截的拼音/假名,拿去 `new Function` 求值必然报语法错,状态条会
    // 一路闪红,组合确认后才恢复。所以往后推一拍,等组合结束再结算。
    // ⚠️不能改成「组合中直接放弃这一轮」:dirty 还留着,但没人再排下一次结算,改动就压在那儿了。
    if (!force && view.composing) {
      timer = setTimeout(() => settle(false), COMMIT_DELAY)
      return
    }
    dirty = false
    const text = view.state.doc.toString()
    // 只做语法级判定(能不能被求值成一个数组)。语义错误(某条片段选项写错)由宿主解析后
    // 经 api.snippetErrors() 显示 —— 那份才知道文件来源、变量表等这里看不见的上下文。
    opts.onSettle(text, !evalSnippetSource(text).error)
  }

  // 明暗要能在运行时换(构造时容器可能还没进文档,那一刻的判断是猜的),所以装在 compartment 里。
  const darkTheme = new Compartment()

  const view = new EditorView({
    parent: dom,
    state: EditorState.create({
      doc: opts.value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        indentOnInput(),
        indentUnit.of('  '),
        bracketMatching(),
        syntaxHighlighting(SYNTAX),
        javascript(),
        EditorView.lineWrapping,
        // indentWithTab 放在最后:Tab 在 CM 里默认是「移交焦点」(无障碍),这里是代码框,缩进优先。
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        darkTheme.of(EditorView.theme({}, { dark: opts.dark })),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || applying) return
          dirty = true
          opts.onTyping()
          if (timer) clearTimeout(timer)
          // 包一层箭头函数:直接传 settle 的话,某些运行时会把参数塞进第一个形参(force)。
          timer = setTimeout(() => settle(false), COMMIT_DELAY)
        }),
      ],
    }),
  })

  return {
    dom,
    setValue(text) {
      applying = true
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      } finally {
        applying = false
      }
      // 外部写入即「已结算」:待办清掉,免得 300ms 后又把同一份文本回灌一次。
      dirty = false
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
    flush() {
      if (timer) clearTimeout(timer)
      // force:拆卸路径上调的,组合中也必须当场结算 —— 再排一次定时器等于把 view 销毁后才回调。
      settle(true)
    },
    measure() {
      view.requestMeasure()
    },
    setDark(dark) {
      // 只带 effects 的事务:docChanged 为假,上面的 updateListener 直接返回,不会被当成用户输入。
      view.dispatch({ effects: darkTheme.reconfigure(EditorView.theme({}, { dark })) })
    },
    hasFocus() {
      return view.hasFocus
    },
    destroy() {
      if (timer) clearTimeout(timer)
      timer = null
      view.destroy()
    },
  }
}
