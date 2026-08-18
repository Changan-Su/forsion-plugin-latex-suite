// 公式源码 → 「哪一段该显示成什么」的替换清单。纯字符串进、纯数据出,不碰 ProseMirror ——
// 装饰怎么画是 conceal.ts 的事,这一层能单测(test/conceal.test.ts)。
//
// ⚠️与上游最大的一处**刻意**分歧:不移植 lezer LaTeX 语法树。
// 上游 conceal_fns.ts 站在 src/parser/mathjax 那份完整文法之上,拿到的是节点树。移植过来意味着
// 把词法 + 文法 + tokenizer 整套塞进「宿主 new Function 求值的单文件产物」,更要命的是会引入
// **第二套**「哪里是公式」的真相 —— 宿主 mathLivePreview 与 mathMode.ts 已经用扫描器把那条边界
// 定死了,再来一套语法树只会让两边打架(片段以为在公式里、渲染却不认,反之亦然)。
// 所以:公式跨度一律由 scanMath 给(唯一真相),跨度**内部**用这个手写扫描器认构造。
//
// 代价写在明处:
//   - 嵌套只做一层半 —— `\frac{\alpha}{2}` 的内层照样 conceal(扫描器会走进花括号),
//     但 `x^{\frac12}` 这种「上下标里套构造」直接放弃(上游能递归拼结果,这里按「映射不全就原样」办);
//   - 认不出的构造**原样放行**,绝不吞字:语法错误的公式不会因为 conceal 而消失。

import { scanMath } from '../editor/mathMode'
import {
  bar,
  brackets,
  cmd_symbols,
  dot,
  fractions,
  greek,
  hat,
  leftrightBrackets,
  map_sub,
  map_super,
  mathbb,
  mathfrak,
  mathscrcal,
  not_remap,
  operators,
} from './maps'

/** maps.ts 里几张表是对象字面量推断出的精确类型;不统一成「可能查不到」的话,
 *  `t[ch] === undefined` 会被 TS 判成不可能的比较,而运行时它**真的**会是 undefined。 */
type Table = Record<string, string | undefined>

/** 装饰用的类名(样式见 conceal.ts 的 CONCEAL_CSS)。上游那套 `cm-*` 是 CodeMirror 的
 *  高亮类,这里没有对应物,自己起一套并暴露给用户 CSS 当挂钩。 */
export const CLS = {
  bracket: 'latex-suite-conceal-bracket',
  mathrm: 'latex-suite-conceal-mathrm',
  bold: 'latex-suite-conceal-bold',
  underline: 'latex-suite-conceal-underline',
  unicode: 'latex-suite-conceal-unicode',
  script: 'latex-suite-conceal-script',
} as const

export interface Replacement {
  /** 块文本坐标(闭开区间)。 */
  from: number
  to: number
  /** 替换后显示的字符;`''` = 只藏不显(如 `\frac` 这三个字本身)。 */
  text: string
  cls?: string
}

export interface ConcealSpan {
  /** 含定界符,与 scanMath 的 from/to 一致 —— 判「宿主是不是正在露这段的源码」要用它。 */
  from: number
  to: number
  /** 正文范围;判「光标是不是在这段公式里」用它(与 mathSpanAt 同口径:定界符内侧算在里面)。 */
  innerFrom: number
  innerTo: number
  /** 按 from 升序,互不重叠。 */
  repls: Replacement[]
}

const SYMBOLS: Table = { ...greek, ...cmd_symbols }
const OPERATORS = new Set(operators)
const FRAC_MACROS = new Set(['frac', 'dfrac', 'tfrac', 'gfrac'])

/** 重音:上游一律用组合字符(base + U+03xx),这里**优先用预组合字符**(ẋ / ā / â)——
 *  maps.ts 带着 bar/dot/hat 三张预组合表(上游老版本的遗产),预组合在多数字体下比组合字符
 *  对得更齐(组合符常常偏出去半格)。表里没有的字母才退回组合字符。 */
// mark 一律写成转义:组合字符在源码里是**不可见**的,写字面量等于埋雷(编辑器一手滑就没了)。
const ACCENTS: Record<string, { mark: string; table?: Table }> = {
  hat: { mark: '\u0302', table: hat as Table },
  dot: { mark: '\u0307', table: dot as Table },
  ddot: { mark: '\u0308' },
  bar: { mark: '\u0304', table: bar as Table },
  overline: { mark: '\u0304', table: bar as Table },
  tilde: { mark: '\u0303' },
  vec: { mark: '\u20D7' },
}

