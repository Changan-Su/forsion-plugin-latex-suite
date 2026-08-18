// 「我现在在什么模式里?」—— 片段能不能跑全看这个判断。
//
// 上游用 lezer 语法树问 Obsidian 要节点类型(750 行的 context.ts)。这里不需要:Amadeus 的公式
// **本来就是纯文本** `$…$` / `$$…$$`,扫一遍字符串就是精确答案,而且与宿主 mathLivePreview 的
// scanMath 用的是同一套规则 —— 两处口径必须一致,否则会出现「片段以为在公式里、渲染却不认」。
//
// ⚠️扫描规则(与宿主逐条对齐,改这里之前先去看 mathLivePreview.ts 的 scanMath):
//   - 块级 `$$…$$` 优先,`$$$` 三连不当块公式起手;
//   - 行内 `$…$`:开 `$` 后不接空白、闭 `$` 前不接空白、闭 `$` 后不接字母数字、不跨行
//     —— 挡掉「$5-$10」价位区间与「$HOME/$USER」环境变量被吞成公式。

export interface MathSpan {
  /** 含定界符的范围。 */
  from: number
  to: number
  /** 公式正文范围(不含定界符)。 */
  innerFrom: number
  innerTo: number
  display: boolean
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === undefined

/** 扫描一段文本里的公式跨度。与宿主 scanMath 同规则(见文件头)。 */
export function scanMath(s: string): MathSpan[] {
  const spans: MathSpan[] = []
  const n = s.length
  let i = 0
  while (i < n) {
    if (s[i] === '$') {
      if (s[i + 1] === '$') {
        if (s[i + 2] !== '$') {
          const close = s.indexOf('$$', i + 2)
          if (close > i + 1) {
            const latex = s.slice(i + 2, close).trim()
            if (latex) {
              spans.push({ from: i, to: close + 2, innerFrom: i + 2, innerTo: close, display: true })
              i = close + 2
              continue
            }
          }
        }
        i += 2
        continue
      }
      if (!isSpace(s[i + 1])) {
        let j = i + 1
        let found = -1
        while (j < n) {
          const c = s[j]
          if (c === '\n') break
          if (c === '$') {
            if (!isSpace(s[j - 1]) && !/[A-Za-z0-9]/.test(s[j + 1] ?? '')) found = j
            break
          }
          j++
        }
        if (found > i + 1) {
          spans.push({ from: i, to: found + 1, innerFrom: i + 1, innerTo: found, display: false })
          i = found + 1
          continue
        }
      }
    }
    i++
  }
  return spans
}

/** 光标所在的公式跨度;不在公式里 → null。
 *  边界口径:定界符**内侧**算在里面(`$|x$` 与 `$x|$` 都算),定界符本身之外不算 ——
 *  刚打完开头的 `$` 光标就在 innerFrom,片段应当立刻按数学模式工作。 */
export function mathSpanAt(spans: MathSpan[], pos: number): MathSpan | null {
  for (const s of spans) if (pos >= s.innerFrom && pos <= s.innerTo) return s
  return null
}

/** **未闭合**的公式开头:用户刚打下 `$` 还没打结尾时,后面的输入也该按数学模式走
 *  (上游靠语法树天然拿到这个态;这里显式补)。返回该 `$`/`$$` 之后的位置,没有则 null。 */
export function openMathAt(text: string, pos: number, spans: MathSpan[]): { at: number; display: boolean } | null {
  // 已经落在闭合跨度里就不算「未闭合」
  if (mathSpanAt(spans, pos)) return null
  // 从 pos 往前找最近一个不属于任何闭合跨度的 `$`
  const covered = (i: number): boolean => spans.some((s) => i >= s.from && i < s.to)
  for (let i = pos - 1; i >= 0; i--) {
    const c = text[i]
    if (c === '\n') return null // 行内公式不跨行;跨行的块公式在 Amadeus 里是另一个 textblock
    if (c !== '$' || covered(i)) continue
    if (text[i - 1] === '$' && !covered(i - 1)) return { at: i + 1, display: true }
    if (text[i + 1] === '$') continue // 是块级起手的第一个 `$`,让下一轮命中第二个
    return { at: i + 1, display: false }
  }
  return null
}

/** 片段模式(与上游 Mode 一一对应,只保留 Amadeus 里有意义的那些)。 */
export interface Mode {
  text: boolean
  inlineMath: boolean
  blockMath: boolean
  codeBlock: boolean
  /** 在 `\text{…}` / `\mathrm{…}` 这类文本环境里 —— 数学片段在这里**不该**触发。 */
  textEnv: boolean
}

export const emptyMode = (): Mode => ({ text: false, inlineMath: false, blockMath: false, codeBlock: false, textEnv: false })

export const inMath = (m: Mode): boolean => m.inlineMath || m.blockMath
/** 严格数学:在公式里且不在文本环境里。 */
export const strictlyInMath = (m: Mode): boolean => inMath(m) && !m.textEnv

/** 会把「数学」重新变回「文本」的宏 —— 在它们的花括号里,数学片段必须让路。 */
const TEXT_MACROS = ['text', 'textrm', 'textbf', 'textit', 'textsf', 'texttt', 'mathrm', 'mbox', 'textnormal', 'label', 'tag', 'ref', 'begin', 'end']

/** 光标是否落在某个文本宏的花括号参数里。从 mathFrom 起做一次括号栈扫描,
 *  遇到 `\macro{` 入栈、`}` 出栈 —— 只关心「栈顶是不是文本宏」。 */
export function inTextEnv(text: string, mathFrom: number, pos: number): boolean {
  const stack: boolean[] = [] // true = 这层花括号属于文本宏
  for (let i = mathFrom; i < pos; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue } // 跳过转义字符,`\{` 不是括号
    if (c === '{') {
      // 往回看紧邻的 `\name`
      let j = i - 1
      while (j >= mathFrom && /[A-Za-z]/.test(text[j])) j--
      const name = text.slice(j + 1, i)
      stack.push(text[j] === '\\' && TEXT_MACROS.includes(name))
    } else if (c === '}') {
      stack.pop()
    }
  }
  return stack.some(Boolean)
}

