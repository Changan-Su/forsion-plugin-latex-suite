// 设置面板的真浏览器台架。跑法(仓根):`node test/settingsUi/run.mjs`
//
// 为什么非要真浏览器:面板里那个片段编辑器是 CodeMirror 6,它要量高度、建 ResizeObserver、
// 自己往 head 注入样式 —— jsdom 下这些要么假、要么直接不动。而这一块最容易坏的三件事
// (CM 实例泄漏、debounce 落盘时序、明暗两套配色)恰恰全在这一层。
//
// 依赖:playwright-core + 一个已缓存的 chromium。两者都是「碰巧装过」的东西,不是本仓的依赖 ——
// 找不到就打印一行跳过并**以 0 退出**,绝不因此把别人的流水线挂掉。
//
// 产出:test/settingsUi/.out/ 下的三张截图(亮色 / 深色 / 深色高级页),自己看一眼比断言更值钱。
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const out = path.join(here, '.out')

const skip = (why) => {
  console.log(`SKIP  设置面板台架:${why}`)
  process.exit(0)
}

// ── 依赖探测
const require = createRequire(path.join(repo, 'package.json'))
const { build } = require('esbuild')

// 本仓不依赖 playwright —— 从别处借一个。PW_HOST 环境变量可指到任意装了 playwright-core 的 package.json。
const PW_HOSTS = [
  process.env.PW_HOST,
  '/Users/suqingyuan/Documents/Project/Forsion/Forsion-Genesis/desktop/package.json',
  path.join(repo, 'package.json'),
].filter(Boolean)
let chromium = null
for (const host of PW_HOSTS) {
  if (!existsSync(host)) continue
  try {
    chromium = createRequire(host)('playwright-core').chromium
    break
  } catch {
    /* 换下一个 */
  }
}
if (!chromium) skip('找不到 playwright-core')

mkdirSync(out, { recursive: true })
// 产物目录自己忽略自己 —— 比去改仓根 .gitignore 干净(那是公用文件)。
writeFileSync(path.join(out, '.gitignore'), '*\n')

