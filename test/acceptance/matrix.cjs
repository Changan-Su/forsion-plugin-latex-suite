// Real UnifiedPage + plugin bundle. Uses an isolated browser and in-memory vault.
// DESKTOP_DIR selects a Genesis checkout; PLUGIN_DIR selects a negative control.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const desktop = process.env.DESKTOP_DIR || path.resolve(__dirname, '../../../../Forsion-Genesis/desktop')
if (!process.env.LATEX_MATRIX_RUNNING) {
  const result = spawnSync(process.execPath, [path.join(desktop, 'scripts/e2e-editor.cjs'),
    '--script=' + path.relative(path.join(desktop, 'scripts'), __filename)], {
    cwd: desktop, stdio: 'inherit', env: { ...process.env, LATEX_MATRIX_RUNNING: '1',
      HARNESS_URL: process.env.HARNESS_URL || 'http://localhost:5197/harness.html' },
  })
  process.exit(result.status ?? 1)
}
const { chromium } = require(path.join(desktop, 'node_modules/playwright-core'))
const source = process.env.PLUGIN_DIR || path.resolve(__dirname, '../..')
const code = fs.readFileSync(path.join(source, 'main.js'), 'utf8')
const out = process.env.OUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'latex-matrix-'))
fs.mkdirSync(out, { recursive: true })
const reports = [], errors = []
function check(label, passed, detail) {
  reports.push({ label, passed: !!passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label} ${JSON.stringify(detail ?? '')}`)
}
function executable() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const dir of fs.readdirSync(cache).filter(n => n.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing', 'Chromium']) {
      const p = path.join(cache, dir, `chrome-mac-arm64/${app}.app/Contents/MacOS/${app}`)
      if (fs.existsSync(p)) return p
    }
  }
  return undefined // Playwright's default on other platforms.
}
async function open(browser, seed, at) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 850 } })
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${process.env.HARNESS_URL}?upage&useed=${encodeURIComponent(seed)}`)
  await page.waitForSelector('.unified-body .ProseMirror')
  await page.evaluate(c => window.__ep.loadPlugin(c, { id: 'latex-suite' }), code)
  await page.waitForTimeout(500)
  await page.evaluate(needle => {
    const view = window.__upage.probe.view()
    let target
    view.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return
      const text = node.textBetween(0, node.content.size, '\n', '\n')
      const offset = text.indexOf(needle)
      if (offset !== -1 && target == null) target = pos + 1 + offset + needle.length
    })
    if (target == null) throw new Error('Caret anchor missing: ' + needle)
    const Selection = view.state.selection.constructor
    view.dispatch(view.state.tr.setSelection(Selection.create(view.state.doc, target)))
    view.focus()
  }, at)
  return page
}
const snapshot = page => page.evaluate(() => {
  const view = window.__upage.probe.view(), { $from } = view.state.selection
  return { text: view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n'),
    offset: $from.parentOffset, before: $from.parent.textBetween(0, $from.parentOffset, '\n', '\n'),
    breaks: view.state.doc.toJSON(), focused: view.hasFocus() }
})
async function main() {
  const browser = await chromium.launch({ executablePath: executable(), headless: true })
  try {
    let p = await open(browser, '$$\n\\begin{align}\na\n\\end{align}\n$$\n', '\\begin{align}\na')
    await p.keyboard.press('Tab')
    let s = await snapshot(p)
    check('Tab inserts an alignment column in a loaded multiline environment', s.before.endsWith('a & '), s.before)
    await p.keyboard.type('b')
    await p.keyboard.press('Enter')
    s = await snapshot(p)
    check('Enter inserts two backslashes and moves onto a new source line', s.before.endsWith('a & b \\\\\n'), s.before)
    await p.keyboard.press('Tab')
    s = await snapshot(p)
    check('Tab still adds a column on the new line', s.before.endsWith('\n & '), s.before)
    await p.keyboard.type('c')
    await p.waitForTimeout(1200)
    const saved = await p.evaluate(() => window.__upage.writes.at(-1)?.text || '')
    check('Saved Markdown keeps the row separator and real newline', /a & b \\\\\n(?: |&#x20;)& c/.test(saved), saved)
    await p.locator('.unified-body .ProseMirror').screenshot({ path: path.join(out, 'align.png') })
    await p.close()
    p = await open(browser, saved, '& c')
    s = await snapshot(p)
    check('Reloaded Markdown retains the multiline alignment', s.before.endsWith('a & b \\\\\n & c'), s.before)
    await p.close()

    p = await open(browser, '$$  $$\n', '$$ ')
    await p.keyboard.type('align', { delay: 45 })
    await p.keyboard.type('a')
    await p.keyboard.press('Tab')
    s = await snapshot(p)
    check('First Tab after the align snippet inserts & without a dead key', s.before.endsWith('a & '), s.before)
    await p.keyboard.type('b')
    await p.keyboard.press('Enter')
    s = await snapshot(p)
    check('Snippet-created align also gets a real newline', s.before.endsWith('a & b \\\\\n'), s.before)
    await p.keyboard.type('alpha', { delay: 45 })
    s = await snapshot(p)
    check('Greek expansion still works at the beginning of the new row', s.before.endsWith('\n\\alpha'), s.before)
    await p.close()

    p = await open(browser, '$$\n\\begin{align}\na\nb)\n\\end{align}\n$$\n', '\\begin{align}\na')
    await p.keyboard.press('Tab')
    s = await snapshot(p)
    check('A closing bracket on a later row cannot steal Tab from this row', s.before.endsWith('a & '), s.before)
    await p.close()

    p = await open(browser, '$\\begin{pmatrix}a\\end{pmatrix}$\n', '\\begin{pmatrix}a')
    await p.keyboard.press('Enter')
    s = await snapshot(p)
    check('Inline matrices remain on one source line', !s.text.includes('\n') && s.before.endsWith('a \\\\ '), s.before)
    await p.close()
    check('No renderer pageerrors', errors.length === 0, errors)
  } finally {
    await browser.close()
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(reports, null, 2))
    console.log('Evidence:', out)
  }
  process.exitCode = reports.some(r => !r.passed) ? 1 : 0
}
main().catch(e => { console.error(e); process.exitCode = 1 })
