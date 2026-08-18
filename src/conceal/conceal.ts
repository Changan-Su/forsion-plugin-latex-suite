// 实时符号隐藏(conceal):光标不在这一段公式里时,把 `\alpha` 显示成 α、`\frac{a}{b}` 显示成 (a)/(b)、
// `\mathbb{R}` 显示成 ℝ;光标一进那一段就整段露出源码可编辑。上游 latex-suite 最有辨识度的功能。
//
// ── 与上游的三处结构性差异,都是被宿主的现实逼出来的 ────────────────────────────────────
//
// 1) **没有 replace 装饰**。CodeMirror 的 `Decoration.replace` 一步就是「拿 widget 顶掉这一段」;
//    ProseMirror 没有对应物,只能两枚拼:`Decoration.inline` 给源码挂上 display:none 的类,
//    再在同一位置放一枚 `Decoration.widget` 显示替换后的字符。
//
// 2) **必须让着宿主的公式实况预览**(blocks/markdown/mathLivePreview.ts)。宿主的规矩是:
//    编辑器失焦、或公式不在光标那一行 → 把 `$…$` 源码整段 `.math-src-hidden { display:none }`,
//    就地渲染 KaTeX。⚠️关键事实:inline 装饰只包裹**文本**,widget 是它的**兄弟节点**——
//    宿主的 display:none 压根盖不住我们的 widget。所以只要在宿主渲染 KaTeX 的地方也画 conceal,
//    用户就会同时看见 KaTeX 和一排 α —— 必须精确地只在「宿主正在露源码」的那些公式上工作。
//    换个角度看,这也正是 conceal 该在的地方:宿主已经把离行的公式渲染掉了,conceal 负责的
//    是**你正在编辑的这一段**,让同段里没被光标碰到的公式先漂亮起来。
//    ⚠️已知视觉冗余:宿主在光标那一行会给**该行每一段**公式挂一枚浮层 KaTeX 预览(不只光标所在那段)。
//    于是同一行里没被光标碰到的公式会同时有「conceal 出来的 α」和「浮在上方的 KaTeX 气泡」。
//    这是两个功能各自正确的叠加,不是 bug —— 要消掉就得让 conceal 在活动行整个罢工,那等于砍掉本功能。
//
// 3) **reveal 的粒度是「整段公式」而不是上游的「单个构造」**。上游光标压在 `\alpha` 上才露它,
//    旁边的 `\beta` 继续是 β;这里光标一进 `$…$` 就整段回源码。好处是光标永远不会停在
//    display:none 的字符旁边(ProseMirror 没有 CM 的 atomicRanges,那种停靠会让插入符凭空消失),
//    代价是编辑当前这段公式时看不到 conceal。要换成上游粒度的话,把「跨度级 reveal」改成
//    「替换项级 reveal」即可,但必须同时补上「光标贴到边界就露」的规则,否则方向键会走进隐形字符。
//
// ⚠️revealOnCursor = false(一律 conceal)时,光标可以停在 display:none 的源码里 —— 插入符看不见。
// 这是该设置的字面含义,不是 bug;默认值应当是 true(main.ts 里就写死了 true)。
//
// ── 上游有、这里**故意不做**的两件事 ─────────────────────────────────────────────
// 都是上游为「按构造 reveal」这个粒度打的补丁,换成整段 reveal 之后它们要解决的问题也跟着换了形状:
//   - `mousedown → 全部 conceal`(拖选公式时不抖):整段粒度下拖选进一段公式只抖一次,而做对它
//     需要在 window 上挂 mouseup —— 鼠标在编辑器外松开就会漏事件,conceal 卡在「永远藏着」=
//     reveal 再也不触发 = 公式没法编辑。为治小痒引入的这个卡死风险不划算,且宿主自己的实况预览
//     也没有 mousedown 这套说法,跟宿主一致比跟 Obsidian 一致重要。
//   - `revealTimeout`(光标停在构造**边界**时延迟 reveal):整段粒度下压根没有「边界」这个中间态
//     —— 光标要么在这段公式里(露),要么不在(藏),没有第三种。

import type { EditorState, Plugin } from 'prosemirror-state'
import type { Decoration, DecorationSet, EditorView } from 'prosemirror-view'
import type { Node as PmNode } from 'prosemirror-model'
import type { PmToolkit } from '../../types/forsion'
import { blockString, isCodeBlock } from '../editor/text'
import { scanConceal, type ConcealSpan } from './scan'

