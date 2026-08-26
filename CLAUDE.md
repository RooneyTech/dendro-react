# Dendro React — VS Code extension + MCP server for React component visualization

## Maintaining this file
Cache of current system state, not a log. Keep under 150 lines.
- Add when system shape changes (new MCP tool category, new runtime feature)
- Remove when migrations complete
- Don't add bug fixes, feature details, sprint context

## What this is
VS Code extension + MCP server for React and React Native codebase visualization. OXC-based static parser + D3 dendrogram webview + 36 MCP tools for AI-driven component analysis. Live runtime introspection via React DevTools. Marketplace: Dendro React (free — all 36 tools).

## Architecture
```
VS Code Extension (TypeScript)
├── src/server/extension.ts       — VS Code activation, file watchers, sidebar tree
├── src/core/                     — Static parsers (OXC, complexity, navigation, context,
│                                   rerender-risk, web-routing, screen-parser, hook-deps, prop-flow)
├── src/runtime/                  — React DevTools connector, live tree, state inspection
├── src/licensing/                — License file (HMAC-SHA256), feature gate (Pro/Free)
└── src/webview/                  — D3 visualization (Dendrogram.jsx), tour system, exporters

MCP Server (TypeScript, emitted to dist/mcp-server.js)
├── src/mcp/server.ts            — McpServer init, tool registration
├── src/mcp/tools.ts             — 36 free tools (analysis, visualization, runtime, workflow)
└── src/mcp/pro-tools/           — 20 advanced tool implementations (former Pro tier, now free)

D3 Visualization
├── src/webview/Dendrogram.jsx   — SVG dendrogram, annotations, highlights, flows
├── src/webview/TourPanel.jsx    — Guided tour system with step sequencing
└── Rendering: Sugiyama layout, cosmic constellation theme (tokens.js — legacy neural variable names retained for stability; may be renamed in future refactor)
```

## Key patterns
- **Static analysis:** OXC parser (40x faster than Babel) with 2-tier LRU cache
- **Parsers:** component tree, complexity (1-10 grade), navigation (React Navigation + web routing), context map, hook deps, prop flow, screen structure, rerender risk
- **Visualization:** AI controls live webview via postMessage (`visualize_highlight`, `visualize_zoom`, `visualize_annotate`, `visualize_trace_flow`, etc.)
- **Runtime:** DevTools WebSocket connector (port 8097, configurable). Live tree, state inspection, prop tracing, state modification
- **Licensing:** dormant as of v0.5.1 — all 36 tools free (`isGated()` returns false in `src/mcp/pro-gate.ts`). HMAC-SHA256 license plumbing retained in `src/licensing/` for a possible future paid tier.

## Build & Deploy
```bash
npm install
npm run compile          # TypeScript → /out
npm run build            # Webpack bundle → /dist
npm run build:prod       # Production (minified)
npm run test:all         # 861 tests across 19 suites (TICKET-057 for test debt)
vsce publish             # Publish to marketplace (requires VSCE_PAT)
```

MCP server standalone: `node dist/mcp-server.js`

## Key paths
- **Extension entry:** `src/server/extension.ts`
- **Parsers:** `src/core/*-parser.ts`
- **MCP tools:** `src/mcp/tools.ts` (free) + `src/mcp/pro-tools/*` (pro)
- **Webview:** `src/webview/Dendrogram.jsx`
- **Runtime:** `src/runtime/`

## Conventions
- Folder naming: `lowercase-hyphens`
- File naming: `camelCase` for TypeScript/JavaScript
- Feature gate: `isProFeature()` + `isProLicensed()`
- Tool descriptions include sequencing hints for agent navigation

## References
- **docs/setup-guide.md** — Setup and configuration
- **docs/tools-reference.md** — Full MCP tool reference
- **CONTRIBUTING.md** — How to contribute