/** 光标外层的**宏名**栈(`\ce{ H2|O }` → `['ce']`),供片段的 excludedMacros 用。
 *  默认片段表拿它挡化学式:`\ce{H2}` 里的 `H2` 不该被下标片段吃成 `H_{2}`。
 *  与 inTextEnv 同一趟括号栈扫描,只是记名字而不是记「是不是文本宏」。 */
export function macroNamesAt(text: string, mathFrom: number, pos: number): string[] {
  const stack: string[] = []
  for (let i = mathFrom; i < pos; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue }
    if (c === '{') {
      let j = i - 1
      while (j >= mathFrom && /[A-Za-z]/.test(text[j])) j--
      stack.push(text[j] === '\\' ? text.slice(j + 1, i) : '')
    } else if (c === '}') {
      stack.pop()
    }
  }
  return stack.filter(Boolean)
}

/** 环境名栈(`\begin{align}` … `\end{align}`),供片段的 excludedEnvironments 用。 */
export function envNamesAt(text: string, mathFrom: number, pos: number): string[] {
  const stack: string[] = []
  const re = /\\(begin|end)\{([^}]*)\}/g
  re.lastIndex = mathFrom
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index >= pos) break
    if (m[1] === 'begin') stack.push(m[2])
    else if (stack[stack.length - 1] === m[2]) stack.pop()
  }
  return stack
}

export interface MathContext {
  mode: Mode
  /** 光标所在公式(含未闭合的开头);不在公式里 → null。 */
  span: { innerFrom: number; innerTo: number; display: boolean } | null
  envNames: string[]
  /** 光标外层的宏名栈(excludedMacros 用)。 */
  macroNames: string[]
}

/** 一次算全:模式 + 所在公式 + 环境栈。 */
export function mathContext(text: string, pos: number, opts: { inCodeBlock: boolean }): MathContext {
  const mode = emptyMode()
  if (opts.inCodeBlock) {
    mode.codeBlock = true
    return { mode, span: null, envNames: [], macroNames: [] }
  }
  const spans = scanMath(text)
  const hit = mathSpanAt(spans, pos)
  let span: MathContext['span'] = null
  if (hit) {
    span = { innerFrom: hit.innerFrom, innerTo: hit.innerTo, display: hit.display }
  } else {
    const open = openMathAt(text, pos, spans)
    if (open) span = { innerFrom: open.at, innerTo: pos, display: open.display }
  }
  if (!span) {
    mode.text = true
    return { mode, span: null, envNames: [], macroNames: [] }
  }
  if (span.display) mode.blockMath = true
  else mode.inlineMath = true
  mode.textEnv = inTextEnv(text, span.innerFrom, pos)
  return {
    mode,
    span,
    envNames: envNamesAt(text, span.innerFrom, pos),
    macroNames: macroNamesAt(text, span.innerFrom, pos),
  }
}
