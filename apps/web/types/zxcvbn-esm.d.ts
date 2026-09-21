/**
 * Types for the zxcvbn language packs reached by their ESM path (§202).
 *
 * `lib/__tests__/password-policy-loading.test.ts` imports
 * `@zxcvbn-ts/language-common/dist/index.esm.js` rather than the package root,
 * and that is deliberate rather than a shortcut: the package root resolves to
 * the CJS build under vitest, and the CJS build is what made the §202 bug
 * invisible for a whole deploy. The test has to reach the exact module the
 * browser gets.
 *
 * These packages ship `types` for the root only, so the deep path has no
 * declarations and `strict` rejects the import. Declaring them here is the
 * narrowest fix — it types precisely the three exports the test reads, so a
 * package that drops `translations` or renames `adjacencyGraphs` still fails
 * the build rather than silently becoming `any`.
 *
 * Deliberately NOT declared with a default export: there isn't one, and that
 * absence is the whole subject of §202. Writing `default: unknown` here would
 * re-permit the exact line that broke production.
 */

declare module '@zxcvbn-ts/language-common/dist/index.esm.js' {
  export const dictionary: Record<string, (string | number)[]>
  export const adjacencyGraphs: Record<string, unknown>
}

declare module '@zxcvbn-ts/language-en/dist/index.esm.js' {
  export const dictionary: Record<string, (string | number)[]>
  export const translations: Record<string, unknown>
}
