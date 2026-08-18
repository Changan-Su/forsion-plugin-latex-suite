// 打包 src/main.ts → 单文件 main.js。
//
// 宿主用 `new Function('ctx', code)` 求值 main.js,所以产物必须是**裸语句体**:
//  - format:'iife' + globalName → 顶层是 `var __ls = (() => {…})();`,没有 import/export;
//  - footer 追一行 `return __ls.setup(ctx);` —— `ctx` 是宿主注入的函数参数(自由变量,esbuild 原样保留),
//    `return` 在 Function 体顶层合法,返回值即 disposer(宿主停用插件时调用)。
//  - CodeMirror 6 **内联进包**:它只用在设置面板里那个片段编辑器,和宿主的 ProseMirror 井水不犯河水。
//  - main.js 必须提交并与 src 同步(市场装 zip 不构建)—— 改 src 后务必重跑本脚本。
import { build } from 'esbuild'

const dev = process.argv.includes('--dev')

const out = await build({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'iife',
  globalName: '__latexSuite',
  footer: { js: 'return __latexSuite.setup(ctx);' },
  platform: 'browser',
  target: 'es2020',
  minify: !dev,
  sourcemap: false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  metafile: true,
  logLevel: 'info',
})

const bytes = out.metafile.outputs['main.js'].bytes
console.log(`built main.js (${(bytes / 1024).toFixed(0)} KB)`)
