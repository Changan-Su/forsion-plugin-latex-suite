#!/usr/bin/env node
// Print the default snippet library a built main.js writes into user settings, with the fingerprint
// to register in RELEASED_DEFAULTS_BY_REVISION (src/settingsUi/model.ts).
//
//   git show v1.1.2:main.js | node scripts/dump-default-snippets.mjs -
//   node scripts/dump-default-snippets.mjs main.js --out test/fixtures/default-snippets/1.1.3.txt
//
// The text comes from running the bundle: the built plugin serializes its default snippets at
// runtime, with minified function bodies. It is NOT the text vitest sees in
// DEFAULT_SETTINGS.snippetsSourceText (that one is serialized from the TypeScript source), and a
// fingerprint taken from vitest would never match what untouched users have saved.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Same 53-bit fingerprint (cyrb53 + length) as textFingerprint in src/settingsUi/model.ts. */
export function textFingerprint(text) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${text.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`
}

/**
 * Runs the bundle's module code (not setup) and reads back the default library from its settings
 * defaults and, when the bundle has one, the text "Reset to defaults" writes.
 */
export function dumpDefaultSnippets(code) {
  const footer = '\nreturn __latexSuite.setup(ctx);'
  const end = code.lastIndexOf(footer)
  if (end < 0) throw new Error('Not a LaTeX Suite main.js: the setup footer is missing.')
  const defaults = code.match(/([A-Za-z_$][\w$]*)=\{snippetsEnabled:/)?.[1]
  if (!defaults) throw new Error('Could not find the default settings object in this main.js.')
  const reset = code.match(/snippetsSource:"user",snippetsSourceText:([A-Za-z_$][\w$]*)\(\)/)?.[1]
  const body = code.slice(0, end)
  const last = body.lastIndexOf('return ')
  const probe = `globalThis.__latexSuiteDump={def:${defaults}.snippetsSourceText${reset ? `,reset:${reset}()` : ''}};`
  const saved = { window: globalThis.window, navigator: globalThis.navigator }
  globalThis.window ??= globalThis
  try {
    new Function('ctx', body.slice(0, last) + probe + body.slice(last))({})
    const { def, reset: resetText } = globalThis.__latexSuiteDump
    if (typeof def !== 'string') throw new Error('The default snippet library is not a string.')
    return { def, reset: typeof resetText === 'string' && resetText !== def ? resetText : null }
  } finally {
    delete globalThis.__latexSuiteDump
    if (saved.window === undefined) delete globalThis.window
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out')
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null
  if (!file) {
    console.error('Usage: node scripts/dump-default-snippets.mjs <main.js | -> [--out <file>]')
    process.exit(2)
  }
  const { def, reset } = dumpDefaultSnippets(readFileSync(file === '-' ? 0 : file, 'utf8'))
  console.log(`default  ${textFingerprint(def)}`)
  if (reset) console.log(`reset    ${textFingerprint(reset)}  (differs from the default; register both)`)
  if (out) {
    writeFileSync(out, def)
    if (reset) writeFileSync(out.replace(/(\.txt)?$/, '-reset.txt'), reset)
  }
}
