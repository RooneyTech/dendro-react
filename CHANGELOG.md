# Changelog

All notable changes to Dendro React will be documented in this file.

## [0.9.0] - 2026-08-26

The rules release. Dendro's encoded React failure modes are the part a bigger context window can't replicate — this release adds the sixth, found by mining real merged bug fixes and validating every candidate against five real codebases.

### Added

- **New rule: `effect-fetch-race`** — a `useEffect` with reactive deps that writes state from a `.then`/`await` result with no ignore flag or `AbortController`. Responses resolve out of order, the stale one writes last, and the UI shows data for the wrong input — silently. `exhaustive-deps` is *satisfied* by this shape, which is exactly why it survives review. Found 2 real, user-visible races in excalidraw and 0 false positives across 4 other codebases (597 files). Surfaces in `quick_audit` with a line number and a copy-pasteable fix.
- **`submit_feedback` gains `unansweredQuestions`** — the React questions your agent *wanted* answered but had to grep for. Absence is invisible from the maker's side; now it's reportable.

### Changed

- **One story everywhere.** New README and landing page: *your agent is editing code it's never read* — Dendro is one model of your codebase, rendered twice: semantics your agent queries, and a map you can both point at. Every distribution channel's description now derives from the same claim (npm and Smithery had drifted stale).

## [0.8.1] - 2026-08-25

The orientation release: one new tool that hands any agent the whole repo's shape in a single ~300-token call, plus a documentation truth pass.

### Added

- **`get_context_pack` (36th tool)** — whole-repo orientation as one dense, self-describing CTX-PACK/0.1 text block: directory rollups with lines-of-code and 6-month commit heat, the largest and hottest files, cross-directory import edges, and entry-point candidates. The header declares the row schema once, so any agent parses the protocol a single time and reads every later pack near-free. Degrades honestly without git (heat columns zero, noted in a comment).

### Fixed

- **Docs matched to reality** — README and `docs/tools-reference.md` still described the retired 56-tool surface (including seven tools that no longer exist); the reference is now generated from the live server's tool list (36 tools), and all counts agree everywhere.
- **The repo is public** — https://github.com/RooneyTech/dendro-react. Feedback links now point at its issues.

## [0.8.0] - 2026-08-24

The observability release, pointed outward: agents can now — with your explicit consent, and only then — send feedback to Dendro's maker. Analysis stays 100% local; this is the single opt-in exception, and it never includes code, paths, or error text.

### Added

- **`submit_feedback` (35th tool)** — an agent can send an honest debrief (what worked, what fumbled, would-it-reuse) to the Dendro feedback service. Hard consent gate: the tool refuses to send unless the user has explicitly agreed in-conversation. What's transmitted: exactly the debrief fields, plus server version, platform, and per-tool call/error *counts* (tool names only). Receiving end is a small Cloudflare Worker with size caps and rate limits, and no public read path.

### Fixed

