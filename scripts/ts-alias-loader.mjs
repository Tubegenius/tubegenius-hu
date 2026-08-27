// PFM Supervised Production Candidate Intake v0 -- minimal Node.js core-only
// ESM loader hook that lets the operator CLI (supervised-intake-runner.ts)
// import the app's existing TypeScript source tree directly via plain
// `node`, without a bundler and without any new npm dependency.
//
// Node's native TypeScript support (available unflagged on this project's
// pinned Node version) already strips type syntax; what it does NOT do is
// bundler-style module resolution -- the app's tsconfig.json uses
// "moduleResolution": "bundler" (Next.js/webpack semantics: extension-less
// relative imports like `./digest`, and the `@/*` path alias), which plain
// Node ESM resolution does not understand on its own (Node ESM requires an
// explicit file extension and has no path-alias concept). This hook adds
// exactly those two things back, using only node:module's supported
// `register()` customization API -- no dependency, no download, no bundler.
//
// Registered from scripts/supervised-intake-runner.ts BEFORE that file's
// own dynamic import of the real orchestration module -- see that file's
// header comment for why the registration must happen from a physically
// separate bootstrap step.
import { pathToFileURL } from 'node:url'

const PROJECT_ROOT = pathToFileURL(process.cwd() + '/').href
const CANDIDATE_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.mjs', '/index.js']

export async function resolve(specifier, context, nextResolve) {
  let target = specifier
  if (specifier.startsWith('@/')) {
    target = new URL(specifier.slice(2), PROJECT_ROOT).href
    // Defense in depth (section 9): every real call site in this closed
    // source tree only ever writes a plain, traversal-free `@/...`
    // specifier, so this can never fire in practice today -- but nothing
    // in URL resolution itself stops a `@/../../outside` specifier from
    // resolving past PROJECT_ROOT, so this hook must refuse to hand
    // Node's own resolver a target outside the project root rather than
    // silently loading whatever that path happens to be.
    if (!target.startsWith(PROJECT_ROOT)) {
      throw new Error(`ts-alias-loader: refusing to resolve "${specifier}" outside the project root`)
    }
  }

  try {
    return await nextResolve(target, context)
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err
  }

  // Extension-less relative/alias-resolved specifier: probe the same
  // extension list Next.js/TypeScript's "bundler" resolution would, in
  // order, delegating the actual existence check to Node's own resolver
  // (nextResolve) rather than duplicating filesystem logic here.
  let lastError
  for (const ext of CANDIDATE_EXTENSIONS) {
    try {
      return await nextResolve(target + ext, context)
    } catch (err) {
      if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err
      lastError = err
    }
  }

  throw lastError
}
