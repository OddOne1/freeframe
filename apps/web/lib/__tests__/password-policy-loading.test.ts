/**
 * The module shape the password meter loads, and the rule that guards it (§202).
 *
 * This file exists because §200 shipped a bug that every test in this repo was
 * structurally incapable of catching, and the shape of that blind spot matters
 * more than the bug.
 *
 * `lib/password-policy.ts` read `common.default.dictionary`.
 * `@zxcvbn-ts/language-common` has **no default export** — its ESM build ends
 * `export { adjacencyGraphs, dictionary }` — so in a browser `.default` is
 * `undefined` and `.default.dictionary` throws a TypeError. Every password
 * form in the app had a permanently disabled submit button.
 *
 * It passed CI because **vitest resolves the CJS build and webpack-style
 * interop synthesises `default = module.exports`**, which does carry
 * `.dictionary`. The test environment was kinder than production, so the code
 * under test was never the code that shipped. Writing a test that merely
 * renders the form again would have reproduced that kindness, not the bug —
 * which is why the first test below reaches for the ESM file by path and
 * asserts its real shape.
 */
import { describe, it, expect } from 'vitest'
import { buildZxcvbnOptions, resolveModuleExports } from '@/lib/password-policy'

describe('the real package shape', () => {
  it('language-common exposes named exports and NO default', async () => {
    // By explicit path, so this reads the ESM build the browser gets rather
    // than the CJS one vitest would otherwise hand back. If a future version
    // adds a default export this fails and the comment above needs revisiting
    // — which is the point.
    const ns = await import('@zxcvbn-ts/language-common/dist/index.esm.js')

    expect(ns.dictionary).toBeTruthy()
    expect(ns.adjacencyGraphs).toBeTruthy()
    // The line that broke production, stated as an assertion.
    expect((ns as { default?: unknown }).default).toBeUndefined()
  })

  it('language-en exposes dictionary and translations, and NO default', async () => {
    const ns = await import('@zxcvbn-ts/language-en/dist/index.esm.js')

    expect(ns.dictionary).toBeTruthy()
    expect(ns.translations).toBeTruthy()
    expect((ns as { default?: unknown }).default).toBeUndefined()
  })

  it('resolveModuleExports finds the dictionaries on that real namespace', async () => {
    // The fix, against the actual module rather than a hand-built stand-in.
    const ns = await import('@zxcvbn-ts/language-common/dist/index.esm.js')
    const resolved = resolveModuleExports<{ dictionary: object }>(
      ns,
      'dictionary',
      'adjacencyGraphs',
    )

    expect(resolved.dictionary).toBe(ns.dictionary)
  })
})

describe('buildZxcvbnOptions against the REAL modules', () => {
  it('produces a populated dictionary from namespaces that have no default', async () => {
    // This is the test the §202 bug needed and did not have. The four lines it
    // covers used to live inside a dynamic import, unreachable from any test,
    // and read `.default.dictionary` off a namespace that has no `.default`.
    //
    // Both namespaces below are the ESM builds by explicit path — the exact
    // objects the browser hands these lines — so reverting to `.default.`
    // fails here rather than in production.
    const commonNs = await import('@zxcvbn-ts/language-common/dist/index.esm.js')
    const enNs = await import('@zxcvbn-ts/language-en/dist/index.esm.js')

    const options = buildZxcvbnOptions(commonNs, enNs)

    expect(Object.keys(options.dictionary).length).toBeGreaterThan(0)
    // The two language packs are merged, not one silently overwriting the
    // other: `passwords` comes from common, `wikipedia` only from English.
    expect(options.dictionary.passwords).toBeTruthy()
    expect(options.dictionary.wikipedia).toBeTruthy()
    expect(options.graphs).toBeTruthy()
    expect(options.translations).toBeTruthy()
  })

  it('works equally on CJS-interop namespaces', async () => {
    // The shape vitest resolves by default, and the only one the old code
    // handled. Both have to work, because which one arrives depends on the
    // bundler rather than on anything this repo controls.
    const commonNs = await import('@zxcvbn-ts/language-common/dist/index.esm.js')
    const enNs = await import('@zxcvbn-ts/language-en/dist/index.esm.js')

    const options = buildZxcvbnOptions(
      { default: { dictionary: commonNs.dictionary, adjacencyGraphs: commonNs.adjacencyGraphs } },
      { default: { dictionary: enNs.dictionary, translations: enNs.translations } },
    )

    expect(options.dictionary.passwords).toBeTruthy()
    expect(options.graphs).toBeTruthy()
  })
})

describe('resolveModuleExports', () => {
  it('reads a true ESM namespace with no default', () => {
    const ns = { dictionary: { a: [1] }, adjacencyGraphs: {} }
    expect(resolveModuleExports(ns, 'dictionary')).toBe(ns)
  })

  it('reads a CJS-interop namespace whose exports sit under default', () => {
    // The shape vitest produces, and the only one the old code handled.
    const inner = { dictionary: { a: [1] }, adjacencyGraphs: {} }
    expect(resolveModuleExports({ default: inner }, 'dictionary')).toBe(inner)
  })

  it('prefers the namespace when BOTH carry the keys', () => {
    // A package that grows a default export alongside its named ones must not
    // silently switch which object is read.
    const inner = { dictionary: { from: 'default' } }
    const ns = { dictionary: { from: 'namespace' }, default: inner }
    expect(resolveModuleExports<typeof inner>(ns, 'dictionary')).toBe(ns)
  })

  it('requires EVERY key, not just one', () => {
    // `{dictionary}` without `adjacencyGraphs` is a half-loaded module, and
    // accepting it would put `graphs: undefined` into setOptions.
    const inner = { dictionary: {}, adjacencyGraphs: {} }
    const ns = { dictionary: {}, default: inner }
    expect(resolveModuleExports(ns, 'dictionary', 'adjacencyGraphs')).toBe(inner)
  })

  it('throws a message naming the keys and what it actually got', () => {
    // Rather than letting a TypeError surface three frames away as "cannot
    // read properties of undefined", which is exactly how long §202 took to
    // find.
    expect(() => resolveModuleExports({ nope: 1 }, 'dictionary')).toThrow(
      /missing dictionary.*got keys: nope/,
    )
  })
})
