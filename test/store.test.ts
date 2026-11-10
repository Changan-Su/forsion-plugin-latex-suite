import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginContext } from '../types/forsion'
import { createStore, type Store } from '../src/store'
import type { LatexSuiteSettings } from '../src/settingsUi/model'
import { matchSnippet } from '../src/snippets/model'

const source = (trigger: string, replacement = trigger): string => JSON.stringify([{ trigger, replacement, options: 'mA' }])
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async (): Promise<void> => { for (let i = 0; i < 15; i++) await Promise.resolve() }
const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); vi.restoreAllMocks() })
function harness(saved: Partial<LatexSuiteSettings> | null = { snippetsSourceText: source('old') }) {
  const files = new Map<string, string>()
  const watches = new Map<string, () => void>()
  let vaultListener: ((events: { kind: string; path?: string; from?: string; folder?: boolean }[]) => void) | undefined
  const ctx = {
    getLocale: () => 'en',
    loadData: vi.fn(async () => saved),
    saveData: vi.fn(async (_data: unknown) => {}),
    app: {
      readFile: vi.fn(async (path: string) => files.get(path) ?? null),
      listFiles: vi.fn(async () => [...files.keys()]),
      watchFile: vi.fn((path: string, cb: () => void) => { watches.set(path, cb); return () => { watches.delete(path) } }),
    },
  }
  const start = (): Store => { const store = createStore(ctx as unknown as PluginContext); stores.push(store); return store }
  const enableVaultEvents = (): void => {
    Object.assign(ctx.app, { onVaultEvent: (cb: typeof vaultListener) => { vaultListener = cb; return () => { vaultListener = undefined } } })
  }
  return { ctx, files, watches, start, enableVaultEvents, event: (events: Parameters<NonNullable<typeof vaultListener>>[0]) => vaultListener?.(events) }
}

