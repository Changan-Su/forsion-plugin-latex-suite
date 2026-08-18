// 自动分数:在公式里打 `/`,把光标前面那一「项」收进 `\frac{项}{}`,光标落进分母。
//
// 对应上游 features/autofraction.ts。项的边界判定逐条照抄(向左扫到空白 / 运算符 / 公式起点,
// 遇到右括号则整对括号连内容一起吃进来),因为这是用户肌肉记忆的一部分:`(a+b)/` 必须给
// `\frac{a+b}{}`,`x^2 + y/` 必须只吃 `y`。
//
// ⚠️调用时机:接在 `handleTextInput` 的 `/` 上,**`/` 还没进文档**。所以替换范围的右端就是当前
// 光标;返回 true 让调用方吞掉这次输入,`/` 不会再落到文档里。

import type { EditorView } from 'prosemirror-view'
import { replaceInBlock } from '../editor/text'
import type { MathCursor } from './shared'
import { hasInlineAtom, mathCursorAt, matchBracketBackward, matchBracketForward, openBracketOf } from './shared'

/** 上游 `autofractionBreakingChars` 的默认值,与设置模型 model.ts 里的那份**必须一致**
 *  (这里曾经自作主张加过 `,;!?<>~`,等于给同一个默认值造了第二份真相)。
 *  除了这些,`" $([{\n"` 是**恒定**的截断字符(上游硬编码),不受设置影响。 */
export const DEFAULT_BREAKING_CHARS = '+-=\t'

const ALWAYS_BREAKING = ' $([{\n'

/** 上游 `autofractionExcludedEnvs` 的默认值。
 *  ⚠️注意它们**不是** `\begin{}` 环境名,而是「左花括号前缀」—— `x^{1/2}` 里那个 `/` 是真的除号,
 *  不能变成 `\frac`。所以本文件对两种写法都认:以 `{` 结尾的按前缀比、其余的按环境名比。 */
export const DEFAULT_AUTOFRACTION_EXCLUDED_ENVS = ['^{', '\\pu{']

/** 希腊字母(与上游同一份表)。 */
const GREEK =
  'alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|zeta|eta|theta|Theta|iota|kappa|lambda|Lambda|mu|nu|omicron|xi|Xi|pi|Pi|rho|sigma|Sigma|tau|upsilon|Upsilon|varphi|phi|Phi|chi|psi|Psi|omega|Omega'

/** `\alpha x/` 里那个空格是「命令名结束」的分隔符,不是项的边界 —— 把它换成一个占位符骗过扫描。
 *  ⚠️**必须 1 字符换 1 字符**:下面所有偏移都直接用在原文上,长度一变全盘错位。 */
function maskGreekSpaces(s: string): string {
  // 就地新建正则:带 /g 的模块级正则要靠调用方记得清 lastIndex,那种状态不值得引进来。
  return s.replace(new RegExp('(' + GREEK + ') ([^ ])', 'g'), '$1#$2')
}

export interface AutoFractionOptions {
  /** 关掉时直接放行,`/` 原样落进文档。 */
  enabled?: boolean
  /** 不触发的环境:`\begin{}` 环境名,或以 `{` 结尾的左括号前缀(见上面的说明)。 */
  excludedEnvs?: string[]
  /** 会截断「项」的字符(上游 `autofractionBreakingChars`)。 */
  breakingChars?: string
}

