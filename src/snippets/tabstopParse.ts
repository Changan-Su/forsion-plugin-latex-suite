// 替换文本里的 tabstop 解析:`$0`、`$1`、`${1:默认值}`。
//
// ⚠️`$0` 是**第一个** tabstop(不是 LSP 约定里的「最终光标」)—— latex-suite 的用户契约如此,
// 默认片段表大量依赖它(`mk` → `$$0$` 展开成 `$|$`)。改这条 = 上千个默认片段全错位。
//
// 字面 `$` 不会被误吃:匹配要求 `$` 后紧跟数字或 `{数字:`,所以 `$$\n$0\n$$` 里的四个定界符
// 原样保留、只有 `$0` 成为 tabstop。

export interface TabstopRange {
  from: number
  to: number
}

export interface TabstopGroup {
  index: number
  /** 同一个下标出现多次 = 一组联动位点(见 tabstops.ts 的镜像说明)。按文本顺序。 */
  ranges: TabstopRange[]
}

export interface ParsedReplacement {
  /** 摘掉 tabstop 标记、默认值就地展开后的最终插入文本。 */
  text: string
  /** 按 index 升序;偏移相对 text。 */
  groups: TabstopGroup[]
}

const TOKEN = /\$(\d+)|\$\{(\d+):([^}]*)\}/g

/**
 * 压掉连续空格,并把位点偏移跟着搬。
 *
 * **为什么必须做**(真机台架实测出来的,纸面推不出来):Amadeus 的编辑器是 WYSIWYG markdown,
 * 块内容每次变化都会序列化回 md;而 markdown 会把连续空格压成一个。于是像 `\sqrt{ $0 }` 这种
 * 替换文本落进文档后**与它序列化再解析的结果不一致** → 宿主判定「内容变了」→ **重载整个文档** →
 * 插件的 tabstop 状态连同装饰一起被抹掉,表现是「这个片段展开后 Tab 不跳位」,而别的片段好好的。
 * (对照实验:`rd` → `^{$0}$1` 往返一致,decos=1、Tab 正常;`sq` → `\sqrt{ $0 }$1` 双空格,decos=0。)
 *
 * 上游长在 CodeMirror 上,文档就是纯文本,没有这一关 —— 这是宿主差异,不是上游的 bug。
 * 压完的结果与「让它重载一次」的结果**完全一样**,只是不用重载了,所以位点活着。
 * ⚠️不动换行,也不动行首缩进(那两样 markdown 是保得住的)。
 */
function collapseSpaces(text: string, groups: TabstopGroup[]): ParsedReplacement {
  if (!/[^\n] {2,}/.test(text)) return { text, groups }
  const map = new Array<number>(text.length + 1)
  let out = ''
  for (let i = 0; i < text.length; i++) {
    map[i] = out.length
    const c = text[i]
    // 行首的连续空格保留(md 的缩进语义),其余位置的第二个及以后的空格丢掉
    if (c === ' ' && out.length > 0 && out[out.length - 1] === ' ' && !/\n {0,3}$/.test(out)) continue
    out += c
  }
  map[text.length] = out.length
  const at = (i: number): number => map[Math.max(0, Math.min(text.length, i))]
  return {
    text: out,
    groups: groups.map((g) => ({ index: g.index, ranges: g.ranges.map((r) => ({ from: at(r.from), to: at(r.to) })) })),
  }
}

export function parseTabstops(insert: string): ParsedReplacement {
  const byIndex = new Map<number, TabstopRange[]>()
  let text = ''
  let last = 0
  TOKEN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(insert)) !== null) {
    text += insert.slice(last, m.index)
    const index = Number(m[1] ?? m[2])
    const def = m[3] ?? ''
    const from = text.length
    text += def
    const to = text.length
    const list = byIndex.get(index)
    if (list) list.push({ from, to })
    else byIndex.set(index, [{ from, to }])
    last = m.index + m[0].length
  }
  text += insert.slice(last)

  const groups = Array.from(byIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([index, ranges]) => ({ index, ranges }))

  return collapseSpaces(text, groups)
}