/** 藏源码的类(CSS display:none)。 */
const HIDDEN = 'latex-suite-concealed'
/** widget 外壳的类。 */
const WIDGET = 'latex-suite-conceal'

/** ⚠️与宿主 mathLivePreview 的耦合点。它的 PluginKey 名字是这个;PluginKey 构造时**恒**追加
 *  `$`(重名再追加序号:`name$`、`name$2`),所以匹配 `名字 + '$'` 前缀 —— 比裸前缀精确一格,
 *  免得哪天宿主多出一个 `amadeus-math-live-preview-xxx` 插件被误认(误认的后果见 hostMathFocus:
 *  读不到 focus 就按「宿主在渲染」办,conceal 会整个哑掉)。
 *  找不到 = 宿主没有这套实况预览(老版本 / 别的编辑器),那源码就始终在屏上,conceal 照常全量工作。 */
const HOST_MATH_KEY = 'amadeus-math-live-preview$'

/** 宿主 buildBlockString 里的硬换行节点名。 */
const BREAK_NAMES = new Set(['hardbreak', 'hard_break', 'break'])

interface BlockScan {
  /** 块文本偏移 → 文档位置的基址。 */
  base: number
  text: string
  /** node.content.size,判「选区落没落在本块」用(与宿主同一条判据)。 */
  size: number
  spans: ConcealSpan[]
}

interface ConcealState {
  /** 设置里关掉时为 false,blocks 恒空 —— 记在 state 里,重新打开时才知道要重扫。 */
  on: boolean
  blocks: BlockScan[]
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/**
 * 取一个 textblock 的文本,并且**逐字对齐宿主的 buildBlockString**。
 *
 * text.ts 的 blockString 是给片段引擎用的:硬换行 → '￼'、行内代码原样保留。宿主那边是
 * 硬换行 → '\n'、code 标记的文本 → 等长空格。两处差一个字符,就会在两个地方翻车:
 *   - 「哪里是公式」:scanMath 靠 '\n' 判定行内公式不跨行,靠内容判定 `$` 成不成对;
 *   - 「光标在哪一行」:宿主按 '\n' 切行来决定露不露源码,我们不切行就会把别的行也 conceal
 *     —— 而那些行宿主已经渲染成 KaTeX 了,于是双重显示。
 * 两处修正都是**等长覆写**,偏移量与 blockString 严格一致(位置对不上比不做还糟)。
 * ⚠️一处**刻意**的不逐字:硬换行宿主写死一个 '\n',这里写 nodeSize 个。硬换行是叶子(size=1),
 * 两者恒等;真出现 size>1 的换行节点,是宿主自己的 offset↔文档位 1:1 先破了 —— 那时跟着它一起错
 * 并不会更对,保住 1:1 才有的救。
 *
 * 导出只为单测:这是与宿主的一条契约,值得被钉住。
 */
export function hostBlockString(node: PmNode): string {
  let out = blockString(node)
  let off = 0
  node.forEach((child) => {
    const len = child.isText ? (child.text ?? '').length : child.nodeSize
    if (child.isText) {
      if (child.marks.some((m) => m.type.name === 'code' || m.type.name === 'inlineCode')) {
        out = out.slice(0, off) + ' '.repeat(len) + out.slice(off + len)
      }
    } else if (BREAK_NAMES.has(child.type.name)) {
      out = out.slice(0, off) + '\n'.repeat(len) + out.slice(off + len)
    }
    off += len
  })
  return out
}

/** 全量扫描。Amadeus 一个块 = 一个独立的小 Milkdown 编辑器(见宿主 editorExtensions.ts:工厂
 *  每个编辑器实例调一次),所以「整篇文档」在这里通常就是一两个 textblock —— 不做视口裁剪。
 *  真要塞进一个几千行的巨型块才需要担心,那种块在 Amadeus 里本来就不该存在。 */
function scanDoc(doc: PmNode): BlockScan[] {
  const out: BlockScan[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (isCodeBlock(node)) return false // 代码块里 `$x$` 是字面量
    const text = hostBlockString(node)
    if (text.indexOf('$') === -1) return false
    const spans = scanConceal(text)
    if (spans.length) out.push({ base: pos + 1, text, size: node.content.size, spans })
    return false // 不深入内联
  })
  return out
}

