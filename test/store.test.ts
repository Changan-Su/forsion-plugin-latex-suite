import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginContext } from '../types/forsion'
import { createStore, type Store } from '../src/store'
import { DEFAULT_SETTINGS, DEFAULTS_REVISION, DEFAULTS_REVISION_KEY, migrateDefaultSnippetsWith, savedDefaultsRevision, textFingerprint, type LatexSuiteSettings } from '../src/settingsUi/model'
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

describe('released default snippet libraries are upgraded on load', () => {
  const fixture = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/default-snippets/1.0.0.txt'), 'utf8')
  const others: Partial<LatexSuiteSettings> = { proseSnippetsEnabled: false, wordDelimiters: '., ', snippetRecursion: 7, concealEnabled: true }
  const dmTriggers = (store: Store): string[] => store.snippets().filter((s) => s.trigger instanceof RegExp && s.trigger.source.includes('dm')).map((s) => (s.trigger as RegExp).source)

  it('a library equal to a released default becomes the new default; other settings stay; nothing is written', async () => {
    const h = harness({ ...others, snippetsSourceText: fixture })
    const store = h.start()
    await flush()
    expect(store.ready()).toBe(true)
    expect(store.settings().snippetsSourceText).not.toBe(fixture)
    expect(store.settings()).toMatchObject(others)
    expect(dmTriggers(store).some((t) => t.includes('(\\S\\s+)dm'))).toBe(true)
    expect(dmTriggers(store).some((t) => t.includes('(\\S\\s*)dm'))).toBe(false)
    expect(h.ctx.saveData).not.toHaveBeenCalled()
  })

  it('a last-good backup that is a released default is upgraded too', async () => {
    const h = harness({ snippetsSourceText: '[{trigger: "broken"', latexSuiteLastGood: { version: 1, snippetsSourceText: fixture, snippetVariablesSourceText: '{}' } } as never)
    const store = h.start()
    await flush()
    expect(dmTriggers(store).some((t) => t.includes('(\\S\\s+)dm'))).toBe(true)
    expect(dmTriggers(store).some((t) => t.includes('(\\S\\s*)dm'))).toBe(false)
    expect(h.ctx.saveData).not.toHaveBeenCalled()
  })

  it('an edited library is kept as written', async () => {
    const edited = fixture.replace('description: "Display math when in a list"', 'description: "My list math"')
    expect(edited).not.toBe(fixture)
    const h = harness({ ...others, snippetsSourceText: edited })
    const store = h.start()
    await flush()
    expect(store.settings().snippetsSourceText).toBe(edited)
    expect(dmTriggers(store).some((t) => t.includes('(\\S\\s*)dm'))).toBe(true)
  })

  it('unreadable or invalid saved settings are not migrated or written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const fail of [() => Promise.reject(new Error('disk unavailable')), async () => [fixture], async () => 'garbage']) {
      const h = harness({ snippetsSourceText: fixture })
      h.ctx.loadData.mockImplementationOnce(fail as never)
      const store = h.start()
      await flush()
      expect(store.ready()).toBe(false)
      expect(store.snippets()).toEqual([])
      expect(h.ctx.saveData).not.toHaveBeenCalled()
    }
  })
})

