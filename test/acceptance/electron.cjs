// Real Forsion acceptance. Set DESKTOP_DIR to a built Genesis desktop; only temp homes/vaults are used.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const desktop = process.env.DESKTOP_DIR || path.resolve(__dirname, '../../../../Forsion-Genesis/desktop')
const electron = require(path.join(desktop, 'scripts/lib/launch-electron.cjs'))
const { skipOnboarding } = require(path.join(desktop, 'scripts/lib/skip-onboarding.cjs'))
const { startStubEngine } = require(path.join(desktop, 'scripts/lib/stub-engine.cjs'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-latex-gui-'))
const vault = path.join(root, 'vault')
const userdata = path.join(root, 'userdata')
const installDir = path.join(root, 'plugins', 'latex-suite')
const source = process.env.PLUGIN_DIR || path.resolve(__dirname, '../..')
const out = process.env.OUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'latex-suite-evidence-'))
const note = path.join(vault, 'Practice.md')
const candidate = process.env.CASE !== 'baseline'
const errors = []
const reports = []
const check = (label, passed, detail) => {
  reports.push({ label, passed: !!passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
}
for (const folder of [vault, installDir, out]) fs.mkdirSync(folder, { recursive: true })
for (const f of ['main.js', 'manifest.json', 'README.md', 'README.en.md', 'CHANGELOG.md', 'icon.png']) {
  const file = path.join(source, f)
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(installDir, f))
}
console.log('plugin bundle SHA256', createHash('sha256').update(fs.readFileSync(path.join(installDir,'main.js'))).digest('hex'))
for (const folder of [userdata, userdata+'-dev']) {
  fs.mkdirSync(folder, { recursive: true })
  for (const name of ['amadeus-config.json', 'amadeus-config.dev.json']) {
    fs.writeFileSync(path.join(folder, name), JSON.stringify({ lastVault: vault, localVault: vault }))
  }
}
const seed = ['# Practice', '', 'Working example.', '', 'A second paragraph.', ''].join('\n')
fs.writeFileSync(note, candidate ? seed + '\nCurrency $5-$10\n\nEscaped \\$x\\$\n\nUnclosed $\n\nProse\n\nInline code `$x$`\n\n```text\n$x$\n```\n' : seed)
fs.writeFileSync(path.join(vault, 'Other.md'), '# Other\n\nOther page.\n')
const flags = process.platform === 'darwin' ? { home: 'Meta+ArrowLeft', end: 'Meta+ArrowRight' } : { home: 'Home', end: 'End' }
const recordErrors = (page) => page.on('pageerror', (e) => errors.push(e.message))
async function openSettings(app, win, title) {
  let settings = app.windows().find((w) => w.url().includes('window=floating') && !w.isClosed())
  if (!settings) {
    const event = app.waitForEvent('window', { timeout: 8000 }).catch(() => null)
    await win.keyboard.press('Meta+Comma')
    settings = await event
    if (!settings) throw new Error('Settings window did not open via Meta+Comma')
    recordErrors(settings)
  }
  await settings.locator('.settings-main').waitFor({ timeout: 20000 })
  const nav = settings.locator('.settings-nav')
  await nav.getByRole('button', { name: /^(插件|Plugins)$/ }).first().click()
  await settings.locator('.settings-nav-subitem').filter({ hasText: /^(已安装插件|Installed plugins)$/ }).first().click()
  const card = settings.locator('.plugin-card--link').filter({ hasText: 'LaTeX' }).first()
  if (!(await settings.locator('.ls-settings').count())) {
    await card.waitFor({timeout: 15000})
    check(title + ' plugin installed from disk', true)
    await card.click()
    const enable = settings.getByRole('switch').first()
    if (!(await enable.isChecked())) await enable.click()
  }
  await settings.locator('.ls-settings').waitFor({timeout: 15000})
  return settings
}
async function openNote(win, name = 'Practice') {
  const tab = win.locator('.rb-space[aria-label="笔记"], .rb-space[aria-label="Notes"], .rb-space[aria-label="Note"]').filter({ visible: true }).first()
  await tab.click({ timeout: 15000 })
  const row = win.locator('.t2s-srow').filter({ has: win.locator('.t2s-srow-title', { hasText: new RegExp(`^${name}$`) }) }).filter({ visible: true }).first()
  await row.click({ timeout: 20000 })
  const pm = win.locator(".unified-body .ProseMirror").filter({ visible: true, hasText: name === "Practice" ? "Working example." : "Other page." }).first()
  await pm.waitFor({ timeout: 20000 })
  return pm
}
async function poll(cb, timeout = 6000) {
  const end = Date.now() + timeout
  do {
    const value = await cb()
    if (value) return value
    await new Promise(r => setTimeout(r, 100))
  } while (Date.now() < end)
  return false
}
async function launch(stub, locale = 'zh', mode = 'light') {
  const app = await electron.launch({
    cwd: desktop,
    args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', desktop],
    env: { ...process.env, TANGU_HOME: root, FORSION_WORKSPACE_DIR: path.join(root,'workspace'), TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1', FORSION_TELEMETRY:'0', PI_CU_SOCKET_PATH: path.join(root,'bridge.sock') },
  })
  const win = await app.firstWindow()
  recordErrors(win)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1270, 840))
  await win.locator('.dv-groupview').first().waitFor({ state: 'attached', timeout: 40000 })
  const switched = await win.evaluate(({locale,mode}) => {
    const changes = localStorage.getItem('tangu_locale') !== locale || localStorage.getItem('forsion_theme_pref') !== mode
    localStorage.setItem('tangu_locale', locale)
    localStorage.setItem('forsion_theme_pref', mode)
    return changes
  }, {locale,mode})
  if (switched) await win.reload({ waitUntil: 'domcontentloaded' })
  if (!(await skipOnboarding(win, 3000))) throw new Error('Onboarding did not clear')
  return { app, win }
}
const saveShot = async (page, name, selector) => {
  await page.evaluate(() => document.fonts.ready)
  await (selector ? page.locator(selector).first() : page).screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' })
}
async function command(win, name) {
  await win.locator('[data-id="rb-cmd"] button').filter({visible:true}).first().click({timeout:6000})
  await win.locator('.cmd-input').filter({visible:true}).first().fill(name, {timeout:6000})
  await win.locator('.cmd-item').filter({ hasText: name }).first().click({ timeout: 6000 })
}
const docText = (pm) => pm.evaluate(e => e.pmViewDesc?.node?.textBetween(0,e.pmViewDesc.node.content.size,'\n') || e.textContent)
async function caretIn(loc, offset) {
  await loc.click()
  await loc.evaluate((el, wanted) => {
    const pm = el.closest('.ProseMirror') || el
    pm.focus()
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => n.parentElement?.closest('.katex,.ls-conceal-widget,[contenteditable="false"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    })
    let node = walker.nextNode()
    let last = node
    while (node) {
      last = node
      if (wanted <= node.textContent.length) { window.getSelection().setPosition(node, wanted); return }
      wanted -= node.textContent.length
      node = walker.nextNode()
    }
    if (last) window.getSelection().setPosition(last,last.textContent.length)
    else window.getSelection().setPosition(el,0)
  },offset)
  await loc.page().waitForTimeout(100)
}
function guideTab(settings) {
  return settings.locator('.ls-tab').filter({ hasText: /^(教程与练习|Guide & practice)$/ }).first()
}
const visibleButton = (page, name) => page.getByRole('button',{name}).filter({visible:true}).first()
async function practiceChecks(settings, noteContents) {
  await guideTab(settings).click({timeout: 7000})
  const pm = settings.locator('.ls-settings .amx-publishing-editor .ProseMirror').filter({visible:true}).first()
  await pm.waitFor({timeout:7000})
  check('Practice mounts host-native editable Markdown', await pm.getAttribute('contenteditable') === 'true')
  check('Practice matrix renders as native math', await poll(async () => (await pm.locator('.katex annotation').allTextContents()).some(t => t.includes('pmatrix'))))
  const search = settings.locator('.ls-settings input[type="search"], .ls-settings input[placeholder*="片段"], .ls-settings input[placeholder*="Search snippets"]').filter({visible:true}).first()
  await search.fill('this-snippet-does-not-exist')
  await settings.waitForTimeout(160)
  const empty = await settings.locator('.ls-settings').innerText()
  await search.fill('@a')
  await settings.waitForTimeout(180)
  const matching = await settings.locator('.ls-settings').innerText()
  check('Snippet reference filters live', matching !== empty && matching.includes('@a') && (matching.includes('alpha') || matching.includes('α')), {empty: empty.slice(-240), matching: matching.slice(-240)})
  await search.fill('')
  const draft = await docText(pm)
  await pm.locator('p').first().click()
  await settings.keyboard.press(flags.end)
  await settings.keyboard.type(' ')
  await visibleButton(settings, /^(插入行内公式|Insert inline math)$/).click()
  await settings.keyboard.type('@a', {delay: 55})
  check('Practice inline button uses actual math snippet engine', (await docText(pm)).includes('$\\alpha$'), await docText(pm))
  const pause = visibleButton(settings, /暂停.*(展开|片段)|Pause.*(expansion|snippets)/i)
  await pause.click()
  await pm.locator('p').first().click()
  await settings.keyboard.press(flags.end)
  await settings.keyboard.type(' ')
  await visibleButton(settings, /^(插入行内公式|Insert inline math)$/).click()
  await settings.keyboard.type('@b', {delay: 55})
  check('Pause blocks automatic expansion in practice', (await docText(pm)).includes('$@b$'), await docText(pm))
  const resume = visibleButton(settings, /恢复.*(展开|片段)|Resume.*(expansion|snippets)/i)
  await resume.click()
  await pm.locator('p').first().click()
  await settings.keyboard.press(flags.end)
  await settings.keyboard.type(' ')
  await visibleButton(settings, /^(插入块级公式|Insert block math)$/).click()
  await settings.keyboard.type('@t', {delay: 55})
  check('Practice display insertion and resume expand a real snippet', (await docText(pm)).includes('$$ \\theta $$'), await docText(pm))
  await pm.locator('p').first().click()
  await settings.keyboard.press(flags.end)
  await settings.keyboard.type(' retention-marker', {delay: 25})
  await settings.locator('.ls-tab').filter({hasText:/^(片段|Snippets)$/}).first().click()
  await guideTab(settings).click()
  await pm.waitFor({timeout:7000})
  check('Practice draft survives tab switch', (await docText(pm)).includes('retention-marker'), await docText(pm))
  await visibleButton(settings, /^(重新加载片段|Reload snippets|重新加载|Reload)$/).click()
  check('Reload preserves practice draft', (await docText(pm)).includes('retention-marker'))
  await guideTab(settings).scrollIntoViewIfNeeded()
  await saveShot(settings, 'guide-zh-light')
  await settings.locator('.ls-practice').scrollIntoViewIfNeeded()
  await saveShot(settings, 'practice-zh-light')
  await search.fill('@a')
  await settings.locator('.ls-reference-row').first().scrollIntoViewIfNeeded()
  await saveShot(settings, 'reference-zh-light')
  await visibleButton(settings, /^(重置练习|Reset practice|重置|Reset)$/).click()
  await visibleButton(settings, /^(再次点击确认|Click again to reset)$/).click()
  check('Reset restores original practice document', await poll(async () => (await docText(pm)) === draft), await docText(pm))
  check('Practice edits never write the vault note', fs.readFileSync(note,'utf8') === noteContents)
}
async function noteChecks(win, pm) {
  const line = (t) => pm.locator('p').filter({ hasText: t }).first()
  const editEnd = async (prefix, added) => {
    await line(prefix).click()
    await win.keyboard.press(flags.end)
    await win.keyboard.type(added, { delay: 45 })
    if (await win.locator('.wiki-suggest').filter({visible:true}).count()) await win.keyboard.press('Escape')
  }
  const save = (target) => poll(() => fs.readFileSync(note,'utf8').includes(target))
  await line('Working example.').click()
  await win.keyboard.press(flags.end)
  await win.keyboard.type(' ', {delay:35})
  await command(win,'插入行内公式')
  await win.keyboard.type('@asr', {delay:60})
  check('Command palette inserts paired inline math and @a/sr expand', await save('$\\alpha^{2}$'), fs.readFileSync(note,'utf8'))
  await line('A second paragraph.').click()
  await win.keyboard.press(flags.end)
  await command(win,'插入块级公式')
  await win.keyboard.type('//', {delay:60})
  await win.keyboard.type('a', {delay:50})
  await win.keyboard.press('Tab')
  await win.keyboard.type('b', {delay:50})
  await win.keyboard.press('Tab')
  check('Block command, fraction template and Tab write numerator and denominator', await save('$$ \\frac{a}{b} $$'), fs.readFileSync(note,'utf8'))
  await editEnd('Currency', ' @a')
  await editEnd('Escaped', ' @a')
  await editEnd('Unclosed', '@a')
  await editEnd('Prose', ' mk dm')
  const inline = line('Inline code').locator('code')
  await caretIn(inline,2)
  await win.keyboard.type('@a',{delay:60})
  const fenced = pm.locator('pre code').first()
  await caretIn(fenced,2)
  await win.keyboard.type('@a',{delay:60})
  const expected = [
    ['Currency remains literal', 'Currency $5-$10 @a'],
    ['Escaped dollars remain literal and preserve escapes', 'Escaped \\$x\\$ @a'],
    ['Unclosed dollar remains literal', 'Unclosed $@a'],
    ['mk/dm stay literal in ordinary prose by default', 'Prose mk dm'],
    ['Inline code stays literal and keeps its code mark', 'Inline code `$x@a$`'],
    ['Fenced code stays literal', '\n$x@a$\n'],
  ]
  for (const [label,target] of expected) check(label, await save(target), fs.readFileSync(note,'utf8'))
}
;(async () => {
  const stub = await startStubEngine()
  let app, win, settings
  try {
    ;({ app, win } = await launch(stub))
    settings = await openSettings(app, win, 'zh')
    const tabs = await settings.locator('.ls-tab').allTextContents()
    console.log('tabs:', tabs)
    console.log('settings classes:', await settings.locator('.ls-settings').getAttribute('class'))
    await saveShot(settings, 'settings-zh-light')
    if (candidate) await practiceChecks(settings,fs.readFileSync(note,'utf8'))
    await settings.getByRole('button', { name: /^(返回应用|Back to app)$/ }).first().click({ timeout:5000 }).catch(() => settings.close())
    settings = null
    const pm = await openNote(win)
    check('UnifiedPage production editor mounted', true, await pm.evaluate(e => e.closest('.unified-body').className))
    if (candidate) await noteChecks(win,pm)
    else {
    await pm.getByText('Working example.', { exact:true }).click()
    await win.keyboard.press(flags.end)
    await win.keyboard.type(' $@a$', { delay:70 })
    const sourceLine = () => pm.locator('p').first().evaluate((p) => {
      const copy = p.cloneNode(true)
      copy.querySelectorAll('.katex, .ls-conceal-widget').forEach(e => e.remove())
      return copy.textContent
    })
    check('Inline snippet in real editor', await poll(async () => (await sourceLine()).includes('\\alpha')), await sourceLine())
    check('Markdown written to real isolated vault', await poll(() => fs.readFileSync(note,'utf8').includes('$\\alpha$')), fs.readFileSync(note,'utf8'))
    }
    const savedBeforeRestart = fs.readFileSync(note,'utf8')
    await pm.locator('p').first().scrollIntoViewIfNeeded()
    await saveShot(win, 'note-zh-light')
    await app.close()
    ;({ app, win } = await launch(stub,'en','dark'))
    const reopened = await openNote(win)
    check('Reopened note after Electron restart', (await reopened.textContent()).includes('Working example.'), await reopened.textContent())
    if (candidate) check('Reopened editor contains both original expanded formulas', (await docText(reopened)).includes('\\alpha^{2}') && (await docText(reopened)).includes('\\frac{a}{b}'), await docText(reopened))
    check('Restart preserves saved Markdown byte-for-byte', fs.readFileSync(note,'utf8') === savedBeforeRestart, fs.readFileSync(note,'utf8'))
    settings = await openSettings(app,win,'en')
    await app.evaluate(({ BrowserWindow }) => {
      const floating = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=floating'))
      floating?.setContentSize(520, 730)
    })
    if (candidate) {
      await guideTab(settings).click()
      await guideTab(settings).scrollIntoViewIfNeeded()
      await settings.locator('.ls-settings .amx-publishing-editor .ProseMirror').filter({visible:true}).first().waitFor()
      check('English guide has no untranslated Chinese labels', !/[\u4e00-\u9fff]/.test(await settings.locator('.ls-settings').innerText()))
      check('Narrow guide has no horizontal overflow', await settings.locator('.ls-settings').evaluate(el => el.scrollWidth <= el.clientWidth + 1), await settings.locator('.ls-settings').evaluate(el => ({panel: el.clientWidth, scroll: el.scrollWidth})))
    }
    await settings.waitForTimeout(300)
    check('Dark English narrow actual settings window', await settings.evaluate(() => document.documentElement.dataset.mode === 'dark' && innerWidth <= 722), await settings.evaluate(() => ({ mode: document.documentElement.dataset.mode, width: innerWidth })))
    await saveShot(settings, 'settings-en-dark-narrow')
    if (candidate) {
      await settings.locator('.ls-practice').scrollIntoViewIfNeeded()
      await saveShot(settings, 'practice-en-dark-narrow')
    }
    check('No renderer pageerrors', errors.length === 0, errors)
  } catch(e) {
    check('Electron suite completed',false,String(e.stack || e))
    const page = settings && !settings.isClosed() ? settings : win
    if (page && !page.isClosed()) {
      await saveShot(page,'failure').catch(() => {})
      fs.writeFileSync(path.join(out,'failure.txt'), await page.locator('body').innerText({ timeout:2000 }).catch(()=>''))
    }
  } finally {
    if (app) await app.close().catch(() => {})
    try { stub.close() } catch {}
    fs.writeFileSync(path.join(out,'results.json'), JSON.stringify(reports,null,2))
    if (process.env.KEEP_STATE !== '1') fs.rmSync(root, { recursive: true, force: true })
    console.log('Evidence:', out)
    process.exitCode = reports.some(({passed}) => !passed) ? 1 : 0
  }
})().catch(e => { console.error(e); process.exitCode = 1 })