/** 宿主实况预览的聚焦态:true/false = 宿主在场且(不)聚焦;null = 宿主不在场。
 *  刻意不用 view.hasFocus():那是第二个真相源,与宿主的 plugin state 可能瞬时不一致
 *  (它是靠 focus/blur 事件各自 dispatch 事务维护的),而双方一旦不一致就是一帧的双重显示。
 *  props.decorations 被调用时全部插件的 state 都已 apply 完,读到的必然是宿主本轮用的那个值。 */
function hostMathFocus(state: EditorState, cache: { key?: string }): boolean | null {
  const read = (k: string): boolean | undefined => {
    const st = (state as unknown as Record<string, unknown>)[k] as { focus?: boolean } | undefined
    return st ? st.focus === true : undefined
  }
  // 只做**正向**缓存:找到过就记住(省掉每次遍历插件表),没找到则每次重找 ——
  // 编辑器被重配(prosePluginsCtx 变了)时宿主插件可能后到,把「不在场」缓存住就再也纠不回来了。
  if (cache.key !== undefined) {
    const v = read(cache.key)
    if (v !== undefined) return v
    cache.key = undefined // 记着的那枚已经不在这份 state 里了,重找
  }
  for (const p of state.plugins) {
    const k = (p as unknown as { key?: unknown }).key
    if (typeof k === 'string' && k.startsWith(HOST_MATH_KEY)) {
      cache.key = k
      return read(k) ?? false // 在场但读不到聚焦态 → 按「宿主在渲染」办,宁可不 conceal 也不双重显示
    }
  }
  return null
}

function widgetDom(text: string, cls: string | undefined): HTMLElement {
  const el = document.createElement('span')
  el.className = cls ? `${WIDGET} ${cls}` : WIDGET
  el.textContent = text
  // 不可编辑:否则用户能把光标点进这枚假字符里,打字直接落到装饰上(装饰不是文档,字会丢)。
  el.contentEditable = 'false'
  return el
}