/** 字体宏:有 table 的按字符表映射(映不全就整个放弃),没 table 的原文照搬 + 一个类名。 */
const FONTS: Record<string, { table?: Table; cls?: string }> = {
  mathbb: { table: mathbb },
  mathcal: { table: mathscrcal },
  mathscr: { table: mathscrcal },
  mathfrak: { table: mathfrak as Table },
  mathbf: { cls: CLS.bold },
  boldsymbol: { cls: CLS.bold },
  underline: { cls: CLS.underline },
  mathrm: { cls: CLS.mathrm },
}

/** 花括号里是**文字不是公式**的宏:整组跳过,里面的 `\alpha` 不该变成 α。
 *  名单与 mathMode.ts 的 TEXT_MACROS 同源(那边管片段该不该跑,这边管该不该 conceal)。 */
const TEXT_ARG_MACROS = new Set([
  'text', 'textrm', 'textbf', 'textit', 'textsf', 'texttt', 'mbox', 'textnormal', 'label', 'tag', 'ref', 'begin', 'end',
])
/** 其中这几个「内容够干净就直接显示成正文」(上游 handleText)。textbf/textit 之类要带样式,
 *  没有对应的类就不冒充,老实留源码。 */
const TEXT_SHOWN = new Set(['text', 'textrm', 'textnormal', 'mbox'])
/** 上游 handleText 的白名单字符集:出了这个范围一律不 conceal(避免把标记语言当正文吞掉)。 */
const PLAIN_TEXT = /^[A-Za-z0-9\-.!?() ]+$/

const isLetter = (c: string | undefined): boolean => c !== undefined && /[A-Za-z]/.test(c)

/** 只跳空格/制表,**不跳换行** —— 跨行就不是同一条公式了(scanMath 的口径)。 */
function skipSpaces(s: string, i: number, end: number): number {
  while (i < end && (s[i] === ' ' || s[i] === '\t')) i++
  return i
}

/** 读一条控制序列。`\alpha` → name 'alpha';`\{` `\,` `\\` → name 就是那一个字符
 *  (⚠️`\\` 必须当成**一条**宏读掉,否则 `\\alpha` 会被看成换行后接 `\alpha` 之外的第二种解释)。 */
function readCmd(s: string, i: number, end: number): { name: string; end: number } | null {
  if (s[i] !== '\\' || i + 1 >= end) return null
  let j = i + 1
  if (isLetter(s[j])) {
    while (j < end && isLetter(s[j])) j++
  } else {
    j++
  }
  return { name: s.slice(i + 1, j), end: j }
}