// ── 打包台架(和真产物同一条 esbuild 链路,只是不压缩)
await build({
  entryPoints: [path.join(here, 'harness.ts')],
  outfile: path.join(out, 'harness.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  absWorkingDir: repo,
  logLevel: 'warning',
})

// 假宿主:token 摘自 Forsion-Genesis/desktop/frontend/src/styles/base.css(「经典」亮色)+ 一套夜色,
// 容器用宿主真实的 .plugin-card(padding 10/12 + --bg-card 底)。
writeFileSync(
  path.join(out, 'harness.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>LaTeX Suite 设置台架</title><style>
:root{--bg:#f8f7f6;--bg-card:#fdfdfc;--text:#1c1c1c;--text-muted:#5f5f5d;--text-faint:rgba(28,28,28,.4);
--border:#eae9e7;--border-width:1px;--accent:#1c1c1c;--accent-ink:var(--accent);--accent-light:rgba(28,28,28,.05);
--overlay-subtle:rgba(28,28,28,.03);--overlay-light:rgba(28,28,28,.04);--overlay-medium:rgba(28,28,28,.07);
--radius-sm:8px;--radius-md:11px;--danger:#a3503f;--bg-input:var(--bg-card);
--font-ui:'Hanken Grotesk',ui-sans-serif,system-ui,'PingFang SC',sans-serif;
--font-mono:ui-monospace,'SF Mono',Menlo,monospace}
html[data-dark]{--bg:#17171a;--bg-card:#1f1f23;--text:#f2efe8;--text-muted:#a8a49c;
--text-faint:rgba(242,239,232,.42);--border:#2c2c31;--accent:#e8e4dc;--accent-light:rgba(242,239,232,.08);
--overlay-subtle:rgba(242,239,232,.04);--overlay-light:rgba(242,239,232,.07);--overlay-medium:rgba(242,239,232,.11);
--danger:#e0736a}
body{margin:0;padding:24px;background:var(--bg);color:var(--text);font-family:var(--font-ui)}
.wrap{max-width:720px;margin:0 auto}
.plugin-card{background:var(--bg-card);border:1px solid var(--overlay-medium);border-radius:var(--radius-md);padding:10px 12px}
</style></head><body><div class="wrap"><div id="host" class="plugin-card"></div></div>
<script src="./harness.js"></script><script>window.H.mount()</script></body></html>`,
)

// ── 断言
let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  | ${JSON.stringify(detail)}`}`)
  if (!cond) failed++
}

const browser = await chromium.launch({ headless: true }).catch(() => null)
if (!browser) skip('chromium 启动失败(可能没下载过:npx playwright install chromium)')

const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 })
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e)))
await page.goto('file://' + path.join(out, 'harness.html'))
await page.waitForTimeout(400)

const pane = (i) => page.locator('.ls-pane').nth(i)
const rowVisible = (label) =>
  page.evaluate((l) => {
    const row = Array.from(document.querySelectorAll('.ls-row')).find((r) => r.querySelector('.ls-row-label')?.textContent === l)
    return row ? !row.hidden : null
  }, label)

// 1. 结构
ok('面板已挂载', (await page.locator('.ls-settings').count()) === 1)
ok('七个标签', (await page.locator('.ls-tab').count()) === 7, await page.locator('.ls-tab').allTextContents())
ok('默认停在片段页', (await page.locator('.ls-tab.is-active').textContent()) === '片段')
ok('CM6 已渲染', (await page.locator('.ls-cm .cm-editor').count()) === 1)
ok('CM6 有行号', (await page.locator('.ls-cm .cm-lineNumbers').count()) === 1)
ok('CM6 有语法高亮 span', (await page.locator('.ls-cm .cm-line span').count()) > 10)
ok('CM 高度封顶 ≤ 340', (await page.locator('.ls-cm .cm-editor').evaluate((el) => el.getBoundingClientRect().height)) <= 341)
ok('亮色下 color-scheme=light', (await page.locator('.ls-settings').evaluate((el) => el.style.colorScheme)) === 'light')

// 2. 联动可见性
ok('来源=user 时不显示「片段文件」行', (await rowVisible('片段文件')) === false)
await page.locator('select.ls-select').nth(1).selectOption('file')
await page.waitForTimeout(60)
ok('切到 file 后「片段文件」行出现', (await rowVisible('片段文件')) === true)
ok('切到 file 后出现「外部加载」提示', await page.locator('.ls-note').isVisible())
await page.locator('select.ls-select').nth(1).selectOption('user')
await page.waitForTimeout(60)
ok('切回 user 后提示隐藏', !(await page.locator('.ls-note').isVisible()))

// 3. 开关联动
await page.locator('.ls-tab').nth(1).click()
await page.waitForTimeout(60)
await pane(1).locator('.ls-switch').first().click()
await page.waitForTimeout(60)
ok('关掉自动分式后子行隐藏', (await rowVisible('分式命令')) === false)
ok('设置真的写下去了', (await page.evaluate(() => window.H.settings().autofractionEnabled)) === false)
await pane(1).locator('.ls-switch').first().click()
await page.waitForTimeout(60)
ok('再点回来', (await page.evaluate(() => window.H.settings().autofractionEnabled)) === true)

// 4. 文本框 debounce
await pane(1).locator('input.ls-input').first().fill('\\dfrac')
ok('打字瞬间尚未落盘', (await page.evaluate(() => window.H.settings().autofractionSymbol)) === '\\frac')
await page.waitForTimeout(420)
ok('300ms 后落盘', (await page.evaluate(() => window.H.settings().autofractionSymbol)) === '\\dfrac')

// 5. 非负整数校验
await page.locator('.ls-tab').nth(5).click()
await page.waitForTimeout(60)
await pane(5).locator('.ls-switch').first().click()
await page.waitForTimeout(60)
ok('conceal 打开后延迟行出现', (await rowVisible('还原延迟(毫秒)')) === true)
await pane(5).locator('input.ls-input--num').fill('abc')
await page.waitForTimeout(420)
ok('非法数字不落盘', (await page.evaluate(() => window.H.settings().concealRevealTimeout)) === 0)
ok('非法数字标红', (await pane(5).locator('input.ls-input--num').getAttribute('aria-invalid')) === 'true')
await pane(5).locator('input.ls-input--num').fill('300')
await page.waitForTimeout(420)
ok('合法数字落盘', (await page.evaluate(() => window.H.settings().concealRevealTimeout)) === 300)

// 6. 片段编辑器:好语法落盘 / 坏语法不落盘
await page.locator('.ls-tab').nth(0).click()
await page.waitForTimeout(80)
await page.click('.ls-cm .cm-content')
await page.keyboard.press('ControlOrMeta+a')
await page.keyboard.type('[{trigger: "aa", replacement: "\\\\alpha", options: "mA"}]')
await page.waitForTimeout(450)
ok('片段正文落盘', (await page.evaluate(() => window.H.settings().snippetsSourceText)).includes('aa'))
ok('状态显示已保存', (await page.locator('.ls-cm-status').textContent()) === '已保存')
await page.keyboard.type('{{{')
await page.waitForTimeout(450)
ok('坏语法不落盘', !(await page.evaluate(() => window.H.settings().snippetsSourceText)).includes('{{{'))
ok('状态显示语法有误', (await page.locator('.ls-cm-status').textContent()).includes('语法有误'))

// 7. 错误面板
ok('无错误时面板隐藏', !(await page.locator('.ls-errors').isVisible()))
await page.evaluate(() => window.H.setErrors(['snippets.js: 第 12 条 trigger 不合法', '读不到片段文件:LaTeX/mine.js']))
await page.waitForTimeout(80)
ok('注入错误后面板出现', await page.locator('.ls-errors').isVisible())
ok('两条错误都在', (await page.locator('.ls-errors-item').count()) === 2)
await page.evaluate(() => window.H.setErrors([]))
await page.waitForTimeout(60)
ok('错误清空后隐藏', !(await page.locator('.ls-errors').isVisible()))

// 8. 二段式确认
const resetBtn = page.locator('.ls-cm-actions button').first()
await resetBtn.click()
ok('首点变成确认态', (await resetBtn.textContent()).includes('再点一次'))
await resetBtn.click()
await page.waitForTimeout(120)
ok('二点执行重置', (await page.locator('.ls-cm .cm-content').innerText()).includes('@a'))
ok('按钮已复位', (await resetBtn.textContent()) === '恢复默认')
await resetBtn.click()
await page.locator('.ls-tab').nth(0).click()
await page.waitForTimeout(60)
ok('失焦自动复位', (await resetBtn.textContent()) === '恢复默认')

// 9. 外部回灌
await page.evaluate(() => window.H.externalSnippets('[\n  {trigger: "外部", replacement: "x"},\n]'))
await page.waitForTimeout(120)
ok('外部改动同步进编辑器(未聚焦)', (await page.locator('.ls-cm .cm-content').innerText()).includes('外部'))
await page.click('.ls-cm .cm-content')
await page.keyboard.press('ControlOrMeta+a')
await page.keyboard.type('[{trigger: "手写", replacement: "x"}]')
await page.waitForTimeout(450)
await page.evaluate(() => window.H.externalSnippets('[\n  {trigger: "抢", replacement: "y"},\n]'))
await page.waitForTimeout(150)
ok('用户正在编辑时外部不抢', (await page.locator('.ls-cm .cm-content').innerText()).includes('手写'))

// 10. 语言切换 = 整块重画,不能留下第二份 CM
await page.evaluate(() => window.H.setLocale('en'))
await page.waitForTimeout(200)
ok('切英文后标签变英文', (await page.locator('.ls-tab').allTextContents()).includes('Snippets'))
ok('切语言后只有一个面板', (await page.locator('.ls-settings').count()) === 1)
ok('切语言后只有一个 CM 实例', (await page.locator('.cm-editor').count()) === 1)
await page.evaluate(() => window.H.setLocale('zh'))
await page.waitForTimeout(200)

// 10b. 重画后标签停在原处 + 数字框红边不留残
await page.locator('.ls-tab').nth(5).click()
await page.waitForTimeout(80)
await page.evaluate(() => window.H.setLocale('en'))
await page.waitForTimeout(200)
ok('重画后仍停在原标签', (await page.locator('.ls-tab.is-active').textContent()) === 'Display')
await page.evaluate(() => window.H.setLocale('zh'))
await page.waitForTimeout(200)
await pane(5).locator('input.ls-input--num').fill('oops')
await page.waitForTimeout(420)
ok('非法值当场标红', (await pane(5).locator('input.ls-input--num').getAttribute('aria-invalid')) === 'true')
await pane(5).locator('.ls-switch').last().click() // 改别的设置 → 触发 syncAll
await page.waitForTimeout(80)
ok('走开后红边与非法值一起收回', (await pane(5).locator('input.ls-input--num').getAttribute('aria-invalid')) === null)
ok('框里恢复成真值', (await pane(5).locator('input.ls-input--num').inputValue()) === '300')
await pane(5).locator('.ls-switch').last().click()
await page.waitForTimeout(80)
await page.locator('.ls-tab').nth(0).click()
await page.waitForTimeout(80)

await page.locator('.ls-tab').nth(1).click()
await page.waitForTimeout(120)
await page.screenshot({ path: path.join(out, 'light-autofraction.png'), fullPage: true })
await page.locator('.ls-tab').nth(0).click()
await page.waitForTimeout(120)
await page.screenshot({ path: path.join(out, 'light.png'), fullPage: true })

// 11. 深色
await page.evaluate(() => {
  document.documentElement.toggleAttribute('data-dark')
  window.H.unmount()
  window.H.mount()
})
await page.waitForTimeout(300)
ok('深色下识别为 ls-dark', (await page.locator('.ls-settings.ls-dark').count()) === 1)
ok('深色下 color-scheme=dark', (await page.locator('.ls-settings').evaluate((el) => el.style.colorScheme)) === 'dark')
await page.screenshot({ path: path.join(out, 'dark.png'), fullPage: true })
await page.locator('.ls-tab').nth(6).click()
await page.waitForTimeout(120)
await page.screenshot({ path: path.join(out, 'dark-advanced.png'), fullPage: true })

// 12. 卸载干净
await page.evaluate(() => window.H.unmount())
await page.waitForTimeout(120)
ok('卸载后容器空了', (await page.evaluate(() => document.getElementById('host').childNodes.length)) === 0)
ok('卸载后没有残留 CM 实例', (await page.locator('.cm-editor').count()) === 0)
ok('样式标签随最后一次卸载移除', (await page.evaluate(() => document.querySelectorAll('style#ls-settings-css').length)) === 0)

ok('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 5))
await browser.close()
console.log(failed ? `\n${failed} 项失败(截图在 ${out})` : `\n全部通过(截图在 ${out})`)
process.exit(failed ? 1 : 0)