describe('the default library migration happens only once', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/default-snippets')
  const v100 = readFileSync(path.join(dir, '1.0.0.txt'), 'utf8')
  const v11x = readFileSync(path.join(dir, '1.1.0-1.1.2.txt'), 'utf8')
  type Saved = Record<string, unknown>
  const lastSaved = (h: ReturnType<typeof harness>): Saved => JSON.parse(JSON.stringify(h.ctx.saveData.mock.calls.at(-1)![0])) as Saved
  const boot = async (saved: Saved | null) => {
    const h = harness(saved as never)
    const store = h.start()
    await flush()
    return { h, store }
  }

  it('an old 1.0.0 default is migrated once and the next save carries the revision', async () => {
    const a = await boot({ snippetsSourceText: v100, concealEnabled: true })
    expect(a.store.settings().snippetsSourceText).toBe(DEFAULT_SETTINGS.snippetsSourceText)
    expect(a.h.ctx.saveData).not.toHaveBeenCalled()
    a.store.update({ concealEnabled: false })
    await flush()
    const saved = lastSaved(a.h)
    expect(saved[DEFAULTS_REVISION_KEY]).toBe(DEFAULTS_REVISION)
    expect(saved.snippetsSourceText).toBe(DEFAULT_SETTINGS.snippetsSourceText)
    const b = await boot(saved)
    expect(b.store.settings().snippetsSourceText).toBe(DEFAULT_SETTINGS.snippetsSourceText)
  })

  it('a library set back to a released default after upgrading stays on restart and on the next save', async () => {
    for (const old of [v100, v11x]) {
      const a = await boot({ snippetsSourceText: DEFAULT_SETTINGS.snippetsSourceText })
      a.store.update({ snippetsSourceText: old })
      await flush()
      const s1 = lastSaved(a.h)
      expect(s1.snippetsSourceText).toBe(old)
      expect(s1[DEFAULTS_REVISION_KEY]).toBe(DEFAULTS_REVISION)
      const b = await boot(s1)
      expect(b.store.settings().snippetsSourceText).toBe(old)
      b.store.update({ concealEnabled: true })
      await flush()
      const s2 = lastSaved(b.h)
      expect(s2.snippetsSourceText).toBe(old)
      expect((s2.latexSuiteLastGood as Saved).snippetsSourceText).toBe(old)
      expect(s2[DEFAULTS_REVISION_KEY]).toBe(DEFAULTS_REVISION)
    }
  })

  it('a library or backup saved with a revision is never replaced', async () => {
    const main = await boot({ snippetsSourceText: v11x, [DEFAULTS_REVISION_KEY]: DEFAULTS_REVISION })
    expect(main.store.settings().snippetsSourceText).toBe(v11x)
    const backup = await boot({
      snippetsSourceText: '[{trigger: "broken"',
      latexSuiteLastGood: { version: 1, snippetsSourceText: v11x, snippetVariablesSourceText: '{}' },
      [DEFAULTS_REVISION_KEY]: DEFAULTS_REVISION,
    })
    expect(backup.store.snippets().some((s) => s.trigger instanceof RegExp && s.trigger.source.includes('(\\S\\s*)dm'))).toBe(true)
    backup.store.update({ concealEnabled: true })
    await flush()
    const saved = lastSaved(backup.h)
    expect(saved.snippetsSourceText).toBe('[{trigger: "broken"')
    expect((saved.latexSuiteLastGood as Saved).snippetsSourceText).toBe(v11x)
  })

  it('a revision it cannot read counts as unknown: nothing is migrated', async () => {
    const { store } = await boot({ snippetsSourceText: v11x, [DEFAULTS_REVISION_KEY]: 'x' })
    expect(store.settings().snippetsSourceText).toBe(v11x)
  })

  it('edits made before the saved settings arrive are kept as typed, not migrated', async () => {
    const h = harness()
    const saved = deferred<Partial<LatexSuiteSettings> | null>()
    h.ctx.loadData.mockImplementation(() => saved.promise)
    const store = h.start()
    store.update({ snippetsSourceText: v11x })
    saved.resolve({ snippetsSourceText: v100 } as never)
    await flush()
    expect(store.settings().snippetsSourceText).toBe(v11x)
    const written = h.ctx.saveData.mock.calls.at(-1)![0] as Saved
    expect(written.snippetsSourceText).toBe(v11x)
    expect(written[DEFAULTS_REVISION_KEY]).toBe(DEFAULTS_REVISION)
  })

  // C4:下一版(修订号 2)里有意把片段库设成本版缺省原文;回退到本版改个设置;再升级到下一版。
  it('a newer revision read from disk is written back, so the next release keeps a library set on purpose', async () => {
    const next = { revision: 2, tables: { 0: { [textFingerprint(v11x)]: '1.1.0 - 1.1.2' }, 1: { [textFingerprint(DEFAULT_SETTINGS.snippetsSourceText)]: 'this release' } }, current: 'NEXT' }
    const fromNext: Saved = {
      snippetsSourceText: DEFAULT_SETTINGS.snippetsSourceText,
      latexSuiteLastGood: { version: 1, snippetsSourceText: DEFAULT_SETTINGS.snippetsSourceText, snippetVariablesSourceText: '{}' },
      [DEFAULTS_REVISION_KEY]: 2,
    }
    const upgrade = (saved: Saved) => [saved.snippetsSourceText as string, (saved.latexSuiteLastGood as Saved).snippetsSourceText as string]
      .map((text) => migrateDefaultSnippetsWith(text, savedDefaultsRevision(saved), next))
    // C4':回退的那次没存盘,文件原样,再升级不动。
    expect(upgrade(fromNext)).toEqual([DEFAULT_SETTINGS.snippetsSourceText, DEFAULT_SETTINGS.snippetsSourceText])
    const back = await boot(fromNext)
    back.store.update({ concealEnabled: true })
    await flush()
    const saved = lastSaved(back.h)
    expect(saved[DEFAULTS_REVISION_KEY]).toBe(2)
    expect(upgrade(saved)).toEqual([DEFAULT_SETTINGS.snippetsSourceText, DEFAULT_SETTINGS.snippetsSourceText])
  })

  it('a revision it cannot read is written back as it was', async () => {
    for (const odd of ['1', 1.5, -1, null, true, {}, []]) {
      const { h, store } = await boot({ snippetsSourceText: v11x, [DEFAULTS_REVISION_KEY]: odd })
      expect(store.settings().snippetsSourceText).toBe(v11x)
      store.update({ concealEnabled: true })
      await flush()
      const saved = lastSaved(h)
      expect(saved[DEFAULTS_REVISION_KEY]).toEqual(odd)
      expect(saved.snippetsSourceText).toBe(v11x)
    }
  })

  it('a failed read neither migrates nor writes, and a later successful read still migrates', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness({ snippetsSourceText: v100 } as never)
    h.ctx.loadData.mockRejectedValueOnce(new Error('disk unavailable'))
    const store = h.start()
    await flush()
    store.update({ concealEnabled: true })
    await flush()
    expect(h.ctx.saveData).not.toHaveBeenCalled()
    await store.reload()
    await flush()
    expect(store.settings().snippetsSourceText).toBe(DEFAULT_SETTINGS.snippetsSourceText)
    const written = h.ctx.saveData.mock.calls.at(-1)![0] as Saved
    expect(written).toMatchObject({ concealEnabled: true, snippetsSourceText: DEFAULT_SETTINGS.snippetsSourceText, [DEFAULTS_REVISION_KEY]: DEFAULTS_REVISION })
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
    expect(store.settings().proseSnippetsEnabled).toBe(true)
    expect(store.settings().mathPreviewEnabled).toBe(false)
  })
})