/** `symbol` = 分数命令本身,上游 `autofractionSymbol`,默认 `\frac`(也可以是 `\dfrac`/`\tfrac`)。 */
export function autoFraction(view: EditorView, symbol: string, opts: AutoFractionOptions = {}): boolean {
  if (view.composing) return false
  if (opts.enabled === false) return false

  const m = mathCursorAt(view.state)
  if (!m) return false
  // `\text{…}` 里的 `/` 是普通的斜杠(日期、单位、「和/或」),绝不能变分数。
  if (m.ctx.mode.textEnv) return false
  if (isExcluded(m, opts.excludedEnvs ?? DEFAULT_AUTOFRACTION_EXCLUDED_ENVS)) return false

  const breaking = opts.breakingChars ?? DEFAULT_BREAKING_CHARS
  const to = m.pos
  let start: number

  if (m.bt.from !== m.bt.to) {
    // 有选区 → 选区就是分子(上游同款,省得再猜边界)。
    start = m.bt.from
  } else {
    start = m.innerFrom
    const scan = maskGreekSpaces(m.bt.text.slice(m.innerFrom, to))
    for (let i = scan.length - 1; i >= 0; i--) {
      const c = scan.charAt(i)
      const open = openBracketOf(c)
      if (open) {
        const j = matchBracketBackward(scan, i, open, c)
        // 右括号没配对 = 公式本身是残的,这时候硬猜分子只会把括号切两半。
        if (j === null) return false
        i = j // 整对括号连内容都算进分子,循环末尾的 i-- 会继续扫左括号前面
      }
      if (ALWAYS_BREAKING.includes(c) || breaking.includes(c)) {
        start = i + 1 + m.innerFrom
        break
      }
    }
  }

  if (start >= to) return false // 光标前面没东西可当分子(`$/` 或 `$ /`)
  // 分子里有行内原子(图片、双链芯片)就放弃:下面是「读出这段文本再插回去」,
  // 插回去的只会是占位符字符,真节点当场没了(见 shared.hasInlineAtom)。
  if (hasInlineAtom(m.bt, start, to)) return false

  let numerator = m.bt.text.slice(start, to)
  // `(a+b)/` → `\frac{a+b}{}`:外层括号是用来圈定分子的,进了 `\frac{}` 就没用了。
  // ⚠️只在这对括号**正好**包住整个分子时才剥,`(a)+(b)` 剥了会变成 `a)+(b`。
  if (numerator.startsWith('(') && numerator.endsWith(')')) {
    if (matchBracketForward(numerator, 0, '(', ')') === numerator.length - 1) {
      numerator = numerator.slice(1, -1)
    }
  }

  const insert = `${symbol}{${numerator}}{}`
  // 分子为空(`()/`)时光标进**第一**对花括号 —— 上游同款。任务书说的「第二个花括号」是
  // 分子非空时的常态;分子空着还把光标丢去分母,用户得自己退回来补分子。
  const caret = numerator.length === 0
    ? start + symbol.length + 1
    : start + symbol.length + numerator.length + 3

  view.dispatch(replaceInBlock(view.state, m.bt, start, to, insert, caret).scrollIntoView())
  return true
}

/** 环境排除:环境名走 `\begin{}` 栈,`{` 前缀走花括号栈。两套机制并存(见 EXCLUDED_ENVS 注释)。 */
function isExcluded(m: MathCursor, excluded: string[]): boolean {
  if (excluded.length === 0) return false
  const prefixes = excluded.filter((e) => e.endsWith('{'))
  // 上游的排除项是「左定界符 / 右定界符」两件套,用户完全可以写 `["\\begin{align}", "\\end{align}"]`
  // ——接线层只取左半边递进来,所以这儿得把 `\begin{x}` 还原成环境名 `x`,否则拿整串去比环境栈
  // 永远比不上,那条排除规则就是写了也不生效。
  const envNames = excluded
    .filter((e) => !e.endsWith('{'))
    .map((e) => /^\\begin\{([^}]*)\}$/.exec(e)?.[1] ?? e)
  if (envNames.length && m.ctx.envNames.some((n) => envNames.includes(n))) return true
  if (prefixes.length === 0) return false
  return openBraceStack(m.bt.text, m.innerFrom, m.pos).some((p) => prefixes.includes(p))
}

/** 光标外面套着的那些 `{` 各自是被什么开出来的(`^{`、`_{`、`\pu{`、裸 `{`)。
 *  与 mathMode.inTextEnv 同一条扫描路子,只是记的是前缀而不是「是不是文本宏」。 */
function openBraceStack(text: string, from: number, pos: number): string[] {
  const stack: string[] = []
  for (let i = from; i < pos; i++) {
    const c = text[i]
    if (c === '\\') {
      i++ // 跳过被转义的那个字符:`\{` 不是分组括号
      continue
    }
    if (c === '{') stack.push(braceOpenerAt(text, from, i))
    else if (c === '}') stack.pop()
  }
  return stack
}

function braceOpenerAt(text: string, from: number, at: number): string {
  const prev = text[at - 1]
  if (prev === '^' || prev === '_') return prev + '{'
  let j = at - 1
  while (j >= from && /[A-Za-z]/.test(text[j])) j--
  if (text[j] === '\\') return text.slice(j, at + 1) // `\pu{`
  return '{'
}
