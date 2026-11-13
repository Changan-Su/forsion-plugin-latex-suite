// ProseMirror ↔ 纯文本的适配层 —— 整个移植的地基。
//
// 上游 latex-suite 长在 CodeMirror 上,那里文档**本身**就是一根字符串,`state.sliceDoc(a,b)` 随手可得。
// Amadeus 是 ProseMirror:文档是节点树,位置是树坐标。两者对不上的地方全部收在这个文件里,
// 上面的片段引擎只跟「一根字符串 + 一个光标偏移」打交道,和上游的逻辑一一对应。
//
// **作用域 = 当前 textblock**(一个段落 / 一个标题 / 一个列表项)。这与宿主自己的公式实况预览
// (mathLivePreview 的 buildBlockString)是同一个作用域 —— 跨段落的 `$$…$$` 宿主也不认,
// 这里刻意不做得比宿主更强,否则「片段以为在公式里、渲染却不认」会出现两套真相。

import type { EditorState, Transaction } from 'prosemirror-state'
import type { Node as PmNode, ResolvedPos } from 'prosemirror-model'

/** 行内非文本节点(图片、双链芯片…)的占位符。与宿主同款:占位**等长**,偏移才对得上。 */
const ATOM = '￼'

export interface BlockText {
  /** 当前 textblock 的纯文本(行内原子按 nodeSize 补等长占位符)。 */
  text: string
  /** 选区在 text 里的偏移(闭开区间)。 */
  from: number
  to: number
  /** text 偏移 → 文档位置的基准:docPos = base + textOffset。 */
  base: number
  /** textblock 节点本身(判类型用:代码块 / 标题 / 段落)。 */
  node: PmNode
}

/** 把一个 textblock 摊成字符串。行内原子补等长占位符 —— 少一个字符,后面所有位置都错。 */
export function blockString(node: PmNode): string {
  let out = ''
  node.forEach((child) => {
    if (child.isText) out += child.text ?? ''
    else if (['hardbreak', 'hard_break', 'break'].includes(child.type.name)) out += '\n'.repeat(child.nodeSize)
    else out += ATOM.repeat(child.nodeSize)
  })
  return out
}

/** 取当前选区所在 textblock 的文本视图;选区跨块或不在 textblock 里 → null(片段一律不介入)。 */
export function blockTextAt(state: EditorState): BlockText | null {
  if (state.storedMarks?.some((m) => ['code', 'inlineCode', 'amadeusEscaped'].includes(m.type.name))) return null
  const { $from, $to } = state.selection
  if (!$from.parent.isTextblock) return null
  if ($from.sameParent($to) === false) return null
  return {
    text: blockString($from.parent),
    from: $from.parentOffset,
    to: $to.parentOffset,
    base: $from.start(),
    node: $from.parent,
  }
}

/** 代码块里一律不跑片段(上游同款:`c`/`C` 模式另说,但默认不该在代码里展开)。 */
export function isCodeBlock(node: PmNode): boolean {
  return node.type.spec.code === true || node.type.name === 'code_block'
}

/** Literal code in raw-source test adapters. Production also checks ProseMirror marks. */
export function inInlineCode(text: string, pos: number): boolean {
  const re = /(`+)([\s\S]*?)\1/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) if (pos > m.index && pos < m.index + m[0].length) return true
  return false
}

/** Position-preserving context shared by snippets, commands and decorations. */
export function mathBlockString(node: PmNode): string {
  let out = ''
  node.forEach((child) => {
    if (child.isText) {
      const text = child.text ?? ''
      const marks = child.marks ?? []
      if (marks.some((m) => m.type.name === 'code' || m.type.name === 'inlineCode')) out += ' '.repeat(text.length)
      else if (marks.some((m) => m.type.name === 'amadeusEscaped')) out += text.replace(/\$/g, '\u0002')
      else out += text
    } else if (['hardbreak', 'hard_break', 'break'].includes(child.type.name)) out += '\n'.repeat(child.nodeSize)
    else out += ATOM.repeat(child.nodeSize)
  })
  // Source-mode adapters can retain literal backticks; preserve their offsets too.
  return out.replace(/(`+)([\s\S]*?)\1/g, (code) => ' '.repeat(code.length))
}

/** Block edits must not replace code marks, escaped literals or inline atoms. */
export function protectedRange(bt: BlockText, from = bt.from, to = bt.to): boolean {
  let blocked = false
  bt.node.forEach((child, offset) => {
    const size = child.nodeSize ?? child.text?.length ?? 0
    const touches = from === to ? offset < from && offset + size > from : offset < to && offset + size > from
    if (touches && (!child.isText || child.marks?.some((m) => ['code', 'inlineCode', 'amadeusEscaped'].includes(m.type.name)))) blocked = true
  })
  const marks = bt.node.resolve?.(from).marks() ?? []
  return blocked || marks.some((m) => ['code', 'inlineCode', 'amadeusEscaped'].includes(m.type.name)) || inInlineCode(bt.text, from)
}

/** Preserve source newlines as soft breaks in the host's inline node model.
 * Literal newlines inside a text node can collapse during DOM/Markdown round trips.
 * `isInline` tells Amadeus to serialize a bare newline rather than a Markdown `\\` break.
 */
export function inlineTextNodes(schema: EditorState['schema'], text: string): PmNode[] {
  const br = schema.nodes?.hardbreak ?? schema.nodes?.hard_break ?? schema.nodes?.break
  if (!br || !text.includes('\n')) return text ? [schema.text(text)] : []
  return text.split('\n').flatMap((line, i) => [
    ...(i ? [br.create({ isInline: true })] : []),
    ...(line ? [schema.text(line)] : []),
  ])
}

/** 在 textblock 内做一次替换,并把光标放到 caret(text 偏移)。返回事务,由调用方 dispatch。 */
export function replaceInBlock(
  state: EditorState,
  bt: BlockText,
  from: number,
  to: number,
  insert: string,
  caret?: number,
): Transaction {
  const tr = state.tr
  const a = bt.base + from
  const b = bt.base + to
  if (insert) tr.replaceWith(a, b, insert.includes('\n') ? inlineTextNodes(state.schema, insert) : state.schema.text(insert))
  else tr.delete(a, b)
  if (caret != null) {
    const p = Math.max(0, Math.min(tr.doc.content.size, bt.base + caret))
    tr.setSelection(textSelectionAt(tr.doc, p))
  }
  return tr
}

/** 造一个折叠光标选区。⚠️不 import prosemirror-state 的运行时(插件拿不到模块图),
 *  由 setPm() 注入宿主递来的那一份 TextSelection。 */
let TextSelectionCtor: {
  create(doc: PmNode, anchor: number, head?: number): unknown
  near(pos: ResolvedPos, bias?: number): unknown
} | null = null

export function setTextSelectionCtor(ctor: typeof TextSelectionCtor): void {
  TextSelectionCtor = ctor
}

export function textSelectionAt(doc: PmNode, pos: number, head?: number): never {
  if (!TextSelectionCtor) throw new Error('latex-suite: TextSelection 未注入(setTextSelectionCtor)')
  return TextSelectionCtor.create(doc, pos, head) as never
}
