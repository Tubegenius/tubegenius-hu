// Resolved by browser-targeted builds (Next.js client bundle) via the
// package.json "browser" field -- bundlers universally prefer "browser"
// over "main" when resolving a dependency into a browser/client bundle.
// Throwing at module-evaluation time turns an accidental client-side import
// of a server-only module into a hard build failure, not a silent runtime
// surprise.
throw new Error(
  'server-only-guard: this module must never be imported into client-side/browser code. ' +
    'It guards server-only modules (e.g. the human-review service-role layer) that must never reach a client bundle.'
)
