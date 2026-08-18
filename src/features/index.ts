// features 的汇总出口 —— 接线层(main.ts / 键位表)只从这里 import,别去 reach 具体文件。
//
// 接线注意事项(顺序是有讲究的,栽过的地方):
//   - **Tab**:全都不接就 return false,把 Tab 原样还给宿主(列表缩进)。唯一**不能动**的
//     先后是 matrixShortcut 排在 tabout 前面:`}` 在 tabout 的默认右定界符名单里,tabout 会把
//     `\begin{…}` 环境里的每一次 Tab 都劫走,矩阵就再也加不了单元格。
//   - **Enter**:matrixShortcut(view,'Enter') 排在宿主的分段之前。
//     ⚠️matrixShortcut 的第四个参数(MatrixOptions)现在能吃设置了,接线层请补上,否则
//     `matrixShortcutsMacroNames` 这条设置形同虚设、而且同一次 Tab 会用上两套右定界符名单:
//     `{ macros: splitList(s.matrixShortcutsMacroNames), closingSymbols: splitList(s.taboutClosingSymbols) }`
//   - **`/`**:接在 handleTextInput 上(字符还没进文档);返回 true 表示已接管,`/` 不再插入。
//   - **autoEnlargeBrackets**:片段引擎展开出含触发词的片段后调用(createEngine 的 onEnlarge)。
//     ⚠️上游在**自动分式展开成功后也会再放大一次**(`(\sum x)/` → 分子里的括号该跟着长高)。
//     这里不在 autoFraction 内部串,免得绕过设置开关;接线层自己接一句即可:
//     `if (autoFraction(...)) { if (s.autoEnlargeBrackets) autoEnlargeBrackets(view, {...}); return true }`
//   - **taboutByCloseBracket**:括号「打穿」(光标右边已有 `)` 时再打 `)` 就跳过去)。
//     **目前没接线** —— 需要在 handleTextInput 里加一句
//     `if (s.taboutEnabled && taboutByCloseBracket(view, text, {...})) return true`。
//   - 这些函数会经 editor/text.ts 的 textSelectionAt 造选区 —— 接线时**必须先调过
//     `setTextSelectionCtor(pm.TextSelection)`**,否则第一次按 Tab 就抛。

export {
  tabout,
  taboutByEnclosedBrackets,
  taboutByCloseBracket,
  shouldTaboutByCloseBracket,
  DEFAULT_TABOUT_CLOSING,
} from './tabout'
export type { TaboutOptions } from './tabout'

export { autoFraction, DEFAULT_BREAKING_CHARS, DEFAULT_AUTOFRACTION_EXCLUDED_ENVS } from './autoFraction'
export type { AutoFractionOptions } from './autoFraction'

export { matrixShortcut, DEFAULT_MATRIX_ENVS, DEFAULT_MATRIX_MACROS } from './matrixShortcuts'
export type { MatrixOptions } from './matrixShortcuts'

export { autoEnlargeBrackets, DEFAULT_ENLARGE_TRIGGERS } from './autoEnlargeBrackets'
export type { EnlargeOptions } from './autoEnlargeBrackets'

export {
  boxCurrentEquation,
  selectCurrentEquation,
  enterInlineMath,
  enterBlockMath,
  EDITOR_COMMANDS,
} from './editorCommands'
export type { EditorCommand } from './editorCommands'

// 公共零件也导出:接线层判「光标在不在公式里」时不该再写第三套扫描。
export { mathCursorAt, tokenize, hasInlineAtom, innermostScope } from './shared'
export type { MathCursor, Token, Scope } from './shared'
