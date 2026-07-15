# Modernization & Compatibility Review

Snapshot of the project's state (last substantive commit: Dec 2020) and a
prioritized, honest plan for bringing it up to today's standards. The AI subtitle
translation feature added alongside this review already follows current
practices (native `fetch`, `async/await`, typed errors, an OpenAI-compatible
API) and deliberately does **not** depend on the project's discontinued
server-side translation backend.

> Note on scope: the large framework upgrades below are intentionally **not**
> applied in this change. Applying them blind would very likely break the app.
> They are documented here so they can be done deliberately, one at a time,
> against a green build.

## The build does work — on a pinned toolchain

An earlier version of this document assumed the app could not be built on a
modern machine. It can, and the loop below is green (lint + 230 unit tests +
`build.js` + a launchable `.app`) on macOS 26 / Apple Silicon:

- **Node 12.22.12 x64, run under Rosetta 2.** Node 12 has no arm64 darwin build,
  and both `node-sass@4` (needs the `darwin-x64-72` binding) and the
  `@chiflix/electron@7.3.3` fork are x64-only. The produced app is x64 and runs
  under Rosetta 2.
- **`CI=true`**, so `scripts/post-install.js` skips `install-app-deps`; the
  native rebuild needs Python 2, which macOS no longer ships.
- `@splayer/osx-mouse-cocoa` fails to compile for the same reason. It is an
  **optional** dependency and the install is unaffected.
- **DMG packaging is the one broken step**: `electron-builder`'s dmg target
  shells out to `/usr/bin/python` (Python 2). The `.app` itself packages fine —
  wrap it with `hdiutil` instead.

Two gotchas worth knowing before touching `src/**/*.ts`:

- **`?.` and `??` do not compile.** `tsconfig` targets `esnext` and `.ts` goes
  through ts-loader alone, so the syntax reaches webpack 4 (acorn 6) untouched
  and fails with `Module parse failed: Unexpected token`. Use explicit
  `=== undefined` checks.
- **`tsconfig` includes `test/**/*`** with `noImplicitAny`, so a `.ts` spec is
  strictly typechecked. All specs are `.js` for this reason.

## Environment mismatch (highest priority)

| Item | Pinned | Today | Impact |
| ---- | ------ | ----- | ------ |
| Node (`engines`, CI) | `^12` | 12 is EOL (2022) | `npm install` / native builds fail on modern Node; `node-sass@4` in particular requires an old toolchain |
| Electron (`@chiflix/electron`) | `7.3.3` | 3+ years of security fixes missing | Chromium/V8 in Electron 7 has many known CVEs |
| Vue | `2.6.11` | Vue 2 reached EOL Dec 2023 | No security patches; ecosystem moving to Vue 3 |

**Recommendation:** stand up a reproducible build first (pin Node 12 via `nvm`
or a container), confirm green, then upgrade in isolated steps.

## Dependencies to replace / upgrade

| Package | Current | Problem | Suggested |
| ------- | ------- | ------- | --------- |
| `request` + `request-progress` | `^2.88` | Deprecated since 2020 | `node-fetch`/`fetch` (already a dep) or `undici` |
| `node-sass` | `^4.12` | Deprecated; native, breaks on new Node | `sass` (Dart Sass) |
| `@sentry/electron` | `^1.3` | Very old major | `@sentry/electron` v4+ |
| `uuid` | `^3.2` | v3 API deprecated | `uuid` v9 (named exports) |
| `mkdirp` / `rimraf` | `0.5` / `2.x` | Superseded by `fs.mkdir({recursive})` / `fs.rm` | Node built-ins |
| `vue-analytics` | `^5.16` | Unmaintained; GA Universal Analytics shut down | Remove or move to GA4 |
| `tslint` (implied by config age) | — | Deprecated in favour of ESLint | Consolidate on ESLint + `@typescript-eslint` |

Run `npm audit` against a fresh install to get the current CVE list; several of
the above pull in vulnerable transitive dependencies.

## Toolchain

- **Webpack 4 → 5** (or Vite): Webpack 4 is unmaintained and assumes Node
  polyfills that were removed in newer Node.
- **Babel/TS**: `tsconfig` targets `esnext` but `strict` is off and
  `strictNullChecks` is on only partially. Turning on `strict` incrementally
  would surface real latent bugs.
- **Tests**: Karma is deprecated. Migrating unit specs to Vitest/Jest would let
  the suite run headless in CI without a full browser.

## What this change adds, done to current standards

- `src/renderer/services/subtitle/ai/*` — new subtitle translation engine using
  `fetch` + `AbortController`, robust JSON handling, an LRU cache, look-ahead
  scheduling and exponential back-off. Fully unit-tested and framework-agnostic.
- It plugs into the existing subtitle `Type`/`Format`/loader/parser architecture
  rather than bolting on a parallel system, so it benefits from the app's cue
  rendering, delay handling and played-time tracking for free.

See `docs/ai-subtitle-translation.md` for the feature itself.