describe('settings initialization and persistence', () => {
  it('does not expose default snippets before saved disabled settings arrive', async () => {
    const h = harness()
    const saved = deferred<Partial<LatexSuiteSettings> | null>()
    h.ctx.loadData.mockImplementation(() => saved.promise)
    const store = h.start()
    expect(store.ready()).toBe(false)
    expect(store.snippets()).toEqual([])
    saved.resolve({ snippetsEnabled: false })
    await flush()
    expect(store.ready()).toBe(true)
    expect(store.settings().snippetsEnabled).toBe(false)
    expect(store.snippets()).toEqual([])
  })

  it('load failure remains inactive and cannot overwrite unknown saved settings; reload retries', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness({ snippetsEnabled: false, mathPreviewEnabled: true })
    h.ctx.loadData.mockRejectedValueOnce(new Error('disk unavailable'))
    const store = h.start()
    await flush()
    expect(store.ready()).toBe(false)
    store.update({ proseSnippetsEnabled: true })
    await flush()
    expect(h.ctx.saveData).not.toHaveBeenCalled()
    expect(store.errors().join(' ')).toContain('could not be read')
    await store.reload()
    expect(store.ready()).toBe(true)
    expect(store.settings()).toMatchObject({ snippetsEnabled: false, mathPreviewEnabled: true, proseSnippetsEnabled: true })
    await flush()
    expect(h.ctx.saveData).toHaveBeenCalled()
    expect(h.ctx.saveData.mock.calls.at(-1)![0]).toMatchObject({ proseSnippetsEnabled: true, snippetsEnabled: false })
  })

  it('startup edits persist even when a file event supersedes the initializing reload', async () => {
    const h = harness()
    h.enableVaultEvents()
    const saved = deferred<Partial<LatexSuiteSettings> | null>()
    const initialRead = deferred<string | null>()
    h.ctx.loadData.mockImplementation(() => saved.promise)
    h.ctx.app.readFile.mockImplementationOnce(() => initialRead.promise)
    h.files.set('snippets.js', source('new'))
    const store = h.start()
    store.update({ proseSnippetsEnabled: true })
    saved.resolve({ snippetsSource: 'file', snippetsFile: 'snippets.js' })
    await flush()
    h.event([{ kind: 'modify', path: 'snippets.js' }])
    await flush()
    initialRead.resolve(source('stale'))
    await flush()
    expect(store.snippets()[0].trigger).toBe('new')
    expect(h.ctx.saveData).toHaveBeenCalled()
    const persisted = h.ctx.saveData.mock.calls.at(-1)![0] as Partial<LatexSuiteSettings>
    expect(persisted.proseSnippetsEnabled).toBe(true)
    store.dispose()
    const restarted = harness(persisted).start()
    await flush()
    expect(restarted.settings().proseSnippetsEnabled).toBe(true)
  })

  it('queues saves so a slow previous write cannot overwrite the newest setting', async () => {
    const h = harness()
    const store = h.start()
    await flush()
    const first = deferred<void>()
    h.ctx.saveData.mockImplementationOnce(() => first.promise)
    store.update({ proseSnippetsEnabled: true })
    await flush()
    store.update({ proseSnippetsEnabled: false })
    await flush()
    expect(h.ctx.saveData).toHaveBeenCalledTimes(1)
    first.resolve()
    await flush()
    expect(h.ctx.saveData).toHaveBeenCalledTimes(2)
    expect(h.ctx.saveData.mock.calls.map(([value]) => (value as LatexSuiteSettings).proseSnippetsEnabled)).toEqual([true, false])
  })

  it('drains already queued UI writes after disposal without accepting new changes', async () => {
    const h = harness()
    const store = h.start()
    await flush()
    const first = deferred<void>()
    h.ctx.saveData.mockImplementationOnce(() => first.promise)
    store.update({ proseSnippetsEnabled: true })
    await flush()
    store.update({ proseSnippetsEnabled: false })
    store.dispose()
    store.update({ proseSnippetsEnabled: true })
    first.resolve()
    await flush()
    expect(h.ctx.saveData.mock.calls.map(([value]) => (value as LatexSuiteSettings).proseSnippetsEnabled)).toEqual([true, false])
  })

  it('writes the newly validated library as last-good metadata and keeps it on later errors', async () => {
    const h = harness({ snippetsSourceText: source('old'), snippetVariablesSourceText: '{}' })
    const store = h.start()
    await flush()
    expect(h.ctx.saveData).not.toHaveBeenCalled()
    const successful = source('current')
    store.update({ snippetsSourceText: successful, snippetVariablesSourceText: '{"${CUSTOM}":"new"}' })
    await flush()
    const latest = () => h.ctx.saveData.mock.calls.at(-1)![0] as LatexSuiteSettings & {
      latexSuiteLastGood: { version: number; snippetsSourceText: string; snippetVariablesSourceText: string }
    }
    expect(latest().latexSuiteLastGood).toEqual({
      version: 1, snippetsSourceText: successful, snippetVariablesSourceText: '{"${CUSTOM}":"new"}',
    })
    store.update({ snippetsSourceText: '[broken' })
    await flush()
    expect(latest().snippetsSourceText).toBe('[broken')
    expect(latest().latexSuiteLastGood.snippetsSourceText).toBe(successful)
    const count = h.ctx.saveData.mock.calls.length
    await store.reload()
    await flush()
    expect(h.ctx.saveData).toHaveBeenCalledTimes(count)
  })
})