/** `{` 的配对 `}`;`\{` 是字面花括号不参与配对。找不到 → -1。 */
function matchBrace(s: string, open: number, end: number): number {
  let depth = 0
  for (let i = open; i < end; i++) {
    const c = s[i]
    if (c === '\\') { i++; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

/** 从 i 起(允许中间有空格)读一个 `{…}` 参数组。 */
function readGroup(s: string, i: number, end: number): { open: number; close: number } | null {
  const open = skipSpaces(s, i, end)
  if (s[open] !== '{') return null
  const close = matchBrace(s, open, end)
  return close < 0 ? null : { open, close }
}

/** `\sum\limits` / `\lim\limits`:把紧跟的 `\limits` 一起吃掉,否则符号后面挂一串裸字母
 *  (上游 getLimitLength 同款)。 */
function absorbLimits(s: string, i: number, end: number): number {
  const j = skipSpaces(s, i, end)
  const cmd = readCmd(s, j, end)
  return cmd && cmd.name === 'limits' ? cmd.end : i
}

/** `^{…}` / `_{…}` / `^2`:整段都能映成 Unicode 上下标才 conceal,否则原样。
 *  上游新版是渲染成真正的 `<sup>`/`<sub>` 元素(能装任意内容);这里按任务约定走 map_super/map_sub
 *  的 Unicode 路子 —— 好处是替换结果是**一串普通字符**,与其它 conceal 一样能直接塞进 widget,
 *  不必为上下标单开一种元素类型。代价:`x^{\alpha}`、`x^{q}`(map_super 没有 q)这类落空,保持源码。 */
function handleScript(s: string, i: number, end: number): Replacement | null {
  const map = (s[i] === '^' ? map_super : map_sub) as Table
  const j = skipSpaces(s, i + 1, end)
  let content: string
  let stop: number
  if (s[j] === '{') {
    const close = matchBrace(s, j, end)
    if (close < 0) return null
    content = s.slice(j + 1, close)
    stop = close + 1
  } else {
    if (j >= end) return null
    content = s[j]
    stop = j + 1
  }
  if (!content) return null
  const mapped: string[] = []
  for (const ch of content) {
    const m = map[ch]
    if (m === undefined) return null
    mapped.push(m)
  }
  return { from: i, to: stop, text: mapped.join(''), cls: CLS.script }
}

/** 单字符 / 单个希腊字母宏 —— 重音只能加在**一个**字符上。 */
function accentBase(content: string): string | undefined {
  if (/^[A-Za-z]$/.test(content)) return content
  if (content[0] === '\\') return (greek as Table)[content.slice(1)]
  return undefined
}

/**
 * 处理一条控制序列。返回**下一个扫描位置**:
 *   - 整段吃掉的构造(`\mathbb{R}`)返回组尾,里面不再扫;
 *   - `\frac` 只吃掉自己和四个花括号,返回宏名末尾 —— 主循环随后走进分子分母,内层照样 conceal。
 */
function handleMacro(s: string, start: number, name: string, nameEnd: number, end: number, out: Replacement[]): number {
  // ── \not\in → ∉
  // 上游只把 `\not` 本身换成组合后的符号、却把后面的 `\in` 留在屏幕上(`∉in`),看着像 bug;
  // 这里整条 `\not\xxx` 一起换掉。
  if (name === 'not') {
    const next = readCmd(s, nameEnd, end)
    const sym = next ? (not_remap as Table)[next.name] : undefined
    if (next && sym !== undefined) {
      out.push({ from: start, to: next.end, text: sym })
      return next.end
    }
    return nameEnd
  }

  // ── \left( \right] :定界符本身能映射就整条换掉;映不了就**故意落到下面的通用符号表** ——
  // cmd_symbols['left'] = ''(空串),于是只藏掉 `\left` 三个字,裸露的 `(` 原样显示。
  // 这正是上游 `\left(` → `(` 的实现路径,不是巧合。
  if (name === 'left' || name === 'right') {
    const j = skipSpaces(s, nameEnd, end)
    let sym: string | undefined
    let stop = j
    const cmd = s[j] === '\\' ? readCmd(s, j, end) : null
    if (cmd) {
      sym = (leftrightBrackets as Table)['\\' + cmd.name] ?? (brackets as Table)[cmd.name]
      // `\left\{` / `\right\}`:brackets 表里没有,但它俩就是字面花括号。
      if (sym === undefined && (cmd.name === '{' || cmd.name === '}')) sym = cmd.name
      stop = cmd.end
    } else if (j < end) {
      sym = (leftrightBrackets as Table)[s[j]]
      stop = j + 1
    }
    if (sym !== undefined) {
      out.push({ from: start, to: stop, text: sym, cls: CLS.bracket })
      return stop
    }
  }

  // ── \frac{a}{b}
  if (FRAC_MACROS.has(name)) {
    const num = readGroup(s, nameEnd, end)
    if (!num) return nameEnd
    const den = readGroup(s, num.close + 1, end)
    if (!den) return nameEnd
    const preset = (fractions as Table)[s.slice(num.open, den.close + 1)]
    if (preset !== undefined) {
      out.push({ from: start, to: den.close + 1, text: preset })
      return den.close + 1
    }
    // `\frac{a}{b}` → `(a)/(b)`。上游把中间那个 `/` 做成一枚零宽 widget;这里并进上一枚
    // (`}` → `)/`)—— ProseMirror 明确写着「同 side 的多个 widget 之间顺序未定义」,
    // 同一位置放两枚就是在赌渲染顺序。
    out.push({ from: start, to: num.open, text: '' })
    out.push({ from: num.open, to: num.open + 1, text: '(', cls: CLS.bracket })
    out.push({ from: num.close, to: num.close + 1, text: ')/', cls: CLS.bracket })
    out.push({ from: den.open, to: den.open + 1, text: '(', cls: CLS.bracket })
    out.push({ from: den.close, to: den.close + 1, text: ')', cls: CLS.bracket })
    return nameEnd
  }

  // ── \dot{x} \hat{x} \bar{x} …
  const accent = ACCENTS[name]
  if (accent) {
    const g = readGroup(s, nameEnd, end)
    if (!g) return nameEnd
    const base = accentBase(s.slice(g.open + 1, g.close))
    if (base === undefined) return nameEnd // 里面不是单个字符 → 原样,主循环接着扫进去
    out.push({ from: start, to: g.close + 1, text: accent.table?.[base] ?? base + accent.mark, cls: CLS.unicode })
    return g.close + 1
  }

  // ── \mathbb{R} \mathcal{L} \mathfrak{g} \mathbf{v} …
  const font = FONTS[name]
  if (font) {
    const g = readGroup(s, nameEnd, end)
    if (!g) return nameEnd
    let content = s.slice(g.open + 1, g.close)
    if (!content) return g.close + 1
    if (font.table) {
      const mapped: string[] = []
      for (const ch of content) {
        const m = font.table[ch]
        if (m === undefined) return nameEnd // 有一个字映不了就整个放弃(半个 𝔤 比源码更难认)
        mapped.push(m)
      }
      out.push({ from: start, to: g.close + 1, text: mapped.join('') })
      return g.close + 1
    }
    if (!/^[A-Za-z0-9 ]+$/.test(content)) {
      // 上游只给 underline/boldsymbol 开「里面可以是希腊字母宏」这个口子,看不出理由;
      // 这里统一开:`\mathbf{\alpha}` → 加粗的 α,不会错。
      const g2 = accentBase(content)
      if (g2 === undefined) return nameEnd
      content = g2
    }
    out.push({ from: start, to: g.close + 1, text: content, cls: font.cls })
    return g.close + 1
  }

  // ── \operatorname{foo} → foo
  if (name === 'operatorname') {
    const g = readGroup(s, nameEnd, end)
    if (!g) return nameEnd
    const content = s.slice(g.open + 1, g.close)
    if (!/^[A-Za-z]+$/.test(content)) return nameEnd
    out.push({ from: start, to: g.close + 1, text: content, cls: CLS.mathrm })
    return g.close + 1
  }

  // ── \text{…} / \begin{…} / \label{…}:整组跳过(里面不是公式)
  if (TEXT_ARG_MACROS.has(name)) {
    const g = readGroup(s, nameEnd, end)
    if (!g) return nameEnd
    const content = s.slice(g.open + 1, g.close)
    if (TEXT_SHOWN.has(name) && PLAIN_TEXT.test(content)) {
      out.push({ from: start, to: g.close + 1, text: content, cls: CLS.mathrm })
    }
    return g.close + 1
  }

  // ── \sin \lim \max …:命令名原样显示成直立体
  if (OPERATORS.has(name)) {
    const stop = absorbLimits(s, nameEnd, end)
    out.push({ from: start, to: stop, text: name, cls: CLS.mathrm })
    return stop
  }

  // ── \langle \lVert …
  const bracket = (brackets as Table)[name]
  if (bracket !== undefined) {
    out.push({ from: start, to: nameEnd, text: bracket, cls: CLS.bracket })
    return nameEnd
  }

  // ── 通用符号表(greek + cmd_symbols)。
  // ⚠️只查字母宏:`\\`(换行)、`\,`(细空格)这类单字符宏不该拿去查表,表里的键全是字母。
  if (/^[A-Za-z]+$/.test(name)) {
    const sym = SYMBOLS[name]
    if (sym !== undefined) {
      const stop = absorbLimits(s, nameEnd, end)
      out.push({ from: start, to: stop, text: sym })
      return stop
    }
  }
  return nameEnd
}

/** 扫一段公式正文 `[from, to)`,给出互不重叠、按位置升序的替换清单。 */
export function scanEquation(s: string, from: number, to: number): Replacement[] {
  const out: Replacement[] = []
  let i = from
  while (i < to) {
    const c = s[i]
    if (c === '\\') {
      const cmd = readCmd(s, i, to)
      if (!cmd) break // 正文最后一个字符是孤零零的 `\`
      i = handleMacro(s, i, cmd.name, cmd.end, to, out)
      continue
    }
    if (c === '^' || c === '_') {
      const r = handleScript(s, i, to)
      if (r) { out.push(r); i = r.to; continue }
    }
    i++
  }
  // \frac 的花括号先于分子分母里的内容入列,所以这里必须排 —— 下游按顺序建装饰、单测按顺序断言。
  return out.sort((a, b) => a.from - b.from)
}

/** 扫一个 textblock 的文本:公式跨度交给 scanMath(与宿主同一套真相),跨度内部交给 scanEquation。 */
export function scanConceal(text: string): ConcealSpan[] {
  const out: ConcealSpan[] = []
  for (const sp of scanMath(text)) {
    const repls = scanEquation(text, sp.innerFrom, sp.innerTo)
    if (repls.length) {
      out.push({ from: sp.from, to: sp.to, innerFrom: sp.innerFrom, innerTo: sp.innerTo, repls })
    }
  }
  return out
}