export function concealPlugins(
  pm: PmToolkit,
  opts: { enabled: () => boolean; revealOnCursor: () => boolean },
): Plugin[] {
  const key = new pm.PluginKey<ConcealState>('LATEX_SUITE_CONCEAL')
  const hostKeyCache: { key?: string } = {}

  // 装饰缓存。扫描结果放在 plugin state 里(只在 docChanged 时重算),但**装饰本身**在这里记 ——
  // 它还取决于选区、宿主聚焦态、两个设置项,而后两者在 state.apply 里读不到可靠值
  // (插件 state 的 apply 顺序决定了那时宿主的新 state 可能还没落)。这一层重建只是遍历
  // 已经算好的替换清单,和重新扫描不是一个量级。
  // 闭包 = 每个编辑器一份(宿主的工厂是 per 编辑器实例调用的);万一将来被共用,缓存键里带着
  // doc/选区的**对象身份**,顶多多重建一次,不会串味。
  // ⚠️doc 必须进缓存键:装饰集合是按某一份 doc 建的,拿去配另一份 doc 就是越界位置。
  let memo: {
    doc: PmNode
    blocks: BlockScan[]
    sel: unknown
    focus: boolean | null
    reveal: boolean
    decos: DecorationSet
  } | null = null

  // 只为两件事拿 view:① 输入法合成期冻结装饰;② 编辑器销毁时把缓存放掉。
  let viewRef: EditorView | null = null

  // 扫描器兜底。conceal 是在 **state.apply 里**解析任意用户文本的 —— 那里抛一次异常,
  // 之后**每一个事务**都会在同一处炸,编辑器当场不能用(比少显示一个 α 贵得多)。
  // 所以吞掉异常降级成「本次没有可 conceal 的东西」:自愈(下一个事务照常再试),
  // 只吼第一声,免得问题被彻底埋掉。
  let scanFailed = false
  const safeScan = (doc: PmNode): BlockScan[] => {
    try {
      return scanDoc(doc)
    } catch (e) {
      if (!scanFailed) {
        scanFailed = true
        console.error('[latex-suite] conceal 扫描失败,本次不 conceal', e)
      }
      return []
    }
  }

  const build = (state: EditorState, blocks: BlockScan[], focus: boolean | null, reveal: boolean): DecorationSet => {
    // 编辑器失焦 → 宿主把**所有**公式渲染成 KaTeX,一枚 conceal 都不能画。
    if (focus === false) return pm.DecorationSet.empty
    const decos: Decoration[] = []
    const selFrom = state.selection.from
    const selTo = state.selection.to
    for (const b of blocks) {
      // 宿主只在「光标所在那一行」露源码 —— 这段照抄 mathLivePreview.buildDecorations 的算法,
      // 它变了这里就得跟着变(两边算出不同的行 = 双重显示)。宿主不在场时全块都算露源码。
      let lineFrom = 0
      let lineTo = b.text.length
      if (focus !== null) {
        if (!(selFrom <= b.base + b.size && selTo >= b.base)) continue // 选区不在本块 → 本块整块是 KaTeX
        const a = clamp(selFrom - b.base, 0, b.text.length)
        const z = clamp(selTo - b.base, 0, b.text.length)
        lineFrom = b.text.lastIndexOf('\n', a - 1) + 1
        const nl = b.text.indexOf('\n', z)
        lineTo = nl === -1 ? b.text.length : nl
      }
      for (const sp of b.spans) {
        if (!(sp.from < lineTo && sp.to > lineFrom)) continue // 这段宿主正渲染成 KaTeX
        // 光标(或选区)落在这段公式里 → 整段露源码。边界口径与 mathSpanAt 一致:
        // 定界符内侧算「在里面」,`$|x$` 与 `$x|$` 都算 —— 与片段引擎对「在不在公式里」同一套说法。
        if (reveal && selTo >= b.base + sp.innerFrom && selFrom <= b.base + sp.innerTo) continue
        for (const r of sp.repls) {
          const a = b.base + r.from
          const z = b.base + r.to
          // 倒过来的区间 = 扫描器的契约破了。画出去会错位吞字,整条丢掉比猜意图安全。
          if (z < a) continue
          // ⚠️空区间只画 widget,不画 inline 装饰:PM 的 InlineType.valid 要求 from < to,
          // 零宽 inline 会被 buildTree **静默**丢掉(不报错)。上游 buildDecoSet 对 `start === end`
          // 同样是只放一枚 TextWidget —— `\frac` 中间那个 `/` 就是这么来的。
          // 今天的 scan.ts 产不出空区间(每条替换至少盖一个字符,`/` 已并进 `}` 那一条),
          // 这里是**契约护栏**:将来谁加一条零宽插入,不该表现成「静默少一个符号」。
          if (z > a) decos.push(pm.Decoration.inline(a, z, { class: HIDDEN }))
          if (!r.text) continue // 空替换 = 只藏不显(`\frac` 本身)
          const text = r.text
          const cls = r.cls
          decos.push(
            pm.Decoration.widget(a, () => widgetDom(text, cls), {
              // side -1:画在该位置的内容之前,也就是被藏起来的那段源码的前面。
              side: -1,
              // widget 里的 DOM 选区变化不回灌 ProseMirror(它不是文档内容)。
              ignoreSelection: true,
              // key 决定「要不要重建这枚 widget」。**必须带上替换文本**,否则改了公式内容
              // widget 会被当成同一枚原地留着(显示旧字符)。位置**不能**进 key:
              // 那样在块前面打一个字就会让后面所有 widget 全部重建。
              key: `ls|${text}|${cls ?? ''}`,
            }),
          )
        }
      }
    }
    return decos.length ? pm.DecorationSet.create(state.doc, decos) : pm.DecorationSet.empty
  }

  const plugin = new pm.Plugin<ConcealState>({
    key,
    state: {
      init: (_config, instance) =>
        opts.enabled() ? { on: true, blocks: safeScan(instance.doc) } : { on: false, blocks: [] },
      apply: (tr, prev) => {
        // 设置项现读现判:关掉后不再扫,重新打开时(on 从 false 变 true)立刻补一次全扫
        // (`prev.on` 为 false 时下面那个 early return 不成立,自然会走到重扫)。
        // ⚠️开关翻转要等**下一个事务**才让 blocks 跟上;「关」这一侧另有 decorations 里的即时闸,
        //   「开」这一侧确实得等 —— 实际用起来看不出来:用户从设置面板点回编辑器时,
        //   宿主实况预览的 focus 事件会 dispatch 一个事务(见 mathLivePreview 的 handleDOMEvents)。
        //   集成方想要确定性的话,在设置变更后自己 dispatch 一个空事务即可。
        if (!opts.enabled()) return prev.on ? { on: false, blocks: [] } : prev
        if (prev.on && !tr.docChanged) return prev
        return { on: true, blocks: safeScan(tr.doc) }
      },
    },
    // ⚠️若宿主把工厂的产物在多个编辑器间共用,这里是「最后挂上来的赢」——
    // 与 memo 同样的取舍:退化成多重建几次,不会串味(memo 的缓存键里带着 doc/选区的对象身份)。
    view: (v: EditorView) => {
      viewRef = v
      return {
        destroy: () => {
          if (viewRef === v) viewRef = null
          // 装饰集合会连着整份 doc 一起被拽住;编辑器都没了还留着没有道理
          // (Amadeus 一篇 v3 笔记几十个编辑器实例,切页销毁是常态)。
          memo = null
          hostKeyCache.key = undefined
        },
      }
    },
    props: {
      decorations: (state) => {
        // 设置里关掉 → 立刻一枚不画,不必等下一个事务把 blocks 清空。
        if (!opts.enabled()) return null
        const st = key.getState(state)
        if (!st || !st.blocks.length) return null
        const focus = hostMathFocus(state, hostKeyCache)
        const reveal = opts.revealOnCursor()
        if (
          memo &&
          memo.doc === state.doc &&
          memo.blocks === st.blocks &&
          memo.sel === state.selection &&
          memo.focus === focus &&
          memo.reveal === reveal
        ) {
          return memo.decos
        }
        // ⚠️输入法合成期:doc 没变就**原样交回上一份装饰**,不让选区/聚焦态的变化去改「哪些段该藏」。
        // 合成期间改动 textblock 的装饰会逼 PM 重画这一段的子节点,正在合成的那个文本节点虽有
        // localCompositionInfo 保着,兄弟节点的重建仍可能把候选框打断 / 让已上屏的字重复。
        // doc 变了就只能重建 —— 拿旧位置去配新 doc 是越界,比重建更糟;好在 widget 带 key、
        // inline 装饰只有一个 class,PM 会原地复用,重建的 DOM churn 接近于零。
        if (viewRef?.composing && memo && memo.doc === state.doc) return memo.decos
        const decos = build(state, st.blocks, focus, reveal)
        memo = { doc: state.doc, blocks: st.blocks, sel: state.selection, focus, reveal, decos }
        return decos
      },
    },
  })

  // 返回数组而不是单个 Plugin:conceal 以后要补键位(比如方向键跨过隐藏段)时,
  // 直接在这里追加第二枚,调用方不用改。
  return [plugin]
}