describe('working snippet library and reload races', () => {
  it('retains the last working library across malformed edits and missing files, then recovers', async () => {
    const h = harness()
    const store = h.start()
    await flush()
    expect(store.snippets()[0].trigger).toBe('old')
    store.update({ snippetsSourceText: '[{ invalid' })
    await flush()
    expect(store.snippets()[0].trigger).toBe('old')
    expect(store.errors().length).toBeGreaterThan(0)
    store.update({ snippetsSource: 'file', snippetsFile: 'missing.js' })
    await flush()
    expect(store.snippets()[0].trigger).toBe('old')
    expect(store.errors()[0]).toContain('missing.js')
    h.files.set('missing.js', source('new'))
    await store.reload()
    expect(store.snippets()[0].trigger).toBe('new')
    expect(store.errors()).toEqual([])
  })

  it('empty explicit libraries stay empty instead of silently enabling defaults', async () => {
    const h = harness({ snippetsSourceText: '[]' })
    const store = h.start()
    await flush()
    expect(store.snippets()).toEqual([])
    expect(store.errors()).toEqual([])
  })

  it('preserves an invalid draft and the last valid embedded library across restart', async () => {
    const h = harness({ snippetsSourceText: source('working'), snippetVariablesSourceText: '{}' })
    const store = h.start()
    await flush()
    store.update({ snippetsSourceText: '[broken draft' })
    await flush()
    const saved = h.ctx.saveData.mock.calls.at(-1)![0] as Partial<LatexSuiteSettings>
    expect(saved.snippetsSourceText).toBe('[broken draft')
    store.dispose()
    const restarted = harness(saved).start()
    await flush()
    expect(restarted.settings().snippetsSourceText).toBe('[broken draft')
    expect(restarted.snippets()[0].trigger).toBe('working')
    expect(restarted.errors().length).toBeGreaterThan(0)
  })

  it('never replays embedded backup rules for an external file source', async () => {
    const h = harness({ snippetsSourceText: source('working'), snippetVariablesSourceText: '{}' })
    const store = h.start()
    await flush()
    store.update({ snippetsSource: 'file', snippetsFile: 'missing.js' })
    await flush()
    const saved = h.ctx.saveData.mock.calls.at(-1)![0] as Partial<LatexSuiteSettings>
    store.dispose()
    const restarted = harness(saved).start()
    await flush()
    expect(restarted.snippets()).toEqual([])
    expect(restarted.errors()[0]).toContain('missing.js')
  })

  it('a late file response cannot replace a more recent source', async () => {
    const h = harness()
    const store = h.start()
    await flush()
    const oldRead = deferred<string | null>()
    h.ctx.app.readFile.mockImplementationOnce(() => oldRead.promise)
    store.update({ snippetsSource: 'file', snippetsFile: 'slow.js' })
    await flush()
    store.update({ snippetsSource: 'user', snippetsSourceText: source('new') })
    await flush()
    oldRead.resolve(source('stale'))
    await flush()
    expect(store.snippets()[0].trigger).toBe('new')
  })

  it('a broken file cannot activate a half-updated folder library', async () => {
    const h = harness()
    const store = h.start()
    await flush()
    h.files.set('snips/a.js', source('new'))
    h.files.set('snips/b.json', 'not json')
    store.update({ snippetsSource: 'folder', snippetsFolder: 'snips' })
    await flush()
    expect(store.snippets()[0].trigger).toBe('old')
    expect(store.errors()[0]).toContain('snips/b.json')
    h.files.set('snips/b.json', source('second'))
    await store.reload()
    expect(store.snippets().map((s) => s.trigger).sort()).toEqual(['new', 'second'])
  })

  it('disposal prevents late activation and removes file watchers', async () => {
    const h = harness({ snippetsSource: 'file', snippetsFile: 'slow.js' })
    const read = deferred<string | null>()
    h.ctx.app.readFile.mockImplementationOnce(() => read.promise)
    const store = h.start()
    await flush()
    expect(h.watches.has('slow.js')).toBe(true)
    const listener = vi.fn()
    store.subscribe(listener)
    store.dispose()
    read.resolve(source('late'))
    await flush()
    expect(store.ready()).toBe(false)
    expect(store.snippets()).toEqual([])
    expect(h.watches.size).toBe(0)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('variables and external file events', () => {
  const variableSnippet = JSON.stringify([{ trigger: '${CUSTOM}', replacement: 'yes', options: 'mA' }])
  it('edits to variable text recompile triggers and invalid variables keep the working library', async () => {
    const h = harness({ snippetsSourceText: variableSnippet, snippetVariablesSourceText: '{"${CUSTOM}":"first"}' })
    const store = h.start()
    await flush()
    expect(matchSnippet(store.snippets()[0], 'first', '')?.insert).toBe('yes')
    store.update({ snippetVariablesSourceText: '{"${CUSTOM}":"second"}' })
    await flush()
    expect(matchSnippet(store.snippets()[0], 'second', '')?.insert).toBe('yes')
    store.update({ snippetVariablesSourceText: '{"${CUSTOM}":123}' })
    await flush()
    expect(matchSnippet(store.snippets()[0], 'second', '')?.insert).toBe('yes')
    expect(store.errors()[0]).toContain('must be a string')
  })

  it('variable file changes reload their contents, including legacy JS object literals', async () => {
    const h = harness({ snippetsSourceText: variableSnippet, loadSnippetVariablesFromFile: true, snippetVariablesFileLocation: 'vars.js' })
    h.files.set('vars.js', "{'${CUSTOM}':'first'}")
    const store = h.start()
    await flush()
    expect(store.snippets()[0].trigger).toBe('first')
    h.files.set('vars.js', "{'${CUSTOM}':'second'}")
    h.watches.get('vars.js')!()
    await flush()
    expect(store.snippets()[0].trigger).toBe('second')
  })

  it('an old variable file response cannot overwrite newer inline variables', async () => {
    const h = harness({ snippetsSourceText: variableSnippet, snippetVariablesSourceText: '{"${CUSTOM}":"first"}' })
    const store = h.start()
    await flush()
    const slow = deferred<string | null>()
    h.ctx.app.readFile.mockImplementationOnce(() => slow.promise)
    store.update({ loadSnippetVariablesFromFile: true, snippetVariablesFileLocation: 'slow.json' })
    await flush()
    store.update({ loadSnippetVariablesFromFile: false, snippetVariablesSourceText: '{"${CUSTOM}":"current"}' })
    await flush()
    slow.resolve('{"${CUSTOM}":"stale"}')
    await flush()
    expect(store.snippets()[0].trigger).toBe('current')
  })

  it('older hosts watch enumerated files and discover additions only on reload', async () => {
    const h = harness({ snippetsSource: 'folder', snippetsFolder: 'snips' })
    h.files.set('snips/a.js', source('a'))
    const store = h.start()
    await flush()
    expect(store.watchMode()).toBe('existing-files')
    expect([...h.watches.keys()]).toEqual(['snips/a.js'])
    h.files.set('snips/b.js', source('b'))
    await store.reload()
    expect([...h.watches.keys()].sort()).toEqual(['snips/a.js', 'snips/b.js'])
    h.files.set('snips/a.js', source('updated'))
    h.watches.get('snips/a.js')!()
    await flush()
    expect(store.snippets().map((s) => s.trigger)).toContain('updated')
  })

  it('vault events refresh folder membership and clear foreign rules when switching vaults', async () => {
    const h = harness({ snippetsSource: 'folder', snippetsFolder: 'snips' })
    h.enableVaultEvents()
    h.files.set('snips/a.js', source('a'))
    const store = h.start()
    await flush()
    expect(store.watchMode()).toBe('live')
    h.files.set('snips/b.js', source('b'))
    h.event([{ kind: 'create', path: 'snips/b.js' }])
    await flush()
    expect(store.snippets().map((s) => s.trigger).sort()).toEqual(['a', 'b'])
    h.files.clear()
    h.event([{ kind: 'vault' }])
    expect(store.snippets()).toEqual([])
    await flush()
    expect(store.snippets()).toEqual([])
    expect(store.errors().length).toBeGreaterThan(0)
  })

  it('missing watcher APIs are honestly reported as manual', async () => {
    const h = harness({ snippetsSource: 'file', snippetsFile: 'snips.js' })
    h.files.set('snips.js', source('a'))
    delete (h.ctx.app as Partial<typeof h.ctx.app>).watchFile
    const store = h.start()
    await flush()
    expect(store.watchMode()).toBe('manual')
    expect(store.settings().proseSnippetsEnabled).toBe(false)
    expect(store.settings().mathPreviewEnabled).toBe(false)
  })
})
