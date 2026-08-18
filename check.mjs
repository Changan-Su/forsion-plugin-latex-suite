// 宿主等价冒烟:用**和 Amadeus 一模一样的装载方式**跑 main.js —— `new Function('ctx', code)`,
// 而不是 import 源码。这条链上每一段都栽过人:产物里混进 import/export、忘了 return disposer、
// 用到宿主没有的 API 却没走可选链、DOM 在 node 下不存在……在这里全能当场看见。
//
// 跑法:`node check.mjs`(不需要浏览器)。红了就是插件装不上,别推。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const code = readFileSync(path.join(dir, 'main.js'), 'utf8')

// ── 极简 DOM 替身。插件在 setup 里就要注入 <style>(每个 Forsion UI 插件都会),node 下没有 document。
//    刻意不引 jsdom/happy-dom:check 的正典是「`node check.mjs` 一条命令、零依赖、随 zip 分发」。
//    够用即可 —— 真 DOM 那半归 scripts/latex-suite.e2e.cjs(真浏览器 + 真编辑器)管。
function mkEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    children: [],
    isConnected: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { el.children.push(c); c.isConnected = true; return c },
    append(...cs) { for (const c of cs) if (typeof c === 'object') el.appendChild(c) },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); c.isConnected = false; return c },
    remove() { el.isConnected = false },
    replaceChildren(...cs) { el.children = []; el.append(...cs) },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    focus() {}, blur() {}, click() {},
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  }
  return el
}
if (typeof globalThis.document === 'undefined') {
  const byId = new Map()
  globalThis.document = {
    head: mkEl('head'),
    body: mkEl('body'),
    documentElement: mkEl('html'),
    createElement: (t) => mkEl(t),
    createTextNode: (t) => ({ textContent: String(t) }),
    createDocumentFragment: () => mkEl('fragment'),
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    get activeElement() { return null },
  }
  // getElementById 要能查到 setup 注入的那个 <style>,否则重复 setup 会挂两份(真宿主里是 bug)
  const origCreate = globalThis.document.createElement
  globalThis.document.createElement = (t) => {
    const el = origCreate(t)
    Object.defineProperty(el, 'id', {
      get: () => el._id ?? '',
      set: (v) => { el._id = v; if (v) byId.set(v, el) },
    })
    return el
  }
  globalThis.window = Object.assign(globalThis.window ?? {}, {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {}, removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  })
  // node 22 的 globalThis.navigator 只有 getter,赋值会抛 —— 已经有了就别动。
}

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  | ${JSON.stringify(detail)}`}`)
  if (!cond) failed++
}

// ── 产物形态:宿主把整份文件当函数体,顶层的 import/export 会直接 SyntaxError。
ok('产物无顶层 import/export', !/^\s*(import|export)\s/m.test(code))

// ── 最小 ProseMirror 工具箱替身:只要求「能 new 出来、能记住 spec」。
class FakePlugin {
  constructor(spec) { this.spec = spec; this.props = spec.props ?? {} }
}
class FakePluginKey {
  constructor(name) { this.name = name }
}
const pm = {
  Plugin: FakePlugin,
  PluginKey: FakePluginKey,
  Selection: class {},
  TextSelection: class {},
  NodeSelection: class {},
  Decoration: { inline: () => ({}), widget: () => ({}), node: () => ({}) },
  DecorationSet: { create: () => ({}), empty: {} },
  Slice: class {},
  Fragment: class {},
  keymap: (b) => new FakePlugin({ props: { handleKeyDown: () => false }, bindings: b }),
  InputRule: class {},
  inputRules: () => new FakePlugin({}),
}

const store = new Map()
const calls = { commands: [], settings: [], settingsViews: [], editorExts: [], notifies: [] }
const ctx = {
  app: {
    getActivePage: () => 'note.md',
    notify: (m) => calls.notifies.push(m),
    readFile: async () => null,
    writeFile: async () => {},
    workFolder: () => 'LaTeX Suite',
    openFile: () => {},
    listFiles: async () => [],
    vaultRoot: () => '/tmp/vault',
    watchFile: () => () => {},
  },
  registerCommand: (c) => calls.commands.push(c),
  notify: (m) => calls.notifies.push(m),
  getLocale: () => 'zh',
  subscribeLocale: () => () => {},
  registerSetting: (d) => calls.settings.push(d),
  registerSettingsView: (d) => calls.settingsViews.push(d),
  registerEditorExtension: (f) => calls.editorExts.push(f),
  loadData: async () => store.get('data') ?? null,
  saveData: async (v) => { store.set('data', JSON.parse(JSON.stringify(v))) },
  activity: { log: () => {} },
}

let dispose
try {
  dispose = new Function('ctx', code)(ctx)
  ok('main.js 在宿主装载方式下求值通过', true)
} catch (e) {
  ok('main.js 在宿主装载方式下求值通过', false, String(e))
  process.exit(1)
}

ok('返回了 disposer', typeof dispose === 'function')
ok('注册了编辑器扩展', calls.editorExts.length > 0, calls.editorExts.length)
ok('注册了设置视图', calls.settingsViews.length > 0, calls.settingsViews.map((v) => v.id))

// ── 编辑器扩展工厂必须能在只拿到工具箱的情况下产出 ProseMirror 插件。
for (const [i, f] of calls.editorExts.entries()) {
  let out
  try {
    out = f(pm)
  } catch (e) {
    ok(`扩展工厂 #${i} 可执行`, false, String(e))
    continue
  }
  ok(`扩展工厂 #${i} 返回插件数组`, Array.isArray(out) && out.length > 0 && out.every((p) => p instanceof FakePlugin), Array.isArray(out) ? out.length : typeof out)
}

// ── 设置面板:这里**只验契约形状**,不真挂。
//    面板里嵌的是 CodeMirror 6,它要 getComputedStyle / Range / 布局测量 —— 拿假 DOM 喂它
//    是在填一个无底洞,而且填出来的绿灯什么都不证明。真挂载归 e2e(真浏览器):
//    `Forsion-Genesis/desktop && node scripts/latex-suite.e2e.cjs`。
for (const v of calls.settingsViews) {
  ok(`设置面板 ${v.id} 契约完整(id + mount)`, typeof v.id === 'string' && !!v.id && typeof v.mount === 'function')
}

try {
  dispose()
  ok('disposer 可执行且不抛', true)
} catch (e) {
  ok('disposer 可执行且不抛', false, String(e))
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