/** 注入宿主页面的样式。颜色一律走宿主 token 且带兜底 —— Amadeus 的变量名是 `--text` / `--text-muted`
 *  (不是 Obsidian 的 `--text-normal`),换了皮肤或换了宿主也不会掉成黑底黑字。 */
export const CONCEAL_CSS = `
/* 被藏起来的源码:仍然在文档里(光标一进这段公式就整段露出来),只是不显示。
   ⚠️display:none 只盖得住文本,盖不住 widget —— 这也是宿主 .math-src-hidden 盖不住我们的原因。 */
.${HIDDEN} { display: none; }

/* 替换后的字符。white-space:pre-wrap 是为了 \\text{a b} 这类替换文本里的空格不被折叠。 */
.${WIDGET} {
  color: var(--text, currentColor);
  white-space: pre-wrap;
  cursor: text;
}
.${WIDGET}.latex-suite-conceal-bracket { color: var(--text-muted, currentColor); }
.${WIDGET}.latex-suite-conceal-mathrm { font-style: normal; font-family: inherit; }
.${WIDGET}.latex-suite-conceal-bold { font-weight: 700; }
.${WIDGET}.latex-suite-conceal-underline { text-decoration: underline; }
/* 重音(x̄ / ẋ)和上下标(x²)默认不改样式,类名只作用户 CSS 的挂钩:
   .latex-suite-conceal-unicode / .latex-suite-conceal-script */
`