- **Component trees no longer count non-components** — style/asset/data imports (`.scss`, `.css`, `.png`, `.svg`, `.json`) were resolving into tree nodes, and plain `.ts` utility/constants files were classified as `functional` components on the strength of any arrow function (`.ts` can't contain JSX; such files now require a `React.createElement` call). Component counts on real-world repos drop to the truth — e.g. excalidraw's tree loses its stylesheet "components". Parser cache version bumped accordingly.

## [0.7.2] - 2026-08-24

Agent-guidance patch, sourced from a 5-agent synthetic test cohort run against 5 real repos (every finding below tripped multiple fresh agents).

### Fixed

- **Stale tool text purged** — `get_usage_guide` and the workflow playbooks claimed "56 available tools" (it's 34) and referenced retired per-step viz tools (`visualize_highlight`, `visualize_zoom`, `poke_component`); all agent-facing text now describes the real `visualize_batch`-only surface.
- **`versionSkew` now explains itself** — the build-info flag ships a note saying what skew means, that analysis tools are unaffected, and how to resolve it.

### Added

- **Empty screens result gives guidance** — `get_screen_components` on a codebase with no screen concept (Next.js and other web apps) now says which heuristics were tried and points at `get_navigation_structure`/`get_component_tree`, instead of a bare "No screens found".
- **Trivial-tree warning on `open_visualizer`** — the response reports `treeNodeCount`, and a 1-2 node tree (wrapper/layout entry, e.g. a Next.js root layout) comes with a warning that visualization against missing components will silently no-op, plus a concrete next step.

## [0.7.1] - 2026-08-24

The reliability patch for agent-driven walkthroughs: the first-run crash is fixed and the webview now reports its errors instead of white-screening.

### Fixed

- **Walkthrough `removeChild` crash** — clicking Next/Back on a `visualize_batch` walkthrough (`waitForUser: true`) could kill the webview with `NotFoundError: removeChild`. Root cause: React rendered its stylesheet inside the D3-owned `<svg>`, so D3's teardown deleted a node React still tracked. The stylesheet now lives outside the SVG, D3 interrupts in-flight transitions before removal, and the D3 zoom uses an explicit extent (the `100vw/100vh` SVG made d3-zoom's default extent throw `SVGLength` errors).
- **Malformed command payloads no longer crash the webview** — handlers accept the field aliases agents actually send (`components`/`targets` for highlight's `nodes`, `component`/`node` for zoom's `target`), non-string lookups miss gracefully, and any handler exception degrades to a structured `{success:false}` command result instead of an uncaught error.
- **Walkthrough step labels wrap** instead of truncating at 400px with an ellipsis.
- **Projector toggle no longer covers the theme toggle** — the in-canvas button was absolutely positioned on top of it and has been removed; projector mode remains via the `dendro-react.projectorMode` command and setting.

### Added

- **Webview error telemetry** — webview `window.onerror`/`onunhandledrejection` now post structured errors to the extension, which records them locally in `~/.dendro/telemetry.json` and shows a dismissible in-canvas error banner (instead of wiping the page). Nothing leaves the machine.
- **Walkthrough frame-capture harness** — `e2e/tier3-webview/capture-walkthrough-frames.js` renders a real walkthrough to PNGs in headless Chromium for visual review; the e2e suite also gained a regression test that clicks Next through a `waitForUser` batch and asserts zero uncaught page errors.

## [0.7.0] - 2026-08-24

The agent-first release: the tools agents actually need, a surface small enough to pick from, and analysis that understands modern import styles.

### Added

- **`get_component_contract`** — everything needed before editing a component, in one call: props (extracted from the TypeScript type, declared members only), state, hooks, contexts read/provided, workspace-wide blast radius, per-component complexity, re-render risk count, and an explicit `notCovered` list. Resolves by component NAME across the workspace — `index.tsx` exports and kebab-case files resolve correctly.
- **`get_modified_components`** — git-diff-scoped analysis: every changed file (vs HEAD or a base ref like `main`) with the components it declares. Honest failure modes (`not_a_git_repo`, `bad_ref` — never a silent HEAD fallback).
- **tsconfig path-alias resolution everywhere** — `@/components/x` imports now produce component-tree edges, `get_used_by` matches, and contract blast radius. Previously, alias-importing files were invisible to all analysis.
- **Effect-hygiene findings in `quick_audit`** — two real-bug families, reported with stable rule ids and fixes but never graded: `effect-needs-cleanup` (subscriptions/timers/listeners created in effects with no cleanup return) and `derived-state-effect` (effects that only mirror values into state).
- **Dead-code detection in `quick_audit`** — files nothing imports (static, re-export, and string-literal dynamic imports counted; framework entry conventions, tests, stories, and config excluded), with per-file component lists and an explicit verify-before-deleting note.
- **Known-issues baseline for `quick_audit`** — `baseline: "update"` records current findings; later audits report NEW issues separately so CI can gate on regressions instead of the backlog.
- **skills.sh distribution** — `npx skills add RooneyTech/dendro-react` installs the Dendro usage-reflex skill plus the 5 persona workflow skills into any compatible agent.

### Changed

- **Tool surface consolidated: 58 → 34.** No capability was removed — chains and format-variants became parameters:
  - 8 individual `visualize_*` commands → `visualize_batch` command steps (its enum covers highlight, zoom, annotate, traceFlow, clear, expand, collapse, fitAll)
  - 5 `run_*` workflow tools → `run_workflow` with a `persona` parameter
  - 4 `export_*` tools → `export_analysis` with a `format` parameter
  - 4 Verified Projection steps → `verify_state_flows` (runs the chain; `stopAfter` to inspect intermediates)
  - `save/list/compare_snapshots` → `manage_snapshots` with an `action` parameter
  - `poke_component` folded into `modify_runtime_state`; `diff_component_state` became `inspect_live_component`'s `diffFromPrevious` flag
  - `find_component_by_name` / `find_components_by_type` retired — `get_component_contract` resolves names correctly
- MCP first-contact offers updated: skills install, slash commands, or a CLAUDE.md "dendro reflex" snippet.

## [0.6.0] - 2026-08-23

The trust release: every answer an agent gets is either right or says why it might not be.

### Added

- **Build identity** — `get_usage_guide` and `get_usage_stats` now report the running server's version, git SHA, and build time, plus the installed extension's version (with a skew flag). Detects the "recompiled but the old server is still answering" footgun.
- **Extension handshake** — the extension writes its real ID to the workspace IPC dir on activation; `vscode://` URIs are built from it instead of a hardcoded constant.
- **Expo Router support** — `get_navigation_structure` detects and parses `app/_layout.*` file-based routes (groups, dynamic `[param]` segments, catch-alls).
- **Next.js Pages Router support** — `pages/` and `src/pages/` routes parsed (previously reported zero routes).
- **Remix folder-convention routes** — `routes/blog.$slug/route.tsx` style directories are now detected.
- **Empty-result explanations** — `find_component_by_name`, `find_components_by_type`, `get_used_by`, `get_prop_flow`, `get_hook_deps`, `get_context_map`, and `detect_circular_deps` now say what an empty result means and exactly what scope was searched, instead of returning bare empty arrays.

### Changed

- **Complexity is scored per component, not per file.** Lines, hooks, JSX depth, and props are measured within each component's own declaration span — co-located components no longer inflate each other's scores, and `totalComponents` counts real components.
- **React Compiler awareness** — when `babel-plugin-react-compiler` is in the analyzed project, memoization findings (`missing-useCallback`/`missing-useMemo`/`inline-function`) are downgraded to low severity with an explanation (the compiler handles them).
- **Server-code awareness** — `"use server"` files are skipped by re-render analysis (server code never re-renders; suggesting hooks there breaks builds). `<form action={fn}>` / `formAction` handlers (React 19 idiom) are no longer flagged as inline-function risks.
- **React 19 hooks modeled** — `useActionState`, `useOptimistic`, `useTransition`, and `useReducer` tuple functions are treated as referentially stable; `useActionState`/`useOptimistic` count as state hooks in complexity.
- **`get_used_by` scans the workspace root by default** (was: only the component's sibling folder, silently) and discloses its scope and depth cap in the response.
- **Framework-correct warnings** — a Next.js/Expo project with unparseable routes is no longer told "No React Navigation navigators found"; the warning names the detected framework or lists everything that was tried.
- **Imperative-navigation honesty** — navigation results warn when `navigate()`/`router.push()`/`<Link>` usage is detected, since those edges are not modeled.
- **All fire-and-forget `visualize_*` tools** now state that success means dispatched, not rendered.
- **Tool descriptions rewritten** for the 10 most-used tools: sequencing, scope disclosure, and empty-result semantics stated up front.
- **RSC directive detection is comment-tolerant** — a license header above `"use client"` no longer hides the directive.
- `React.memo` detection requires `memo` to actually be imported from React (a `lodash.memoize` call no longer marks a file as memoized).
- Landing page and `server.json` updated to free-everything messaging; `server.json` identity corrected to `RooneyTech/dendro-react`.

## [0.5.1] - 2026-08-23

### Changed

- **All 56 tools are now free.** The Pro gate is dormant (`isGated()` returns `false`) — exports, snapshots, verified projection, live introspection, and batch analysis no longer require a license. Licensing plumbing is retained for a possible future paid tier.
- **Constellation branding** — cosmic token refresh in the visualizer (`tokens.js`), new logo, and refreshed landing-page assets.
- License clarified to MIT in `package.json` (was "SEE LICENSE IN LICENSE.md"); removed a stale proprietary header that contradicted the shipped MIT license.

### Fixed

- **Dev-build webview could render blank** — the webview webpack entry had no `devtool`, so development mode defaulted to `eval`, which the webview's nonce-based CSP silently blocks. Now pinned to `source-map`.
- Landing page (`web/`) excluded from the VSIX via `.vscodeignore` — it was about to ship ~2 MB of website assets inside the extension.

## [0.5.0] - 2026-04-13

### Added

- **IPC workspace isolation** — per-workspace IPC files now live under `~/.dendro/workspaces/{hash}/` to prevent cross-talk when multiple VS Code windows run Dendro simultaneously (TICKET-056). Global files (license, telemetry) remain shared at `~/.dendro/`.
- **Developer mode setting** — `dendro-react.devMode` (default `false`) gates debug commands like "Test URI Handler" behind an explicit opt-in.
- **Configuration reference** in README — all 6 extension settings documented with defaults and descriptions.
- **CHANGELOG comparison links** — every version links to a GitHub compare view.
- **Webpack source maps** for dev builds — improves debuggability.
- **Marketplace badges** and `ext install` command in README.

### Fixed

- **`get_live_tree` dropping children** when `includeNative=false` — child components of filtered host nodes are now re-parented to the nearest surviving ancestor instead of being silently dropped.
- **Double-encoding in `visualize_annotate` / `visualize_batch`** — removed redundant `encodeURIComponent` / `decodeURIComponent` calls that compensated for each other. `URLSearchParams` handles encoding natively.
- **Wrong return types** on `visualize_expand` / `visualize_collapse` — now declare `VisualizeExpandResult` / `VisualizeCollapseResult` instead of `VisualizeClearResult`.
- **URI handler path boundary bypass** — all URI routes that accept file paths now validate via `assertPathInWorkspace()` before opening files.
- **Incomplete deactivation** — extension `deactivate()` now clears IPC files (runtime state, visualizer status, inspect/override requests) and disposes the license manager's event emitter.
- **Test suite debt** — resolved 188 pre-existing test failures (TICKET-057). Full suite now 1124/1124 passing.

### Changed

- **Deduplicated gating logic** — `proFeatureResponse()` and `isGated()` extracted into shared `src/mcp/pro-gate.ts`. Previously duplicated between `server.ts` and `pro-registry.ts`.
- **Deduplicated `ComponentNode` interface** — canonical definition now lives in `parser-oxc.ts` and is imported by consumers.
- **Removed dead code** — `TreeObject`, `FiltersObject`, `createGatedHandler`.

## [0.4.8] - 2026-03-03 (Pre-Release)

### Changed

- **Internal ID rename** — all VS Code command IDs, view IDs, configuration keys, and activity bar IDs renamed from `dendro.*` to `dendro-react.*` for namespace consistency (TICKET-059)
- **MCP server name** — registered as `dendro-react` instead of `dendro-mcp`

## [0.4.7] - 2026-02-23 (Pre-Release)

### Added

- **5 MCP workflow tools** (51 → 56 total, 36 free / 20 Pro)
  - `run_audit` — deep technical audit with complexity hotspots, circular deps, and actionable recommendations
  - `run_sprint_check` — quick health check for engineering managers (under 200 words)
  - `run_ceo_briefing` — jargon-free architecture briefing for non-technical CEOs
  - `run_investor_scorecard` — standardized 6-category technical due diligence scorecard
  - `run_dev_onboarding` — progressive codebase walkthrough for new team members
- **`get_usage_stats`** — local telemetry tool for viewing tool usage statistics
- **MCP server instructions** — agent automatically sees workflow tools and setup offer on connect
- **Manual advance for `visualize_batch`** — new `waitForUser: true` parameter shows a floating control bar with Back/Next/Skip buttons so users control visualization pace
- **Step descriptions** — each batch visualization step shows a human-readable label (auto-derived or agent-provided via `label` field)
- **Back button** — users can navigate backward through visualization steps (replays history up to N-1)
- **Tree-to-code linking** — click any node in the D3 tree to open its source file in the editor
- **Projector mode** — toggle 1.4x scaling on all fonts, radii, and stroke widths for presentations (`Dendro: Toggle Projector Mode`)
- **Colorblind-safe palette** — replaced teal (#00ffe5) with Okabe-Ito bluish green (#009E73), validated for deuteranopia/protanopia

### Fixed

- **`visualize_batch` commands lost `waitForUser` when webview wasn't ready** — new `pendingBatches` queue preserves entire batch context (commands + waitForUser + labels) instead of falling back to individual command queue. Root cause of onboarding firing all commands without control bar.
- **Circular deps dedup merging distinct cycles** — replaced alphabetical sort with rotation-normalization to preserve cycle directionality
- **Health grade too harsh** — replaced binary category grading with density-based weighted scoring. Grades now within 1 letter of human expectation across 5 codebases.
- **Large output explosions** — `guardedResponse()` middleware compacts results >40KB (circular deps, context map, rerender risks, screen components)
- **Path boundary error messages** — removed `DENDRO_WORKSPACE_ROOT` hint from error text (security hardening)

### Changed

- **`start_tour` shelved** — removed from tool registry due to D3/React DOM conflict. Code intact for future fix (TICKET-054).
- **MCP prompts removed** — `server.prompt()` entries superseded by workflow tools (better client support)
- **Codebase consolidation** — shared `walkAST` (8 copies → 1), shared `scanComponentFiles` (5 copies → 1), `Dendrogram.jsx` split (2100 → 1447 lines)

## [0.4.6] - 2026-02-20 (Pre-Release)

### Added

- **Setup guide** — `docs/setup-guide.md` with manual setup, Cursor/Windsurf config, runtime troubleshooting
- **Tools reference** — `docs/tools-reference.md` with all 56 MCP tools documented

### Changed

- **Setup instructions** — MCP config now uses absolute node path (`which node`) to fix connection failures in Claude Code subprocesses
- **"Say Dendro" tip** — README and setup guide now encourage using the keyword "Dendro" in prompts for better tool activation
- **README refreshed** — beginner-friendly flow (Install → Paste one prompt → Things to Try), example prompts updated
- **Extension icon** — upgraded from 128x128 to 256x256

## [0.4.3] - 2026-02-19 (Pre-Release)

### Changed

- Published as pre-release on VS Code marketplace for early feedback
- Repo moved to [github.com/RooneyTech/dendro-react](https://github.com/RooneyTech/dendro-react)
- Package renamed from `dendro-mcp` to `dendro-react`
- Publisher updated to `RooneyTech`

> **Early access — feedback welcome!** This is a pre-release and things are moving fast. If you run into issues, have ideas, or just want to share what's working (or not), reach out:
> - [GitHub Issues](https://github.com/RooneyTech/dendro-feedback/issues)
> - Email: colin@rooneytech.com

## [0.4.2] - 2026-02-18

### Added

- **7 new MCP tools** (44 → 51 total, 30 free / 21 Pro)
  - `analyze_codebase` — full codebase analysis in one call (tree + complexity + context + circular deps)
  - `quick_audit` — health check with A-F grade, top 5 complex components, prop drilling candidates
  - `visualize_analysis` — open visualizer + auto-highlight by focus area (complexity, deps, context, performance)
  - `visualize_fit_all` — zoom viewport to fit entire component tree
  - `visualize_batch` — execute multiple viz commands in sequence with proper timing (up to 15 per batch)
  - `start_tour` — interactive guided tour through the visualization with auto-play support
  - `get_rerender_risks` — detect 5 re-render anti-patterns (inline objects/arrays/functions, missing useCallback/useMemo)
- **Web routing parsers** — `get_navigation_structure` now auto-detects Next.js App Router, React Router v6/v7, and Remix v2 (in addition to React Navigation)
- **Persona-guided exports** — `export_markdown` accepts `persona` parameter for audience-specific reports (developer, ceo, investor, eng-manager, onboarding)
- **5 MCP prompts** — `ceo-overview`, `dev-onboarding`, `complexity-audit`, `investor-scorecard`, `eng-manager-check`
- **Internal command queue** — all visualization commands processed serially with type-aware delays, eliminating D3 transition races

### Fixed

- Highlight label text no longer clips behind child nodes (moved to separate top-level SVG layer with background pills)
- `visualize_annotate` callouts now render reliably (explicit inline styles instead of CSS class selectors)
- `visualize_highlight` no longer silently reports success for missing nodes (returns `requestedCount` with diagnostic note)

## [0.4.0] - 2026-02-17

### Added

- **Usage guide tool** — `get_usage_guide` returns workflow recipes and tool sequencing tips for new users
- **44 MCP tools** (up from 42) with improved descriptions for AI agent discoverability

### Improved

- **Accessibility**: full `prefers-reduced-motion` support across all animations (dendrogram, loader, flows, live badge)
- **Idle animation reduction**: only soma breathing retained; nucleus, membrane, and neurotransmitter animations removed. All idle animations disabled on trees with 50+ nodes
- **Flow pattern differentiation**: solid (prop), dashed (context), dotted (hook-state) line styles. Dotted flows use 2s animation to prevent strobe
- **Component type icons**: pill-shaped indicators — f() Functional, ◆ Class, ▣ Native, ○ Other — at 11px for visual clarity
- **Text truncation**: increased from 12 to 16 characters in neural mode for better readability
- **Live badge**: animation moved to CSS class (included in reduced-motion kill list)
- **Test suite**: 910/924 tests passing (98.5%) across 14 suites. Added unified test runner (`npm run test:all`)
- **Product naming**: displayName → "Dendro React" for marketplace clarity
- **open_visualizer**: now blocks until webview is ready before returning
- **Security**: license key input uses masked field; ADB commands use `execFile` with args array instead of shell interpolation

### Fixed

- Keyboard shortcut changed from `Cmd+Option+D` to `Shift+Alt+D` to avoid macOS Dock toggle conflict
- DevToolsConnector: max restart attempts capped at 5 with error message deduplication
- Dendrogram: header offset (120px) prevents root node from hiding behind fixed AppHeader
- Mocha test suite: corrected to `ui: 'tdd'` (suite/test, not describe/it)

## [0.3.0] - 2026-02-16

### Added

- **Neural visual identity** — neuroscience-inspired node rendering with membrane, soma, nucleus, and nucleolus layers
- **Synaptic gap**: 12px gap between connected nodes with axon terminal bulb and neurotransmitter particle animations
- **Neurogenesis animation**: bloom effect on component mount (scale 0→1.08→1, staggered by tree position)
- **Apoptosis animation**: dissolve effect on component unmount (scale + blur + opacity transition)
- **Calcium wave**: radial propagation animation for context flow — consumer nodes flash as wave reaches them
- **Myelination**: segmented stroke overlay on connections to `React.memo` components with bright inner core
- **Memo detection**: parser identifies `React.memo()` / `memo()` wrapping → `memoized: boolean` on tree nodes
- **Custom component icons**: functional, class, and memo icon pairs for light/dark themes in sidebar
- **Custom fonts**: Space Grotesk (brand/UI text) and JetBrains Mono (component names) bundled as woff2 subsets
- **Marketplace icon**: bioluminescent logo on dark background

### Improved

- **Design token system**: `src/webview/tokens.js` — single source of truth for all colors, themes, gradients, and CSS variables
- **Responsive layout**: ResizeObserver-driven — compact mode (<400px), minimal mode (<300px) with scaled nodes and text
- **Keyboard navigation**: arrow keys for tree traversal, Enter to open source, focus ring with cyan glow
- **Light mode**: dedicated contrast-adjusted colors (cyanDark #007a99, greenDark #008570)
- **VS Code theme integration**: real-time dark/light detection and switching
- **Webpack bundling**: 3 entries — extension (447 KB), webview (2.67 MB), MCP server (14.7 MB). VSIX reduced to 1.87 MB, 25 files

## [0.2.0] - 2026-02-15

### Added

- **42 MCP tools** for AI-assisted React architecture analysis
  - 12 analysis tools (component tree, prop flow, hook deps, complexity, context map, navigation, circular deps, and more)
  - 7 visualization tools (highlight, zoom, annotate, trace flow, expand/collapse)
  - 3 runtime tools (live tree, runtime state, connection status)
  - 4 export tools (Mermaid, JSON, SVG, Markdown) — Pro
  - 4 pro analysis tools (batch analysis, snapshots, snapshot comparison) — Pro
  - 4 verified projection tools (hypothesis generation, test generation, test execution, tree annotation) — Pro
  - 1 triggered projection tool (runtime diff, downstream effect prediction, webview animation) — Pro
  - 7 live introspection tools (inspect, diff, find state owner, modify state, poke, trace prop, navigation state) — Pro
- **AI-controlled webview** — AI assistants can highlight, annotate, and trace flows in the visual canvas
- **React Native / Expo support** — full parsing and analysis for RN projects, including physical devices and emulators
- **OXC parser** — 40x faster than Babel for component tree analysis
- **Sidebar component tree** — always-visible tree view in the activity bar
- **CodeLens** — "Used by X components" inline indicators
- **Runtime connection** — connect to running React/RN apps via React DevTools protocol
  - Click-to-inspect — select components in sidebar to see props, state, and hooks
  - Source mapper — maps runtime component names back to source files
  - Cross-process bridge — runtime data shared between extension and MCP server via `~/.dendro/`
  - Android emulator support with automatic ADB reverse tunneling
  - Physical device support via configurable runtime host
  - Connection resilience with heartbeat monitoring and exponential backoff restart
- **Webview runtime mode** — live D3 tree visualization of running app with LIVE/WAITING/OFFLINE status
- **Verified Projection (Paradigm 2)** — generate testable state flow hypotheses from static analysis, auto-generate Jest tests, run them, and annotate the component tree with pass/fail results
- **Triggered Projection (Paradigm 3)** — diff runtime tree snapshots, project downstream effects via context/prop/hook analysis, animate projections in the webview
- **Live Introspection (Paradigm 4)** — deep inspect running components, diff state over time, find state owners, modify runtime state, trace live prop changes, view navigation screen status
- **Licensing infrastructure** — Pro tier with Lemon Squeezy integration, cross-process license bridge
- **URI handler** — trigger visualization from terminal or external tools
- **Component complexity scoring** — 1-10 scale with breakdown by category
- **Context provider mapping** — trace Context providers to all consumers
- **Navigation structure analysis** — map React Navigation hierarchy

### Improved

- 2-tier LRU cache with file watcher for fast repeated analysis
- Webpack bundling for smaller extension size (~150KB)

## [0.1.0] - 2025-10-15

### Added

- Component tree visualization (interactive dendrogram)
- Basic MCP tools (get_component_tree, get_component_details, find_component_by_name)
- D3.js-powered visualization
- TypeScript and JavaScript component detection

[0.9.0]: https://github.com/RooneyTech/dendro-react/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/RooneyTech/dendro-react/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/RooneyTech/dendro-react/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/RooneyTech/dendro-react/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/RooneyTech/dendro-react/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/RooneyTech/dendro-react/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/RooneyTech/dendro-react/compare/v0.5.1...v0.6.0
[0.5.0]: https://github.com/RooneyTech/dendro-react/compare/v0.4.8...v0.5.0
[0.4.8]: https://github.com/RooneyTech/dendro-react/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/RooneyTech/dendro-react/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/RooneyTech/dendro-react/compare/v0.4.3...v0.4.6
[0.4.3]: https://github.com/RooneyTech/dendro-react/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/RooneyTech/dendro-react/compare/v0.4.0...v0.4.2
[0.4.0]: https://github.com/RooneyTech/dendro-react/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/RooneyTech/dendro-react/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/RooneyTech/dendro-react/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/RooneyTech/dendro-react/releases/tag/v0.1.0
