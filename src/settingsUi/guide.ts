import type { SettingsUiApi } from './index'
import type { Snippet } from '../snippets/model'

export function mountGuide(root: HTMLElement, api: SettingsUiApi): () => void {
  const t = (zh: string, en: string): string => api.locale() === 'en' ? en : zh
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag)
    node.textContent = text
    node.className = cls
    return node
  }
  const button = (label: string, run: () => void): HTMLButtonElement => {
    const b = el('button', label, 'btn sm')
    b.type = 'button'
    b.onclick = run
    return b
  }
  root.append(el('h3', t('三分钟上手', 'Quick start')))
  const steps = el('ol', '', 'ls-guide-steps')
  for (const text of [
    t('用命令面板插入行内或块级公式。只有成对 $…$ / $$…$$ 内会自动展开数学片段。', 'Insert inline or block math from the command palette. Math snippets expand only inside paired $…$ / $$…$$.'),
    t('在公式内输入 @a → \\alpha、// → 分式、sr → 平方。Tab 跳占位，Shift+Tab 返回，Esc 结束跳位。', 'Inside math, type @a for \\alpha, // for a fraction, or sr for a square. Tab moves through placeholders; Shift+Tab goes back; Esc ends the session.'),
    t('Tab 顺序：手动片段 → 占位点 → 矩阵分列 → 跳出括号或公式。其余情况交回编辑器。', 'Tab order: manual snippet → placeholder → matrix cell → exit brackets or math. Otherwise the editor handles the key.'),
    t('矩阵内 Enter 插入行分隔符，Shift+Enter 退出环境；需要源码换行时使用编辑器的换行操作。', 'Inside a matrix, Enter inserts a row separator; Shift+Enter exits the environment. Use the editor’s line-break action for source line breaks.'),
    t('刚展开后按 Backspace 可还原触发串。继续编辑后使用编辑器的撤销；粘贴和输入法组词不触发自动片段。', 'Immediately after expansion, Backspace restores the trigger. After further edits, use editor Undo. Paste and IME composition do not expand snippets.'),
  ]) steps.append(el('li', text))
  root.append(steps)
  const actions = el('div', '', 'ls-guide-actions')
  const pause = button('', () => api.togglePause?.())
  const reload = button(t('重新加载片段', 'Reload snippets'), () => { void api.reload?.() })
  actions.append(pause, reload)
  const status = el('p', '', 'ls-note')
  const refresh = (): void => {
    pause.textContent = api.paused?.() ? t('恢复自动展开', 'Resume automatic expansion') : t('暂停自动展开', 'Pause automatic expansion')
    pause.setAttribute('aria-pressed', String(api.paused?.() ?? false))
    const mode = api.watchMode?.() ?? 'manual'
    status.textContent = mode === 'live'
      ? t('文件改动与增删会自动重载。加载失败时保留有效片段，并在片段页显示错误。', 'File changes, additions and removals reload automatically. Errors keep the valid library and appear on the Snippets tab.')
      : mode === 'existing-files'
        ? t('已知文件会自动重载；新增或改名后请点「重新加载片段」。', 'Known files reload automatically. Reload manually after adding or renaming files.')
        : t('当前宿主需要手动重载外部文件。加载失败时保留有效片段。', 'This host requires manual reload of external files. Loading errors keep the valid library.')
    renderReference()
  }
  root.append(actions, status, el('h3', t('练习区', 'Practice')))
  root.append(el('p', t('内容只在本次插件会话中保留，不写入智库。使用当前片段和设置；切换语言保留练习内容。', 'Kept only for this plugin session; nothing is written to the vault. Uses your current snippets and settings. Language changes preserve the draft.'), 'ls-note'))
  const practice = el('div', '', 'ls-practice')
  const source = el('pre', '', 'ls-practice-source')
  source.setAttribute('aria-label', t('练习源码', 'Practice source'))
  const seed = '$x$\n\n$$ \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} $$'
  source.textContent = api.practiceDraft?.() ?? seed
  root.append(practice)
  let handle: ReturnType<NonNullable<SettingsUiApi['mountPractice']>> | undefined
  if (api.mountPractice) {
    handle = api.mountPractice(practice, {
      value: source.textContent,
      label: t('LaTeX 练习编辑器', 'LaTeX practice editor'),
      vault: false,
      modes: false,
      onChange: (value) => { api.setPracticeDraft?.(value); source.textContent = value },
    })
    const practiceActions = el('div', '', 'ls-guide-actions')
    for (const [label, id] of [[t('插入行内公式', 'Insert inline math'), 'latex-suite-insert-inline-math'], [t('插入块级公式', 'Insert block math'), 'latex-suite-insert-block-math']]) {
      practiceActions.append(button(label, () => api.runPracticeCommand?.(practice, id)))
    }
    let armed = false
    const reset = button(t('重置练习', 'Reset practice'), () => {
      if (!armed) { armed = true; reset.textContent = t('再次点击确认', 'Click again to reset'); return }
      armed = false
      api.setPracticeDraft?.(seed)
      source.textContent = seed
      handle?.update({ value: seed })
      reset.textContent = t('重置练习', 'Reset practice')
    })
    reset.onblur = () => { armed = false; reset.textContent = t('重置练习', 'Reset practice') }
    practiceActions.append(reset)
    root.append(practiceActions, source)
  } else {
    practice.append(el('p', t('此版本宿主没有独立编辑器接口，请升级 Forsion 后使用练习区。下面的速查仍可使用。', 'This host does not provide an independent editor. Upgrade Forsion to use practice; the reference below remains available.'), 'ls-note'))
  }
  root.append(el('h3', t('片段速查', 'Snippet reference')))
  const search = el('input', '', 'ls-input')
  search.type = 'search'
  search.placeholder = t('搜索片段或命令', 'Search snippets or commands')
  search.setAttribute('aria-label', t('搜索片段', 'Search snippets'))
  const reference = el('div', '', 'ls-reference')
  root.append(search, reference)
  const category = (s: Snippet): string => {
    const body = typeof s.replacement === 'string' ? s.replacement : ''
    if (/^[@:]/.test(s.triggerSource) || /\\(alpha|beta|gamma|theta|omega)\b/.test(body)) return t('希腊字母', 'Greek letters')
    if (/matrix|cases|align|begin/.test(body)) return t('矩阵与环境', 'Matrices and environments')
    if (/frac|sqrt|\^|_/.test(body)) return t('分式与上下标', 'Fractions and scripts')
    return t('其他片段', 'Other snippets')
  }
  function renderReference(): void {
    reference.replaceChildren()
    const query = search.value.trim().toLowerCase()
    const groups = new Map<string, Snippet[]>()
    for (const snippet of api.snippets?.() ?? []) {
      const haystack = `${snippet.triggerSource} ${snippet.description} ${typeof snippet.replacement === 'string' ? snippet.replacement : ''}`.toLowerCase()
      if (query && !haystack.includes(query)) continue
      const key = category(snippet)
      groups.set(key, [...groups.get(key) ?? [], snippet])
    }
    if (!groups.size) reference.append(el('p', t('没有匹配的有效片段。', 'No matching active snippets.'), 'ls-note'))
    for (const [name, snippets] of groups) {
      const details = el('details')
      details.open = Boolean(query)
      details.append(el('summary', `${name} · ${snippets.length}`))
      for (const snippet of snippets) {
        const row = el('div', '', 'ls-reference-row')
        row.append(el('code', snippet.triggerSource), el('code', typeof snippet.replacement === 'string' ? snippet.replacement : t('动态替换函数', 'Dynamic replacement function')))
        const m = snippet.options.mode
        const modes = [m.inlineMath && t('行内公式', 'Inline math'), m.blockMath && t('块级公式', 'Block math'), m.text && t('正文', 'Text'), m.codeBlock && t('代码区已禁用', 'Code disabled')].filter(Boolean).join(' · ')
        row.append(el('small', `${modes} · ${snippet.options.automatic ? t('自动', 'Automatic') : t('手动', 'Manual')}${snippet.type === 'visual' ? t(' · 需要选区', ' · Selection required') : ''}`))
        details.append(row)
      }
      reference.append(details)
    }
  }
  search.oninput = renderReference
  refresh()
  const off = api.subscribe?.(refresh)
  return () => { off?.(); if (handle) { api.setPracticeDraft?.(handle.getValue()); handle.dispose() } }
}
