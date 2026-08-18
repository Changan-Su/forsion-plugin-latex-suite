// 光标处公式的悬浮预览(上游 editor_extensions/math_tooltip.ts 的对位)。
//
// 为什么在 Amadeus 里格外有用:宿主的实况预览是「光标**离开**这一行才渲染」——正在编辑的那一段
// 看到的永远是裸源码。这个气泡补的正是那个空档:一边改一边在上方看渲染结果。
//
// KaTeX 打进包里(插件拿不到宿主的模块图)。**但 CSS 与字体不打包** —— 宿主自己就 import 了
// katex.min.css,字体已经在页面里;再塞一份只会多几百 KB 并可能和宿主的版本打架。
// 代价:宿主哪天不用 KaTeX 了,这里的气泡会掉样式(不会报错)。这是刻意的取舍。

import katex from 'katex'
import type { EditorState, Plugin } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { PmToolkit } from '../../types/forsion'
import { blockTextAt } from './text'
import { mathSpanAt, scanMath } from './mathMode'

export interface PreviewOptions {
  enabled: () => boolean
}

interface Shown {
  latex: string
  display: boolean
}

/** 取光标所在公式的正文;不在公式里 → null。 */
function latexAtCursor(state: EditorState): Shown | null {
  const bt = blockTextAt(state)
  if (!bt) return null
  const span = mathSpanAt(scanMath(bt.text), bt.from)
  if (!span) return null
  const latex = bt.text.slice(span.innerFrom, span.innerTo).trim()
  return latex ? { latex, display: span.display } : null
}

export function mathPreviewPlugins(pm: PmToolkit, opts: PreviewOptions): Plugin[] {
  return [
    new pm.Plugin({
      key: new pm.PluginKey('LATEX_SUITE_PREVIEW'),
      view: (view: EditorView) => {
        const el = document.createElement('div')
        el.className = 'ls-math-preview'
        el.setAttribute('aria-hidden', 'true') // 纯视觉辅助,不进无障碍树
        let last = ''

        const hide = (): void => {
          if (el.isConnected) el.remove()
          last = ''
        }

        const render = (): void => {
          if (!opts.enabled() || !view.hasFocus()) return hide()
          const hit = latexAtCursor(view.state)
          if (!hit) return hide()

          if (hit.latex !== last) {
            last = hit.latex
            try {
              el.innerHTML = katex.renderToString(hit.latex, {
                displayMode: hit.display,
                throwOnError: false, // 边打边渲染,半截公式是常态 —— 报错块比抛异常友好
                output: 'html',
              })
            } catch {
              // renderToString 在极端输入下仍可能抛(throwOnError 只管解析错误)
              return hide()
            }
          }
          if (!el.isConnected) document.body.appendChild(el)

          // 贴着光标上方;顶不下就翻到下方。用视口坐标(元素是 position: fixed)。
          const coords = view.coordsAtPos(view.state.selection.from)
          const box = el.getBoundingClientRect()
          const above = coords.top - box.height - 8
          el.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - box.width - 8))}px`
          el.style.top = `${above < 8 ? coords.bottom + 8 : above}px`
        }

        // ⚠️失焦必须自己挂 DOM 监听:插件的 update() 只在**状态变化**时跑,而失焦不产生事务 ——
        // 光靠 update 里的 hasFocus() 判断,切走之后气泡会一直浮在屏幕上。
        const onBlur = (): void => hide()
        const onFocus = (): void => render()
        view.dom.addEventListener('blur', onBlur)
        view.dom.addEventListener('focus', onFocus)
        // 滚动时坐标全变;不跟就会飘在错误的位置(捕获期收,编辑器可能装在内层滚动容器里)。
        const onScroll = (): void => { if (el.isConnected) render() }
        window.addEventListener('scroll', onScroll, true)

        render()
        return {
          update: () => render(),
          destroy: () => {
            view.dom.removeEventListener('blur', onBlur)
            view.dom.removeEventListener('focus', onFocus)
            window.removeEventListener('scroll', onScroll, true)
            hide()
          },
        }
      },
    }),
  ]
}
